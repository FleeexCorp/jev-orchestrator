import * as p from "@clack/prompts";
import type { Command } from "commander";
import pc from "picocolors";
import { CODEX_LOGIN_COMMAND, codexAuthStatus, codexLoginWithApiKey } from "../codex/auth.js";
import { CODEX_INSTALL_NPM, codexInstallHint } from "../codex/detect.js";
import { codexStatus } from "../codex/status.js";
import { ENV, userConfigFile } from "../config/paths.js";
import { defaultConfig } from "../config/schema.js";
import { engineForKey } from "../jev/engine.js";
import { JevError } from "../jev/types.js";
import { maskSecret, resolveApiKey, TYPESAFE_API_KEY_SECRET } from "../security/secrets.js";
import type { InstallScope } from "../skill/installer.js";
import { tryExec } from "../util/exec.js";
import { fileExists, writeJson } from "../util/fs.js";
import { type CliContext, loadContext, TYPESAFE_SIGNUP_URL } from "./context.js";
import { EXIT } from "./exit-codes.js";
import { INSTALL_SCOPES, parseScope, performInstall } from "./install.js";

const MIN_KEY_LENGTH = 8;
const CLAUDE_BINARY = "claude";
const NPM_BINARY = "npm";
const MANUAL_INVOCATION = "/jev-orchestrator";

interface SetupOptions {
  scope?: string;
  yes?: boolean;
  skipCodex?: boolean;
  skipJev?: boolean;
}

class Cancelled extends Error {}

function guard<T>(value: T | symbol): Exclude<T, symbol> {
  if (p.isCancel(value)) {
    throw new Cancelled();
  }
  return value as Exclude<T, symbol>;
}

const validateKeyShape = (v: string | undefined) =>
  v && v.trim().length >= MIN_KEY_LENGTH ? undefined : "Key looks too short";

async function chooseScope(opts: SetupOptions, ctx: CliContext): Promise<InstallScope> {
  const preset = parseScope(opts.scope);
  if (preset) {
    return preset;
  }
  if (opts.yes) {
    return "global";
  }
  p.log.step("Installation");
  const options: { value: InstallScope; label: string; hint: string }[] = [
    { value: "global", label: "Global", hint: "available in every Claude Code project" },
  ];
  if (ctx.projectRoot) {
    options.push({ value: "project", label: "Project", hint: `only in ${ctx.projectRoot}` });
  }
  return guard(
    await p.select<InstallScope>({
      message: "Where should Jev Orchestrator be installed?",
      options,
    }),
  );
}

async function validateKey(ctx: CliContext, apiKey: string): Promise<string | undefined> {
  try {
    await engineForKey(ctx.config, apiKey).listModels();
    return undefined;
  } catch (err) {
    return err instanceof JevError ? `${err.kind}: ${err.message}` : (err as Error).message;
  }
}

async function setupJev(ctx: CliContext, opts: SetupOptions): Promise<boolean> {
  p.log.step("Jev");
  const existing = await resolveApiKey(ctx.store, ctx.env);
  if (existing) {
    const s = p.spinner();
    const source = existing.source === "env" ? ENV.typesafeApiKey : "secret store";
    s.start(`Validating key from ${source} (${maskSecret(existing.value)})`);
    const problem = await validateKey(ctx, existing.value);
    if (!problem) {
      s.stop("TypeSafe API endpoint reachable, key valid");
      return true;
    }
    s.stop(pc.yellow(`Existing key rejected: ${problem}`));
  }
  if (opts.yes || opts.skipJev) {
    p.log.warn(`No valid key. Set ${ENV.typesafeApiKey} later or re-run setup.`);
    return false;
  }

  p.log.info(`Get a key at ${TYPESAFE_SIGNUP_URL}. It is only sent to api.typesafe.ai.`);
  for (;;) {
    const key = guard(
      await p.password({ message: `Enter your ${ENV.typesafeApiKey}`, validate: validateKeyShape }),
    ).trim();
    const s = p.spinner();
    s.start("Validating key");
    const problem = await validateKey(ctx, key);
    if (problem) {
      s.stop(pc.red(`Rejected: ${problem}`));
      const again = guard(await p.confirm({ message: "Try another key?", initialValue: true }));
      if (!again) {
        return false;
      }
      continue;
    }
    s.stop("Key valid");

    const storage = guard(
      await p.select<"store" | "env">({
        message: "How should the key be kept?",
        options: [
          {
            value: "store",
            label: "Store securely for jev-orchestrator",
            hint: `${ctx.store.describe()} (mode 0600)`,
          },
          {
            value: "env",
            label: "Use environment variable only",
            hint: `export ${ENV.typesafeApiKey}=... yourself`,
          },
        ],
      }),
    );
    if (storage === "store") {
      await ctx.store.set(TYPESAFE_API_KEY_SECRET, key);
      p.log.success(`Stored in ${ctx.store.describe()}`);
    } else {
      p.log.info(`Remember to export ${ENV.typesafeApiKey} in the shell that runs Claude Code.`);
    }
    return true;
  }
}

