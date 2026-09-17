import { type LoadedConfig, loadConfig } from "../config/loader.js";
import { ENV } from "../config/paths.js";
import type { Config } from "../config/schema.js";
import { repoRoot } from "../git/repo.js";
import type { TypeSafeDecisionEngine } from "../jev/client.js";
import { createEngine } from "../jev/engine.js";
import { FileSecretStore, type SecretStore } from "../security/secrets.js";

export interface CliContext {
  cwd: string;
  /** Main working tree root when inside a git repository. */
  projectRoot: string | undefined;
  config: Config;
  configSources: LoadedConfig["sources"];
  store: SecretStore;
  env: NodeJS.ProcessEnv;
}

export async function loadContext(
  cwd = process.cwd(),
  env: NodeJS.ProcessEnv = process.env,
): Promise<CliContext> {
  const projectRoot = await repoRoot(cwd);
  const loaded = await loadConfig({ env, ...(projectRoot ? { projectRoot } : {}) });
  return {
    cwd,
    projectRoot,
    config: loaded.config,
    configSources: loaded.sources,
    store: FileSecretStore.forEnv(env),
    env,
  };
}

export async function engineFor(ctx: CliContext): Promise<TypeSafeDecisionEngine | undefined> {
  return createEngine(ctx.config, ctx.store, ctx.env);
}

export const TYPESAFE_SIGNUP_URL = "https://typesafe.ai";

export const NO_KEY_HINT = [
  "No TypeSafe API key found.",
  `Set ${ENV.typesafeApiKey} in your environment or run: jev-orchestrator setup`,
  `Get a key at ${TYPESAFE_SIGNUP_URL}`,
].join("\n");
