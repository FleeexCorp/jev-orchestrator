import type { Command } from "commander";
import { codexStatus, codexStatusLines } from "../codex/status.js";
import { ENV, userConfigFile } from "../config/paths.js";
import { gitVersion } from "../git/repo.js";
import { worktreesSupported } from "../git/worktrees.js";
import { engineForKey } from "../jev/engine.js";
import { JevError, noul } from "../jev/types.js";
import { maskSecret, resolveApiKey } from "../security/secrets.js";
import { detectInstallations } from "../skill/installer.js";
import { tryExec } from "../util/exec.js";
import { fileExists } from "../util/fs.js";
import { packageInfo } from "../util/pkg.js";
import { type CliContext, loadContext, TYPESAFE_SIGNUP_URL } from "./context.js";
import { EXIT } from "./exit-codes.js";
import { modeFrom, Reporter } from "./output.js";

const MIN_NODE_MAJOR = 20;
const DOCTOR_ROUNDTRIP_STATE = "The build passed and every test is green.";
const CLAUDE_BINARY = "claude";

export type CheckLevel = "ok" | "warn" | "fail";

export interface Check {
  section: string;
  label: string;
  level: CheckLevel;
  fix?: string;
}

export interface DoctorReport {
  checks: Check[];
  status: "ready" | "degraded" | "not_ready";
}

function nodeCheck(): Check {
  const major = Number(process.versions.node.split(".")[0]);
  if (major >= MIN_NODE_MAJOR) {
    return { section: "Environment", label: `Node.js ${process.versions.node}`, level: "ok" };
  }
  return {
    section: "Environment",
    label: `Node.js ${process.versions.node} is too old`,
    level: "fail",
    fix: `Install Node.js >= ${MIN_NODE_MAJOR}.`,
  };
}

async function environmentChecks(): Promise<Check[]> {
  const [gitV, claude] = await Promise.all([gitVersion(), tryExec(CLAUDE_BINARY, ["--version"])]);
  return [
    nodeCheck(),
    gitV
      ? { section: "Environment", label: `Git ${gitV}`, level: "ok" }
      : { section: "Environment", label: "Git not found", level: "fail", fix: "Install git." },
    claude
      ? { section: "Environment", label: `Claude Code ${claude.split("\n")[0]}`, level: "ok" }
      : {
          section: "Environment",
          label: "Claude Code CLI not found on PATH",
          level: "warn",
          fix: "The skill still installs; Claude Code discovers it from ~/.claude/skills or .claude/skills.",
        },
  ];
}

async function skillChecks(ctx: CliContext): Promise<Check[]> {
  const installs = await detectInstallations(ctx.projectRoot, ctx.env);
  if (installs.length === 0) {
    return [
      {
        section: "Skill",
        label: "Skill not installed",
        level: "fail",
        fix: "Run: jev-orchestrator setup   (or: jev-orchestrator install --scope global)",
      },
    ];
  }
  const checks: Check[] = [];
  for (const inst of installs) {
    const reinstall = `Run: jev-orchestrator install --scope ${inst.scope}`;
    checks.push({
      section: "Skill",
      label: `Installed (${inst.scope}) ${inst.skillDir}`,
      level: "ok",
    });
    if (!inst.manifest) {
      checks.push({
        section: "Skill",
        label: `${inst.scope}: no manifest; not managed by jev-orchestrator`,
        level: "warn",
        fix: `${reinstall} to take it over.`,
      });
    } else if (inst.manifest.version !== packageInfo().version) {
      checks.push({
        section: "Skill",
        label: `${inst.scope}: skill v${inst.manifest.version}, CLI v${packageInfo().version}`,
        level: "warn",
        fix: reinstall,
      });
    }
    checks.push(
      inst.helperPresent
        ? { section: "Skill", label: `${inst.scope}: helper executable found`, level: "ok" }
        : {
            section: "Skill",
            label: `${inst.scope}: helper script missing`,
            level: "fail",
            fix: reinstall,
          },
    );
    if (inst.manifest && !(await fileExists(inst.manifest.cliEntry))) {
      checks.push({
        section: "Skill",
        label: `${inst.scope}: helper points to a missing CLI (${inst.manifest.cliEntry})`,
        level: "fail",
        fix: reinstall,
      });
    }
  }
  checks.push({
    section: "Skill",
    label: "Claude auto-invocation enabled (no disable-model-invocation)",
    level: "ok",
  });
  return checks;
}

