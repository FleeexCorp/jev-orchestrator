/** Filesystem access granted to a worker. Read-only workers may share a tree. */
export type WorkerSandbox = "read_only" | "workspace_write";

/** A unit of work handed to a coding worker. */
export interface WorkerRequest {
  id: string;
  /** Narrow, self-contained instructions. See skill/references/codex-workers.md. */
  task: string;
  /** Working directory; a git worktree for write tasks run in parallel. */
  cwd: string;
  /** Extra context appended after the task (interfaces, constraints, file lists). */
  context?: string;
  sandbox: WorkerSandbox;
  /** Model override, adapter specific. */
  model?: string;
  /** Adapter-specific reasoning depth, e.g. Codex `model_reasoning_effort`. */
  reasoningEffort?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Streamed progress lines for verbose output. */
  onEvent?: (event: WorkerEvent) => void;
}

export type WorkerStatus = "completed" | "failed" | "cancelled" | "timed_out";

export interface WorkerResult {
  id: string;
  status: WorkerStatus;
  /** The worker's final message, or an error description. */
  summary: string;
  changedFiles?: string[];
  commandsRun?: number;
  exitCode?: number;
  /** Raw machine-readable output kept for inspection; caller decides retention. */
  rawOutputPath?: string;
  durationMs: number;
  usage?: { inputTokens: number; outputTokens: number };
}

export interface WorkerEvent {
  kind: "message" | "command" | "file_change" | "error";
  text: string;
}

/**
 * Pluggable execution backend. Codex is the first implementation; Claude
 * subagents, Gemini CLI, OpenCode or local models can implement the same
 * contract without touching orchestration code.
 */
export interface WorkerAdapter {
  readonly id: string;
  isAvailable(): Promise<boolean>;
  run(request: WorkerRequest): Promise<WorkerResult>;
}
