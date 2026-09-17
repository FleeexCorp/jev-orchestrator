import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import { ENV } from "../config/paths.js";
import { envWithoutSecrets, redact } from "../security/secrets.js";
import { ExecSpawnError, exec } from "../util/exec.js";
import type {
  WorkerAdapter,
  WorkerEvent,
  WorkerRequest,
  WorkerResult,
} from "../workers/adapter.js";
import { codexAuthStatus } from "./auth.js";
import { CODEX_BINARY, CODEX_INSTALL_NPM, detectCodex } from "./detect.js";
import { applyLine, type CodexEvent, emptyRun, type ParsedCodexRun } from "./parser.js";

/** `codex exec --sandbox` values, see `codex exec --help`. */
export const CODEX_SANDBOX = {
  read_only: "read-only",
  workspace_write: "workspace-write",
} as const;

const TMP_PREFIX = "jev-codex-";
const LAST_MESSAGE_FILE = "last-message.txt";
const EVENTS_FILE = "events.jsonl";
const MAX_SUMMARY_CHARS = 4_000;
const STDERR_TAIL_LINES = 5;

export interface CodexWorkerOptions {
  binary?: string;
  /** Default model for `codex exec -m`. */
  model?: string;
  defaultTimeoutMs?: number;
  /** Keep the JSONL event log after the run and report its path. */
  keepRawOutput?: boolean;
  /** Pass `--skip-git-repo-check`; only for non-repo scratch directories. */
  allowOutsideGit?: boolean;
  /** Environment for the child; defaults to the current env minus the TypeSafe key. */
  env?: NodeJS.ProcessEnv;
}

/**
 * Runs `codex exec` non-interactively. The prompt travels over stdin, never
 * argv. The Codex sandbox stays on: read-only for analysis workers,
 * workspace-write for implementation workers. Approval bypass flags are
 * never used, and the TypeSafe key is stripped from the child's environment.
 */
export class CodexWorkerAdapter implements WorkerAdapter {
  readonly id = "codex";
  readonly #options: CodexWorkerOptions;

  constructor(options: CodexWorkerOptions = {}) {
    this.#options = options;
  }

  async isAvailable(): Promise<boolean> {
    const detection = await detectCodex(this.#binary);
    if (!detection.installed) {
      return false;
    }
    const auth = await codexAuthStatus(this.#binary);
    return auth.authenticated;
  }

  get #binary(): string {
    return this.#options.binary ?? CODEX_BINARY;
  }

  buildArgs(request: WorkerRequest, lastMessagePath: string): string[] {
    const args = [
      "exec",
      "--json",
      "--ephemeral",
      "--color",
      "never",
      "--sandbox",
      CODEX_SANDBOX[request.sandbox],
      "-C",
      request.cwd,
      "--output-last-message",
      lastMessagePath,
    ];
    const model = request.model ?? this.#options.model;
    if (model) {
      args.push("--model", model);
    }
    if (request.reasoningEffort) {
      args.push("-c", `model_reasoning_effort="${request.reasoningEffort}"`);
    }
    if (this.#options.allowOutsideGit) {
      args.push("--skip-git-repo-check");
    }
    // "-" reads the prompt from stdin.
    args.push("-");
    return args;
  }

  async run(request: WorkerRequest): Promise<WorkerResult> {
    const started = Date.now();
    const tmp = await mkdtemp(join(tmpdir(), TMP_PREFIX));
    const lastMessagePath = join(tmp, LAST_MESSAGE_FILE);
    const eventsPath = join(tmp, EVENTS_FILE);
    const run = emptyRun();
    let buffer = "";
    const emit = (event: WorkerEvent) => request.onEvent?.(event);
    const env = this.#options.env ?? envWithoutSecrets();
    const leaked = [process.env[ENV.typesafeApiKey]];

    const onStdout = (chunk: string) => {
      buffer += chunk;
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        const ev = applyLine(run, line);
        if (ev) {
          emitEvent(emit, ev, request.cwd);
        }
      }
    };

    const timeoutMs = request.timeoutMs ?? this.#options.defaultTimeoutMs;
    let timedOut = false;
    const timer =
      timeoutMs === undefined
        ? undefined
        : setTimeout(() => {
            timedOut = true;
          }, timeoutMs).unref();
    try {
      const result = await exec(this.#binary, this.buildArgs(request, lastMessagePath), {
        cwd: request.cwd,
        env,
        input: buildPrompt(request),
        ...(timeoutMs === undefined ? {} : { timeoutMs }),
        stdout: this.#options.keepRawOutput ? "buffer" : "stream_only",
        onStdout,
        ...(request.signal ? { signal: request.signal } : {}),
      });
      if (buffer.trim().length > 0) {
        applyLine(run, buffer);
      }

      let rawOutputPath: string | undefined;
      if (this.#options.keepRawOutput) {
        await writeFile(eventsPath, redact(result.stdout, leaked), "utf8");
        rawOutputPath = eventsPath;
      }

      const status = statusOf(
        result.exitCode,
        result.signal,
        run,
        request.signal?.aborted === true,
        timedOut,
      );
      const out: WorkerResult = {
        id: request.id,
        status,
        summary: redact(summarize(run, result.stderr, status), leaked),
        changedFiles: run.changedFiles.map((f) => toRelative(f, request.cwd)),
        commandsRun: run.commandsRun,
        durationMs: Date.now() - started,
      };
      if (result.exitCode !== null) {
        out.exitCode = result.exitCode;
      }
      if (rawOutputPath) {
        out.rawOutputPath = rawOutputPath;
      }
      if (run.usage) {
        out.usage = run.usage;
      }
      return out;
    } catch (err) {
      const message =
        err instanceof ExecSpawnError && err.code === "ENOENT"
          ? `Codex CLI not found. Install it with: ${CODEX_INSTALL_NPM}`
          : (err as Error).message;
      return {
        id: request.id,
        status: "failed",
        summary: redact(message, leaked),
        durationMs: Date.now() - started,
      };
    } finally {
      if (timer) {
        clearTimeout(timer);
      }
      if (!this.#options.keepRawOutput) {
        await rm(tmp, { recursive: true, force: true });
      } else {
        await rm(lastMessagePath, { force: true });
      }
    }
  }
}

