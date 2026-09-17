import { z } from "zod";

export const CONFIG_VERSION = 1;
export const DEFAULT_JEV_MODEL = "jev-latest";
export const DEFAULT_JEV_TIMEOUT_MS = 5_000;
export const DEFAULT_AUTONOMOUS_THRESHOLD = 0.85;
export const DEFAULT_FALLBACK_THRESHOLD = 0.6;
export const DEFAULT_MAX_PARALLEL_WORKERS = 3;
export const DEFAULT_WORKER_TIMEOUT_MS = 30 * 60 * 1_000;
export const DEFAULT_WORKTREE_DIR = ".jev/worktrees";

const probability = z.number().min(0).max(1);

export const jevConfigSchema = z
  .object({
    model: z.string().min(1).default(DEFAULT_JEV_MODEL),
    timeoutMs: z.number().int().positive().default(DEFAULT_JEV_TIMEOUT_MS),
    /** Override the API root, mainly for tests and proxies. */
    baseUrl: z.string().url().optional(),
  })
  .strict();

export const decisionsConfigSchema = z
  .object({
    autonomousThreshold: probability.default(DEFAULT_AUTONOMOUS_THRESHOLD),
    fallbackThreshold: probability.default(DEFAULT_FALLBACK_THRESHOLD),
    /**
     * Tasks marked `irreversible` in the state always stay with Claude and are
     * always reviewed, regardless of confidence. Not configurable: only `true`.
     */
    destructiveActionRequiresClaude: z.literal(true).default(true),
  })
  .strict()
  .refine((d) => d.fallbackThreshold <= d.autonomousThreshold, {
    message: "decisions.fallbackThreshold must be <= decisions.autonomousThreshold",
  });

export const codexConfigSchema = z
  .object({
    enabled: z.boolean().default(true),
    maxParallelWorkers: z.number().int().min(1).max(16).default(DEFAULT_MAX_PARALLEL_WORKERS),
    /** Model passed to `codex exec -m`; omitted uses the Codex default. */
    model: z.string().min(1).optional(),
    workerTimeoutMs: z.number().int().positive().default(DEFAULT_WORKER_TIMEOUT_MS),
  })
  .strict();

const workerTier = z.enum(["fast", "balanced", "strong"]);
const reasoningEffort = z.enum(["low", "medium", "high", "xhigh", "max"]);

export const workerCandidateConfigSchema = z
  .object({
    /** Choice option id, e.g. `codex:gpt-5.6-sol` or `claude:opus`. */
    id: z.string().min(1),
    adapter: z.enum(["codex", "claude_subagent"]),
    model: z.string().min(1),
    description: z.string().min(1).optional(),
    tier: workerTier.optional(),
    reasoningEffort: reasoningEffort.optional(),
    /** `false` removes a discovered candidate with this id. */
    enabled: z.boolean().optional(),
  })
  .strict();

export const workersConfigSchema = z
  .object({
    /** Add Codex models found in `$CODEX_HOME/models_cache.json`. */
    includeCodexModels: z.boolean().default(true),
    /** Add the Claude subagent aliases haiku, sonnet, opus. */
    includeClaudeModels: z.boolean().default(true),
    catalog: z.array(workerCandidateConfigSchema).default([]),
  })
  .strict();

export const DEFAULT_SESSIONS_DIR = ".jev/sessions";
/** USD per million input tokens, TypeSafe list price for Jev; output tokens are free. */
export const DEFAULT_JEV_INPUT_PRICE_PER_MTOK = 0.042;

export const sessionsConfigSchema = z
  .object({
    enabled: z.boolean().default(true),
    directory: z.string().min(1).default(DEFAULT_SESSIONS_DIR),
    /** Also store the state projection sent to Jev (useful for replay, larger files). */
    recordState: z.boolean().default(false),
    inputPricePerMtok: z.number().min(0).default(DEFAULT_JEV_INPUT_PRICE_PER_MTOK),
  })
  .strict();

export const worktreesConfigSchema = z
  .object({
    enabled: z.boolean().default(true),
    directory: z.string().min(1).default(DEFAULT_WORKTREE_DIR),
  })
  .strict();

export const configSchema = z
  .object({
    version: z.literal(CONFIG_VERSION).default(CONFIG_VERSION),
    jev: jevConfigSchema.prefault({}),
    decisions: decisionsConfigSchema.prefault({}),
    codex: codexConfigSchema.prefault({}),
    worktrees: worktreesConfigSchema.prefault({}),
    workers: workersConfigSchema.prefault({}),
    sessions: sessionsConfigSchema.prefault({}),
  })
  .strict();

export type Config = z.infer<typeof configSchema>;
export type ConfigInput = z.input<typeof configSchema>;

/** Keys that must never appear in any config file. */
export const FORBIDDEN_CONFIG_KEYS = ["apiKey", "api_key", "TYPESAFE_API_KEY", "token", "secret"];

export const defaultConfig = (): Config => configSchema.parse({});