async function setupCodex(opts: SetupOptions): Promise<void> {
  p.log.step("Codex");
  if (opts.skipCodex) {
    p.log.info("Skipped.");
    return;
  }
  let status = await codexStatus();
  if (!status.detection.installed) {
    p.log.warn("Codex CLI not detected (optional).");
    if (opts.yes) {
      p.log.info(codexInstallHint());
      return;
    }
    const install = guard(
      await p.confirm({
        message: `Install it now with "${CODEX_INSTALL_NPM}"?`,
        initialValue: false,
      }),
    );
    if (!install) {
      p.log.info(codexInstallHint());
      return;
    }
    const s = p.spinner();
    s.start(`Running ${CODEX_INSTALL_NPM}`);
    const ok = (await tryExec(NPM_BINARY, CODEX_INSTALL_NPM.split(" ").slice(1))) !== undefined;
    s.stop(ok ? "Codex installed" : pc.red("Install failed; install it manually."));
    if (!ok) {
      return;
    }
    status = await codexStatus();
  }
  const version = status.detection.version;
  p.log.success(`Codex CLI detected${version ? ` (${version})` : ""}`);

  if (status.auth?.authenticated) {
    p.log.success(status.auth.detail);
    return;
  }
  p.log.warn("Codex is installed but not authenticated.");
  if (opts.yes) {
    p.log.info(`Run: ${CODEX_LOGIN_COMMAND}`);
    return;
  }
  const method = guard(
    await p.select<"chatgpt" | "api_key" | "skip">({
      message: "How do you want to authenticate Codex?",
      options: [
        {
          value: "chatgpt",
          label: "Sign in with ChatGPT",
          hint: `runs "${CODEX_LOGIN_COMMAND}" in your browser`,
        },
        {
          value: "api_key",
          label: "Use API key",
          hint: "passed to Codex over stdin, never stored here",
        },
        { value: "skip", label: "Skip Codex setup" },
      ],
    }),
  );
  if (method === "skip") {
    return;
  }
  if (method === "chatgpt") {
    p.log.info(`Run this in another terminal, then continue:\n\n  ${CODEX_LOGIN_COMMAND}\n`);
    guard(await p.confirm({ message: "Done signing in?", initialValue: true }));
    const after = await codexAuthStatus();
    if (after.authenticated) {
      p.log.success(after.detail);
    } else {
      p.log.warn("Still not authenticated. Codex workers stay unavailable until you sign in.");
    }
    return;
  }
  const key = guard(
    await p.password({
      message: "OpenAI API key (handed to `codex login --with-api-key` via stdin)",
      validate: validateKeyShape,
    }),
  ).trim();
  if (await codexLoginWithApiKey(key)) {
    p.log.success("Codex authenticated with API key");
  } else {
    p.log.warn("codex login --with-api-key failed; run it manually.");
  }
}

async function ensureUserConfig(ctx: CliContext): Promise<string> {
  const file = userConfigFile(ctx.env);
  if (await fileExists(file)) {
    p.log.success(`Using ${file}`);
    return file;
  }
  await writeJson(file, defaultConfig());
  p.log.success(`Created ${file}`);
  return file;
}

export async function runSetup(opts: SetupOptions): Promise<number> {
  const ctx = await loadContext();
  p.intro(pc.bold("Jev Orchestrator"));

  const claude = await tryExec(CLAUDE_BINARY, ["--version"]);
  if (claude) {
    p.log.success(`Claude Code detected (${claude.split("\n")[0]})`);
  } else {
    p.log.warn("Claude Code CLI not on PATH; the skill installs anyway.");
  }
  p.log.success(`Node.js ${process.versions.node}`);

  try {
    const scope = await chooseScope(opts, ctx);
    if (scope === "project" && !ctx.projectRoot) {
      p.log.error("Project scope needs a git repository. Run setup inside one or choose Global.");
      return EXIT.usage;
    }

    const jevReady = await setupJev(ctx, opts);
    await setupCodex(opts);

    p.log.step("Claude Skill");
    const result = await performInstall(scope, ctx.projectRoot, ctx.env);
    p.log.success(`${result.updated ? "Updated" : "Installed"} ${result.skillDir}`);
    if (scope === "project") {
      p.log.info(
        "Commit .claude/skills/jev-orchestrator so your team gets it. It contains no secrets.",
      );
    }

    p.log.step("Configuration");
    await ensureUserConfig(ctx);

    p.note(
      [
        "Start Claude Code normally:",
        "",
        "  claude",
        "",
        "Claude can now invoke Jev Orchestrator automatically when useful.",
        "",
        `Manual invocation:  ${MANUAL_INVOCATION}`,
        jevReady
          ? ""
          : `\nJev is not configured yet: export ${ENV.typesafeApiKey} or re-run setup.`,
      ]
        .join("\n")
        .trim(),
      "Ready.",
    );
    p.outro("Run `jev-orchestrator doctor` any time to re-check.");
    return EXIT.ok;
  } catch (err) {
    if (err instanceof Cancelled) {
      p.cancel("Setup cancelled.");
      return EXIT.usage;
    }
    p.log.error((err as Error).message);
    return EXIT.error;
  }
}

export function registerSetup(program: Command): void {
  program
    .command("setup")
    .description("Interactive setup: skill install, TypeSafe key, Codex auth")
    .option("--scope <scope>", `skip the prompt: ${INSTALL_SCOPES.join(" | ")}`)
    .option("--yes", "non-interactive; global scope, no prompts")
    .option("--skip-codex", "do not check or configure Codex")
    .option("--skip-jev", "do not prompt for a TypeSafe key")
    .action(async (opts: SetupOptions) => {
      process.exitCode = await runSetup(opts);
    });
}