async function typesafeChecks(ctx: CliContext): Promise<Check[]> {
  const key = await resolveApiKey(ctx.store, ctx.env);
  if (!key) {
    return [
      {
        section: "TypeSafe",
        label: `${ENV.typesafeApiKey} not set and no stored key`,
        level: "fail",
        fix: `Run: jev-orchestrator setup   or export ${ENV.typesafeApiKey}=...  (${TYPESAFE_SIGNUP_URL})`,
      },
    ];
  }
  const where = key.source === "env" ? "environment" : ctx.store.describe();
  const checks: Check[] = [
    {
      section: "TypeSafe",
      label: `API key available (${where}, ${maskSecret(key.value)})`,
      level: "ok",
    },
  ];
  const engine = engineForKey(ctx.config, key.value);
  const [models, roundtrip] = await Promise.all([
    engine.listModels().then(
      (m) => ({ ok: true as const, models: m }),
      (err: unknown) => ({ ok: false as const, err }),
    ),
    engine
      .decide({
        id: "doctor",
        state: DOCTOR_ROUNDTRIP_STATE,
        questions: { positive: noul("Does this report a successful outcome?") },
      })
      .then(
        (r) => ({ ok: true as const, result: r }),
        (err: unknown) => ({ ok: false as const, err }),
      ),
  ]);
  if (!models.ok) {
    checks.push(jevFailure(models.err));
    return checks;
  }
  checks.push({ section: "TypeSafe", label: "Jev API reachable", level: "ok" });
  checks.push(
    models.models.includes(ctx.config.jev.model)
      ? { section: "TypeSafe", label: `${ctx.config.jev.model} available`, level: "ok" }
      : {
          section: "TypeSafe",
          label: `${ctx.config.jev.model} not in model list (${models.models.join(", ")})`,
          level: "warn",
          fix: "Versioned IDs are accepted even when unlisted; otherwise set jev.model in config.",
        },
  );
  if (!roundtrip.ok) {
    checks.push(jevFailure(roundtrip.err));
    return checks;
  }
  checks.push({
    section: "TypeSafe",
    label: `Decision roundtrip successful (${roundtrip.result.latencyMs}ms, ${roundtrip.result.model})`,
    level: "ok",
  });
  return checks;
}

function jevFailure(err: unknown): Check {
  if (err instanceof JevError) {
    const fix =
      err.kind === "auth"
        ? `Check ${ENV.typesafeApiKey} or run: jev-orchestrator setup`
        : err.kind === "rate_limit"
          ? "Rate limited; retry shortly."
          : "Check network access to https://api.typesafe.ai";
    return { section: "TypeSafe", label: `Jev ${err.kind}: ${err.message}`, level: "fail", fix };
  }
  return { section: "TypeSafe", label: `Jev error: ${(err as Error).message}`, level: "fail" };
}

async function codexChecks(ctx: CliContext): Promise<Check[]> {
  if (!ctx.config.codex.enabled) {
    return [{ section: "Codex", label: "Codex disabled in config", level: "warn" }];
  }
  // Codex is optional, so a missing or unauthenticated CLI is a warning here.
  return codexStatusLines(await codexStatus(), "warn").map((l) => ({
    section: "Codex",
    label: l.label,
    level: l.level,
    ...(l.fix ? { fix: l.fix } : {}),
  }));
}

async function repositoryChecks(ctx: CliContext): Promise<Check[]> {
  if (!ctx.projectRoot) {
    return [
      {
        section: "Repository",
        label: "Not inside a git repository",
        level: "warn",
        fix: "Worktree isolation needs git; decisions still work.",
      },
    ];
  }
  const checks: Check[] = [
    { section: "Repository", label: `Git repository ${ctx.projectRoot}`, level: "ok" },
  ];
  checks.push(
    (await worktreesSupported(ctx.projectRoot))
      ? { section: "Repository", label: "Worktrees supported", level: "ok" }
      : {
          section: "Repository",
          label: "git worktree unavailable",
          level: "warn",
          fix: "Upgrade git to 2.5 or newer.",
        },
  );
  if (ctx.configSources.project) {
    checks.push({
      section: "Repository",
      label: `Project config ${ctx.configSources.project}`,
      level: "ok",
    });
  }
  return checks;
}

export async function runDoctor(ctx: CliContext): Promise<DoctorReport> {
  const groups = await Promise.all([
    environmentChecks(),
    skillChecks(ctx),
    typesafeChecks(ctx),
    codexChecks(ctx),
    repositoryChecks(ctx),
  ]);
  const checks = groups.flat();
  checks.push({
    section: "Configuration",
    label: ctx.configSources.user
      ? `User config ${ctx.configSources.user}`
      : `No user config (defaults); ${userConfigFile(ctx.env)}`,
    level: "ok",
  });

  const fails = checks.filter((c) => c.level === "fail").length;
  const warns = checks.filter((c) => c.level === "warn").length;
  const status = fails > 0 ? "not_ready" : warns > 0 ? "degraded" : "ready";
  return { checks, status };
}

export function printDoctor(reporter: Reporter, report: DoctorReport): void {
  reporter.title("Jev Orchestrator Doctor");
  let section = "";
  for (const c of report.checks) {
    if (c.section !== section) {
      section = c.section;
      reporter.section(section);
    }
    if (c.level === "ok") {
      reporter.ok(c.label);
    } else if (c.level === "warn") {
      reporter.warn(c.label, c.fix);
    } else {
      reporter.fail(c.label, c.fix);
    }
  }
  reporter.line();
  reporter.line(`Status: ${report.status.replace("_", " ")}`);
}

export function registerDoctor(program: Command): void {
  program
    .command("doctor")
    .description("Check environment, skill, TypeSafe, Codex and repository")
    .option("--json", "machine-readable output")
    .action(async (opts: { json?: boolean }) => {
      const reporter = new Reporter({ mode: modeFrom(opts) });
      const ctx = await loadContext();
      const report = await runDoctor(ctx);
      if (reporter.json) {
        reporter.emitJson(report);
      } else {
        printDoctor(reporter, report);
      }
      process.exitCode = report.status === "not_ready" ? EXIT.error : EXIT.ok;
    });
}
