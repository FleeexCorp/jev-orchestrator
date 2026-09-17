/**
 * Public API of jev-orchestrator. The CLI is the primary interface; these
 * exports let other tools reuse the decision engine, orchestration decisions,
 * worker adapters and worktree management.
 */

export { type CodexAuthStatus, codexAuthStatus } from "./codex/auth.js";
export { type CodexDetection, detectCodex } from "./codex/detect.js";
export { type ParsedCodexRun, parseCodexJsonl } from "./codex/parser.js";
export { buildPrompt, CodexWorkerAdapter, type CodexWorkerOptions } from "./codex/worker.js";
export { ConfigError, type LoadedConfig, loadConfig } from "./config/loader.js";
export * as paths from "./config/paths.js";
export { type Config, configSchema, defaultConfig } from "./config/schema.js";
export { type CleanupReport, type ManagedWorktree, WorktreeManager } from "./git/worktrees.js";
export { TypeSafeDecisionEngine, type TypeSafeEngineOptions } from "./jev/client.js";
export { createEngine, engineForKey } from "./jev/engine.js";
export { MockDecisionEngine, type MockScript } from "./jev/mock.js";
export * from "./jev/types.js";
export * from "./orchestration/index.js";
export {
  FileSecretStore,
  maskSecret,
  redact,
  resolveApiKey,
  type SecretStore,
  TYPESAFE_API_KEY_SECRET,
} from "./security/secrets.js";
export {
  detectInstallations,
  helperScript,
  type InstallResult,
  type InstallScope,
  installSkill,
  uninstallSkill,
} from "./skill/installer.js";
export type { WorkerAdapter, WorkerEvent, WorkerRequest, WorkerResult } from "./workers/adapter.js";
