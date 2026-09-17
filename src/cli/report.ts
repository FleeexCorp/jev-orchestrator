import type { Command } from "commander";
import pc from "picocolors";
import {
  resolveSessionId,
  SessionLog,
  type SessionRecord,
  type SessionSummary,
  summarize,
} from "../telemetry/session-log.js";
import { loadContext } from "./context.js";
import { EXIT } from "./exit-codes.js";
import { Reporter } from "./output.js";

const USD_DECIMALS = 4;
const COL = 28;

function counts(map: Record<string, number>): string {
  const entries = Object.entries(map).sort((a, b) => b[1] - a[1]);
  return entries.length === 0 ? "none" : entries.map(([k, v]) => `${k} ${v}`).join(", ");
}

export function printSummary(reporter: Reporter, s: SessionSummary): void {
  const row = (label: string, value: string) => reporter.line(`${label.padEnd(COL)}${value}`);
  reporter.title(`Session ${s.session}`);
  if (s.firstAt) {
    reporter.line(pc.dim(`${s.firstAt} to ${s.lastAt}`));
  }
  reporter.section("Jev");
  row("decisions", `${s.decisions}${s.failedDecisions ? ` (${s.failedDecisions} failed)` : ""}`);
  row("by kind", counts(s.byKind));
  row("by tier", counts(s.byTier));
  row("policy overrides", String(s.policyOverrides));
  row(
    "API calls",
    `${s.jevCalls}${s.mockCalls ? ` (${s.mockCalls} mock, excluded from cost)` : ""}`,
  );
  row("input tokens", String(s.inputTokens));
  row("estimated cost", `$${s.estimatedCostUsd.toFixed(USD_DECIMALS)}`);
  row("latency", `${s.totalJevLatencyMs} ms total, ${s.meanJevLatencyMs} ms mean`);
  reporter.section("Workers");
  row("runs", String(s.workers.runs));
  row("by status", counts(s.workers.byStatus));
  row("total duration", `${Math.round(s.workers.totalDurationMs / 1_000)} s`);
  row(
    "worker tokens",
    `${s.workers.inputTokens} in, ${s.workers.outputTokens} out (billed by the worker provider)`,
  );
}

function printTimeline(reporter: Reporter, records: SessionRecord[]): void {
  reporter.section("Timeline");
  for (const r of records) {
    const at = r.at.slice("YYYY-MM-DDT".length, "YYYY-MM-DDTHH:MM:SS".length);
    if (r.type === "worker") {
      reporter.line(
        `${pc.dim(at)} ${pc.magenta("CODEX")} ${r.id.padEnd(16)} ${r.status.padEnd(10)} ${Math.round(r.durationMs / 1_000)}s ${r.model ?? ""}`,
      );
      continue;
    }
    const tokens = r.calls.reduce((n, c) => n + (c.usage?.inputTokens ?? 0), 0);
    const outcome = r.error
      ? pc.red(`error ${r.error.kind}`)
      : (r.outcome?.recommendation ??
        r.outcome?.assignments?.map((a) => `${a.id}:${a.choice}`).join(" ") ??
        "");
    const tier = r.outcome?.tier ? ` [${r.outcome.tier}]` : "";
    reporter.line(
      `${pc.dim(at)} ${pc.cyan("JEV  ")} ${r.kind.padEnd(16)} ${outcome}${tier} ${pc.dim(`${tokens} tok, ${r.calls.reduce((n, c) => n + c.latencyMs, 0)} ms`)}`,
    );
    for (const note of r.outcome?.policyNotes ?? []) {
      reporter.line(pc.dim(`                       ! ${note}`));
    }
  }
}

export function registerReport(program: Command): void {
  program
    .command("report")
    .description(
      "What Jev decided in a session: questions, answers, tiers, tokens, cost, worker runs",
    )
    .argument("[session]", "session id (default: $JEV_SESSION or today)")
    .option("--list", "list recorded sessions")
    .option("--timeline", "print every decision and worker run in order")
    .option("--raw", "print the raw JSONL records (implies --json)")
    .option("--json", "machine-readable summary")
    .action(
      async (
        sessionArg: string | undefined,
        opts: { list?: boolean; timeline?: boolean; raw?: boolean; json?: boolean },
      ) => {
        const reporter = new Reporter({ mode: opts.json || opts.raw ? "json" : "normal" });
        const ctx = await loadContext();
        const log = SessionLog.forConfig(ctx.config, ctx.projectRoot, ctx.env);
        if (opts.list) {
          const sessions = await log.list();
          if (reporter.json) {
            reporter.emitJson(sessions);
            return;
          }
          if (sessions.length === 0) {
            reporter.info(`No sessions recorded in ${log.directory}`);
            return;
          }
          for (const s of sessions) {
            reporter.line(s);
          }
          return;
        }
        let session: string;
        try {
          session = resolveSessionId(sessionArg);
        } catch (err) {
          reporter.fail((err as Error).message);
          process.exitCode = EXIT.usage;
          return;
        }
        const records = await log.read(session);
        if (opts.raw) {
          for (const r of records) {
            reporter.emitJson(r);
          }
          return;
        }
        const summary = summarize(session, records, ctx.config.sessions.inputPricePerMtok);
        if (reporter.json) {
          reporter.emitJson({ summary, ...(opts.timeline ? { records } : {}) });
          return;
        }
        if (records.length === 0) {
          reporter.info(`No records for session "${session}" in ${log.directory}`);
          return;
        }
        printSummary(reporter, summary);
        if (opts.timeline) {
          printTimeline(reporter, records);
        }
      },
    );
}
