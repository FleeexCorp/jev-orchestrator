import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { Command } from "commander";
import { codexStatus, codexStatusLines, type StatusLine } from "../codex/status.js";
import { CodexWorkerAdapter } from "../codex/worker.js";
import { projectJevDir } from "../config/paths.js";
import { resolveSessionId, SessionLog, type WorkerRecord } from "../telemetry/session-log.js";
import { shortId } from "../util/id.js";
import type { WorkerRequest, WorkerSandbox } from "../workers/adapter.js";
import type { ReasoningEffort } from "../workers/catalog.js";
import { type CliContext, loadContext } from "./context.js";
import { EXIT } from "./exit-codes.js";
import { intOption, modeFrom, Reporter } from "./output.js";

const MS_PER_MINUTE = 60_000;
const LOCKS_DIR = "locks";
const REASONING_EFFORTS: readonly ReasoningEffort[] = ["low", "medium", "high", "xhigh", "max"];

interface RunOptions {
  task?: string;
  taskFile?: string;
  contextFile?: string;
  cwd?: string;
  id?: string;
  readOnly?: boolean;
  model?: string;
  reasoning?: string;
  timeoutMin?: string;
  keepRaw?: boolean;
  json?: boolean;
  verbose?: boolean;
  session?: string;
}

export function printStatusLines(reporter: Reporter, lines: StatusLine[]): void {
  for (const l of lines) {
    if (l.level === "ok") {
      reporter.ok(l.label);
    } else if (l.level === "warn") {
      reporter.warn(l.label, l.fix);
    } else {
      reporter.fail(l.label, l.fix);
    }
  }
}

/**
 * One write worker per directory at a time. The lock lives under `.jev/locks`
 * (excluded from git), keyed by the directory path, so two `codex run` calls
 * on the same tree cannot overlap.
 */
async function acquireWriteLock(
  ctx: CliContext,
  cwd: string,
): Promise<(() => Promise<void>) | undefined> {
  const base = ctx.projectRoot ?? cwd;
  const dir = join(projectJevDir(base), LOCKS_DIR);
  await mkdir(dir, { recursive: true });
  const lock = join(dir, `${createHash("sha1").update(cwd).digest("hex")}.lock`);
  try {
    await writeFile(lock, `${process.pid}\n${cwd}\n`, { flag: "wx" });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") {
      return undefined;
    }
    throw err;
  }
  return () => rm(lock, { force: true });
}