function statusOf(
  exitCode: number | null,
  signal: NodeJS.Signals | null,
  run: ParsedCodexRun,
  aborted: boolean,
  timedOut: boolean,
): WorkerResult["status"] {
  if (timedOut) {
    return "timed_out";
  }
  if (aborted || signal === "SIGTERM" || signal === "SIGKILL") {
    return "cancelled";
  }
  return exitCode === 0 && !run.turnFailed ? "completed" : "failed";
}

function emitEvent(emit: (e: WorkerEvent) => void, ev: CodexEvent, cwd: string): void {
  const item = ev.item;
  if (ev.type === "turn.failed") {
    emit({ kind: "error", text: "turn failed" });
    return;
  }
  if (ev.type !== "item.completed" || !item) {
    return;
  }
  if (item.type === "agent_message" && typeof item.text === "string") {
    emit({ kind: "message", text: item.text });
  } else if (item.type === "command_execution" && typeof item.command === "string") {
    emit({ kind: "command", text: item.command });
  } else if (item.type === "file_change" && Array.isArray(item.changes)) {
    const paths = item.changes
      .map((c) => (typeof c.path === "string" ? toRelative(c.path, cwd) : undefined))
      .filter((p): p is string => p !== undefined);
    emit({ kind: "file_change", text: paths.join(", ") });
  }
}

function toRelative(file: string, cwd: string): string {
  if (!isAbsolute(file)) {
    return file;
  }
  const rel = relative(cwd, file);
  return rel.startsWith("..") ? file : rel;
}

/** The worker prompt: task first, then optional context, then reporting rules. */
export function buildPrompt(request: WorkerRequest): string {
  const parts = [request.task.trim()];
  if (request.context && request.context.trim().length > 0) {
    parts.push("", "## Context", request.context.trim());
  }
  parts.push(
    "",
    "## Reporting",
    "When finished, reply with a concise summary: files changed, tests or commands run and their result, and any remaining concerns. Do not modify files outside the stated scope.",
  );
  return `${parts.join("\n")}\n`;
}

function summarize(run: ParsedCodexRun, stderr: string, status: WorkerResult["status"]): string {
  if (run.finalMessage) {
    return run.finalMessage.slice(0, MAX_SUMMARY_CHARS);
  }
  if (run.errors.length > 0) {
    return run.errors.join("; ").slice(0, MAX_SUMMARY_CHARS);
  }
  if (status === "timed_out") {
    return "Worker exceeded its time limit before producing a summary.";
  }
  if (status === "cancelled") {
    return "Worker cancelled before producing a summary.";
  }
  const tail = stderr.trim().split("\n").slice(-STDERR_TAIL_LINES).join("\n");
  return tail.length > 0 ? tail.slice(0, MAX_SUMMARY_CHARS) : "Worker produced no summary.";
}
