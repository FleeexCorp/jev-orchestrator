import { homedir } from "node:os";
import { join } from "node:path";
import type { Config } from "../config/schema.js";
import { readJson } from "../util/fs.js";

/** Who runs the worker: `codex exec -m <model>` or Claude's native Agent tool with `model: <alias>`. */
export type WorkerAdapterId = "codex" | "claude_subagent";

/** Rough cost/capability class; drives the difficulty policy, not Jev. */
export type WorkerTier = "fast" | "balanced" | "strong";

export type ReasoningEffort = "low" | "medium" | "high" | "xhigh" | "max";

export interface WorkerCandidate {
  /** Stable id used as the Jev choice option, e.g. `codex:gpt-5.6-sol` or `claude:opus`. */
  id: string;
  adapter: WorkerAdapterId;
  /** Model name passed to the adapter. */
  model: string;
  description: string;
  tier: WorkerTier;
  reasoningEffort?: ReasoningEffort;
  /** Where the entry came from, for `workers list`. */
  source: "builtin" | "codex_cache" | "config";
}

const CODEX_HOME_ENV = "CODEX_HOME";
const CODEX_MODELS_CACHE = "models_cache.json";
const CODEX_VISIBLE = "list";
const CODEX_EXCLUDED_SLUG_PATTERN = /review/i;

/** Claude Code's Agent tool accepts these aliases; users can add more in config. */
export const CLAUDE_BUILTIN: WorkerCandidate[] = [
  {
    id: "claude:haiku",
    adapter: "claude_subagent",
    model: "haiku",
    description:
      "Claude Haiku subagent: fastest and cheapest; mechanical edits, lookups, small well-specified changes.",
    tier: "fast",
    source: "builtin",
  },
  {
    id: "claude:sonnet",
    adapter: "claude_subagent",
    model: "sonnet",
    description:
      "Claude Sonnet subagent: balanced; routine implementation, tests, refactors with clear intent.",
    tier: "balanced",
    source: "builtin",
  },
  {
    id: "claude:opus",
    adapter: "claude_subagent",
    model: "opus",
    description:
      "Claude Opus subagent: strongest reasoning; ambiguous specs, cross-cutting changes, reviewing others' work.",
    tier: "strong",
    source: "builtin",
  },
];

interface CodexCacheModel {
  slug?: string;
  display_name?: string;
  description?: string;
  visibility?: string;
  priority?: number;
  default_reasoning_level?: string;
}

interface CodexCache {
  models?: CodexCacheModel[];
}

export function codexModelsCachePath(env: NodeJS.ProcessEnv = process.env): string {
  const home =
    env[CODEX_HOME_ENV] && env[CODEX_HOME_ENV].length > 0
      ? env[CODEX_HOME_ENV]
      : join(env.HOME ?? homedir(), ".codex");
  return join(home, CODEX_MODELS_CACHE);
}

const FAST_WORDS = /\b(fast|affordable|cheap|mini|nano|lite)\b/i;
const STRONG_WORDS = /\b(strongest|frontier|hardest|most capable|deep reasoning)\b/i;

/** Infer a tier from Codex's own one-line description; config can override. */
export function tierFromDescription(description: string): WorkerTier {
  if (STRONG_WORDS.test(description)) {
    return "strong";
  }
  if (FAST_WORDS.test(description)) {
    return "fast";
  }
  return "balanced";
}

/**
 * Codex keeps the account's model list in `$CODEX_HOME/models_cache.json`
 * (names, descriptions and flags only; no credentials). Read it leniently: a
 * missing or reshaped file yields an empty list, never an error.
 */
export async function codexModelsFromCache(path: string): Promise<WorkerCandidate[]> {
  let cache: CodexCache | undefined;
  try {
    cache = await readJson<CodexCache>(path);
  } catch {
    return [];
  }
  const models = Array.isArray(cache?.models) ? cache.models : [];
  return models
    .filter((m) => typeof m.slug === "string" && m.slug.length > 0)
    .filter((m) => (m.visibility ?? CODEX_VISIBLE) === CODEX_VISIBLE)
    .filter((m) => !CODEX_EXCLUDED_SLUG_PATTERN.test(m.slug ?? ""))
    .sort((a, b) => (a.priority ?? 0) - (b.priority ?? 0))
    .map((m) => {
      const slug = m.slug as string;
      const description = m.description ?? m.display_name ?? slug;
      return {
        id: `codex:${slug}`,
        adapter: "codex" as const,
        model: slug,
        description: `Codex worker on ${m.display_name ?? slug}: ${description}`,
        tier: tierFromDescription(description),
        source: "codex_cache" as const,
      };
    });
}

export interface CatalogOptions {
  codexAvailable: boolean;
  env?: NodeJS.ProcessEnv;
}

/**
 * Builtin Claude aliases, plus Codex models discovered locally, plus config
 * entries. Config entries with the same id replace discovered ones;
 * `enabled: false` removes an id. Order is preserved for display.
 */
export async function loadCatalog(
  config: Config,
  options: CatalogOptions,
): Promise<WorkerCandidate[]> {
  const out = new Map<string, WorkerCandidate>();
  if (config.workers.includeClaudeModels) {
    for (const c of CLAUDE_BUILTIN) {
      out.set(c.id, c);
    }
  }
  if (config.workers.includeCodexModels && options.codexAvailable) {
    for (const c of await codexModelsFromCache(codexModelsCachePath(options.env))) {
      out.set(c.id, c);
    }
  }
  for (const entry of config.workers.catalog) {
    if (entry.enabled === false) {
      out.delete(entry.id);
      continue;
    }
    if (entry.adapter === "codex" && !options.codexAvailable) {
      continue;
    }
    const existing = out.get(entry.id);
    out.set(entry.id, {
      id: entry.id,
      adapter: entry.adapter,
      model: entry.model,
      description:
        entry.description ?? existing?.description ?? `${entry.adapter} worker on ${entry.model}`,
      tier: entry.tier ?? existing?.tier ?? "balanced",
      ...(entry.reasoningEffort ? { reasoningEffort: entry.reasoningEffort } : {}),
      source: "config",
    });
  }
  return [...out.values()];
}