export function registerCodex(program: Command): void {
  const codex = program.command("codex").description("Codex worker commands");

  codex
    .command("status")
    .description("Check Codex CLI installation and authentication")
    .option("--json", "machine-readable output")
    .action(async (opts: { json?: boolean }) => {
      const reporter = new Reporter({ mode: modeFrom(opts) });
      const status = await codexStatus();
      if (reporter.json) {
        reporter.emitJson(status);
      } else {
        printStatusLines(reporter, codexStatusLines(status));
      }
      process.exitCode = status.ready ? EXIT.ok : EXIT.codexUnavailable;
    });

  codex
    .command("run")
    .description("Run one Codex worker non-interactively (prompt via stdin, sandbox on)")
    .option("--task <text>", "worker task")
    .option("--task-file <path>", "file containing the worker task")
    .option("--context-file <path>", "extra context appended to the task")
    .option("--cwd <dir>", "working directory (a worktree for write tasks)", process.cwd())
    .option("--id <id>", "worker id for logs and results")
    .option("--read-only", "read-only sandbox; safe on the main tree")
    .option("--model <model>", "Codex model override (see: jev-orchestrator workers list)")
    .option("--reasoning <effort>", `Codex reasoning effort: ${REASONING_EFFORTS.join(", ")}`)
    .option("--timeout-min <n>", "kill the worker after n minutes")
    .option("--keep-raw", "keep the JSONL event log and report its path")
    .option("--session <id>", "session id for the run log (default: $JEV_SESSION or today's date)")
    .option("--json", "print the WorkerResult as JSON")
    .option("--verbose", "stream worker events")
    .action(async (opts: RunOptions) => {
      const reporter = new Reporter({ mode: modeFrom(opts) });
      const ctx = await loadContext();
      if (!ctx.config.codex.enabled) {
        reporter.fail("Codex is disabled in config (codex.enabled = false).");
        process.exitCode = EXIT.codexUnavailable;
        return;
      }

      let task = opts.task;
      let timeoutMin: number | undefined;
      let session: string;
      try {
        session = resolveSessionId(opts.session);
        if (!task && opts.taskFile) {
          task = await readFile(opts.taskFile, "utf8");
        }
        if (!task || task.trim().length === 0) {
          throw new Error("Provide --task <text> or --task-file <path>.");
        }
        timeoutMin = intOption(opts.timeoutMin, "--timeout-min", 1);
        if (opts.reasoning && !REASONING_EFFORTS.includes(opts.reasoning as ReasoningEffort)) {
          throw new Error(`--reasoning must be one of: ${REASONING_EFFORTS.join(", ")}`);
        }
      } catch (err) {
        reporter.fail((err as Error).message);
        process.exitCode = EXIT.usage;
        return;
      }
      const context = opts.contextFile ? await readFile(opts.contextFile, "utf8") : undefined;

      const status = await codexStatus();
      if (!status.ready) {
        if (reporter.json) {
          reporter.emitJson({ error: "codex_unavailable", ...status });
        } else {
          printStatusLines(reporter, codexStatusLines(status));
        }
        process.exitCode = EXIT.codexUnavailable;
        return;
      }

      const adapter = new CodexWorkerAdapter({
        ...(ctx.config.codex.model ? { model: ctx.config.codex.model } : {}),
        defaultTimeoutMs: ctx.config.codex.workerTimeoutMs,
        keepRawOutput: opts.keepRaw ?? false,
      });

      const id = opts.id ?? `worker-${shortId()}`;
      const cwd = resolve(opts.cwd ?? process.cwd());
      const sandbox: WorkerSandbox = opts.readOnly ? "read_only" : "workspace_write";
      const request: WorkerRequest = { id, task, cwd, sandbox };
      if (context) {
        request.context = context;
      }
      if (opts.model) {
        request.model = opts.model;
      }
      if (opts.reasoning) {
        request.reasoningEffort = opts.reasoning;
      }
      if (timeoutMin !== undefined) {
        request.timeoutMs = timeoutMin * MS_PER_MINUTE;
      }
      if (reporter.verbose) {
        request.onEvent = (ev) =>
          reporter.line(`      ${ev.kind.padEnd(12)}${ev.text.split("\n")[0] ?? ""}`);
      }

      let release: (() => Promise<void>) | undefined;
      if (sandbox === "workspace_write") {
        release = await acquireWriteLock(ctx, cwd);
        if (!release) {
          reporter.fail(
            `Another write worker is already running in ${cwd}.`,
            "Use a separate worktree: jev-orchestrator worktree create <name>",
          );
          process.exitCode = EXIT.workerFailed;
          return;
        }
        if (ctx.projectRoot && cwd === ctx.projectRoot && !reporter.json) {
          reporter.warn(
            "Write worker on the main working tree; do not start another one until it finishes.",
          );
        }
      }

      reporter.codexBlock(id, "started", `${sandbox}  ${cwd}`);
      let result: Awaited<ReturnType<CodexWorkerAdapter["run"]>>;
      try {
        result = await adapter.run(request);
      } finally {
        await release?.();
      }
      const modelUsed = request.model ?? ctx.config.codex.model;
      if (ctx.config.sessions.enabled) {
        const entry: WorkerRecord = {
          type: "worker",
          at: new Date().toISOString(),
          session,
          id,
          adapter: adapter.id,
          ...(modelUsed ? { model: modelUsed } : {}),
          sandbox,
          status: result.status,
          durationMs: result.durationMs,
          changedFiles: result.changedFiles?.length ?? 0,
          ...(result.usage ? { usage: result.usage } : {}),
        };
        await SessionLog.forConfig(ctx.config, ctx.projectRoot, ctx.env).append(entry);
      }

      if (reporter.json) {
        reporter.emitJson(result);
      } else {
        const seconds = Math.round(result.durationMs / 1_000);
        reporter.codexBlock(
          id,
          result.status,
          `${seconds}s, ${result.changedFiles?.length ?? 0} file(s) changed`,
        );
        reporter.line();
        reporter.line(result.summary);
        for (const f of result.changedFiles ?? []) {
          reporter.info(f);
        }
      }
      process.exitCode = result.status === "completed" ? EXIT.ok : EXIT.workerFailed;
    });
}
