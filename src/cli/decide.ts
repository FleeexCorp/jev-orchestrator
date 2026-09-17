import { readFile } from "node:fs/promises";
import type { Command } from "commander";
import { codexStatus } from "../codex/status.js";
import { MockDecisionEngine } from "../jev/mock.js";
import { JevError } from "../jev/types.js";
import type { DecisionContext, DecisionKind } from "../orchestration/decision.js";
import {
  decideCompletion,
  decideExecutionStrategy,
  decideParallelization,
  decideRetry,
  decideReview,
  decideWorkerAssignment,
  detectStuckWorkflow,
  parseState,
  thresholdsFromConfig,
} from "../orchestration/index.js";
import {
  type DecisionRecord,
  RecordingEngine,
  resolveSessionId,
  SessionLog,
} from "../telemetry/session-log.js";
import { loadCatalog } from "../workers/catalog.js";
import { engineFor, loadContext, NO_KEY_HINT } from "./context.js";
import { EXIT } from "./exit-codes.js";
import { intOption, modeFrom, Reporter } from "./output.js";

export const DECISION_KINDS: readonly DecisionKind[] = [
  "strategy",
  "parallel",
  "worker",
  "retry",
  "review",
  "completion",
  "stuck",
];

type SingleKind = Exclude<DecisionKind, "parallel" | "worker">;
type State = ReturnType<typeof parseState>;

interface DecideOptions {
  state?: string;
  stateFile?: string;
  maxWorkers?: string;
  json?: boolean;
  verbose?: boolean;
  mock?: boolean;
  session?: string;
}

async function readState(opts: DecideOptions): Promise<unknown> {
  if (opts.state) {
    return JSON.parse(opts.state);
  }
  if (opts.stateFile) {
    return JSON.parse(await readFile(opts.stateFile, "utf8"));
  }
  if (process.stdin.isTTY) {
    throw new Error("Provide --state <json>, --state-file <path>, or pipe JSON on stdin.");
  }
  let raw = "";
  for await (const chunk of process.stdin) {
    raw += chunk;
  }
  return JSON.parse(raw);
}

function runSingle(kind: SingleKind, dctx: DecisionContext, state: State) {
  switch (kind) {
    case "strategy":
      return decideExecutionStrategy(dctx, state);
    case "retry":
      return decideRetry(dctx, state);
    case "review":
      return decideReview(dctx, state);
    case "completion":
      return decideCompletion(dctx, state);
    case "stuck":
      return detectStuckWorkflow(dctx, state);
  }
}

export function registerDecide(program: Command): void {
  program
    .command("decide")
    .description("Ask Jev a bounded orchestration question")
    .argument("<kind>", `one of: ${DECISION_KINDS.join(", ")}`)
    .option("--state <json>", "orchestration state as inline JSON")
    .option("--state-file <path>", "orchestration state file")
    .option("--max-workers <n>", "cap for parallel workers (parallel only)")
    .option("--json", "machine-readable output")
    .option("--verbose", "show probabilities for every option")
    .option("--mock", "use the offline mock engine (clearly not Jev)")
    .option(
      "--session <id>",
      "session id for the decision log (default: $JEV_SESSION or today's date)",
    )
    .action(async (kindArg: string, opts: DecideOptions) => {
      const reporter = new Reporter({ mode: modeFrom(opts) });
      if (!DECISION_KINDS.includes(kindArg as DecisionKind)) {
        reporter.fail(
          `Unknown decision kind "${kindArg}". Use one of: ${DECISION_KINDS.join(", ")}`,
        );
        process.exitCode = EXIT.usage;
        return;
      }
      const kind = kindArg as DecisionKind;

      let state: State;
      let maxWorkersOpt: number | undefined;
      let session: string;
      try {
        state = parseState(await readState(opts));
        maxWorkersOpt = intOption(opts.maxWorkers, "--max-workers", 1);
        session = resolveSessionId(opts.session);
      } catch (err) {
        reporter.fail((err as Error).message);
        process.exitCode = EXIT.usage;
        return;
      }

      const ctx = await loadContext();
      let engine: DecisionContext["engine"];
      if (opts.mock) {
        engine = new MockDecisionEngine();
        reporter.warn("Using the offline mock engine; these are not Jev decisions.");
      } else {
        const real = await engineFor(ctx);
        if (!real) {
          reporter.fail(NO_KEY_HINT);
          process.exitCode = EXIT.jevUnavailable;
          return;
        }
        engine = real;
      }

      const recording = new RecordingEngine(engine, ctx.config.sessions.recordState);
      const dctx: DecisionContext = {
        engine: recording,
        thresholds: thresholdsFromConfig(ctx.config),
      };
      const maxWorkers = maxWorkersOpt ?? ctx.config.codex.maxParallelWorkers;
      const log = ctx.config.sessions.enabled
        ? SessionLog.forConfig(ctx.config, ctx.projectRoot, ctx.env)
        : undefined;
      const record: DecisionRecord = {
        type: "decision",
        at: new Date().toISOString(),
        session,
        kind,
        calls: recording.calls,
      };

      try {
        if (kind === "parallel") {
          const d = await decideParallelization(dctx, state, maxWorkers);
          record.outcome = {
            recommendation: d.runInParallel ? "parallel" : "sequential",
            confidence: d.confidence,
            tier: d.tier,
            policyNotes: d.policyNotes,
            assignments: d.subtasks.map((s) => ({ id: s.id, choice: s.suggestedWorker })),
          };
          reporter.parallel(d);
        } else if (kind === "worker") {
          const codexAvailable = state.codexAvailable ?? (await codexStatus()).ready;
          const catalog = await loadCatalog(ctx.config, { codexAvailable, env: ctx.env });
          const d = await decideWorkerAssignment(dctx, { ...state, codexAvailable }, catalog);
          record.outcome = {
            policyNotes: d.assignments.flatMap((a) => a.policyNotes),
            assignments: d.assignments.map((a) => ({ id: a.taskId, choice: a.candidateId })),
          };
          reporter.workers(d);
        } else {
          const d = await runSingle(kind, dctx, state);
          record.outcome = {
            recommendation: d.recommendation,
            confidence: d.confidence,
            tier: d.tier,
            policyNotes: d.policyNotes,
          };
          reporter.decision(d);
        }
        await log?.append(record);
      } catch (err) {
        record.error =
          err instanceof JevError
            ? { kind: err.kind, message: err.message }
            : { kind: "error", message: (err as Error).message };
        await log?.append(record);
        if (err instanceof JevError) {
          if (reporter.json) {
            reporter.emitJson({ error: err.kind, message: err.message, retryable: err.retryable });
          } else {
            reporter.fail(
              `Jev unavailable (${err.kind}): ${err.message}`,
              "Continue with your own reasoning.",
            );
          }
          process.exitCode = EXIT.jevUnavailable;
          return;
        }
        reporter.fail((err as Error).message);
        process.exitCode = EXIT.error;
      }
    });
}
