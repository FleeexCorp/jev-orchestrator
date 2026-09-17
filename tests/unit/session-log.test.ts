import { appendFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MockDecisionEngine } from "../../src/jev/mock.js";
import { choice, type DecisionEngine, JevError, noul } from "../../src/jev/types.js";
import {
  type DecisionRecord,
  RecordingEngine,
  resolveSessionId,
  SessionLog,
  summarize,
  type WorkerRecord,
} from "../../src/telemetry/session-log.js";
import { initGitRepo, makeTmpDir, removeTmpDir } from "../helpers/tmp.js";

const questions = { pick: choice("Which?", { a: null, b: null }), yes: noul("Yes?") };

describe("resolveSessionId", () => {
  it("prefers the flag, then JEV_SESSION, then today's date", () => {
    expect(resolveSessionId("feat-x", { JEV_SESSION: "env" })).toBe("feat-x");
    expect(resolveSessionId(undefined, { JEV_SESSION: "env-id" })).toBe("env-id");
    expect(resolveSessionId(undefined, {})).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(() => resolveSessionId("bad/../id")).toThrow(/Invalid session id/);
  });
});

describe("RecordingEngine", () => {
  it("records questions, answers, usage and latency without changing results", async () => {
    const inner = new MockDecisionEngine({ pick: "b", yes: 0.9 });
    const rec = new RecordingEngine(inner);
    const result = await rec.decide({ id: "r1", state: { goal: "g" }, questions });
    expect(result.answers.pick.choice).toBe("b");
    expect(rec.calls).toHaveLength(1);
    const call = rec.calls[0];
    expect(call).toMatchObject({ requestId: "r1", engine: "mock", model: "mock", stateBytes: 12 });
    expect(call?.questions).toEqual({
      pick: { type: "choice", options: ["a", "b"] },
      yes: { type: "noul" },
    });
    expect(call?.state).toBeUndefined();
    const withState = new RecordingEngine(inner, true);
    await withState.decide({ id: "r2", state: { goal: "g" }, questions });
    expect(withState.calls[0]?.state).toEqual({ goal: "g" });
  });

  it("records errors and rethrows them", async () => {
    const failing: DecisionEngine = {
      id: "typesafe",
      decide: async () => {
        throw new JevError("rate_limit", "429");
      },
    };
    const rec = new RecordingEngine(failing);
    await expect(rec.decide({ id: "r", state: "s", questions })).rejects.toBeInstanceOf(JevError);
    expect(rec.calls[0]?.error).toEqual({ kind: "rate_limit", message: "429" });
  });
});

describe("SessionLog", () => {
  let root: string;

  beforeEach(async () => {
    root = await makeTmpDir();
    await initGitRepo(root);
  });

  afterEach(async () => {
    await removeTmpDir(root);
  });

  const decision = (session: string, extra: Partial<DecisionRecord> = {}): DecisionRecord => ({
    type: "decision",
    at: "2026-09-17T10:00:00.000Z",
    session,
    kind: "strategy",
    calls: [
      {
        requestId: "x",
        engine: "typesafe",
        model: "jev-1.13.0",
        questions: {},
        stateBytes: 100,
        usage: { inputTokens: 1_000_000, outputTokens: 10 },
        latencyMs: 400,
      },
    ],
    outcome: {
      recommendation: "parallel_codex",
      confidence: 0.9,
      tier: "autonomous",
      policyNotes: [],
    },
    ...extra,
  });

  it("appends JSONL per session, excludes .jev from git status, skips torn lines", async () => {
    const log = new SessionLog(join(root, ".jev", "sessions"), root);
    await log.append(decision("s1"));
    await log.append({
      ...decision("s1"),
      kind: "review",
      outcome: { recommendation: "accept", tier: "advisory", policyNotes: ["forced"] },
    });
    await log.append(decision("s2"));
    await appendFile(log.file("s1"), '{"type":"decision","at":"trunc');
    expect(await log.list()).toEqual(["s1", "s2"]);
    expect((await log.read("s1")).map((r) => (r.type === "decision" ? r.kind : r.type))).toEqual([
      "strategy",
      "review",
    ]);
    expect(await log.read("missing")).toEqual([]);
    const exclude = await readFile(join(root, ".git", "info", "exclude"), "utf8");
    expect(exclude).toContain("/.jev/");
  });

  it("summarizes decisions, tiers, overrides, cost and workers", () => {
    const worker: WorkerRecord = {
      type: "worker",
      at: "2026-09-17T10:05:00.000Z",
      session: "s",
      id: "backend",
      adapter: "codex",
      model: "gpt-5.6-sol",
      sandbox: "workspace_write",
      status: "completed",
      durationMs: 60_000,
      changedFiles: 3,
      usage: { inputTokens: 500, outputTokens: 50 },
    };
    const mock = decision("s", {
      kind: "retry",
      calls: [
        {
          requestId: "m",
          engine: "mock",
          questions: {},
          stateBytes: 5,
          latencyMs: 10,
          usage: { inputTokens: 999, outputTokens: 0 },
        },
      ],
    });
    const failed = decision("s", { kind: "stuck", error: { kind: "timeout", message: "t" } });
    delete failed.outcome;
    const s = summarize(
      "s",
      [
        decision("s"),
        decision("s", { outcome: { tier: "advisory", policyNotes: ["x"] } }),
        mock,
        failed,
        worker,
      ],
      0.042,
    );
    expect(s.decisions).toBe(4);
    expect(s.failedDecisions).toBe(1);
    expect(s.byKind).toEqual({ strategy: 2, retry: 1, stuck: 1 });
    expect(s.byTier).toEqual({ autonomous: 2, advisory: 1 });
    expect(s.policyOverrides).toBe(1);
    expect(s.jevCalls).toBe(4);
    expect(s.mockCalls).toBe(1);
    expect(s.inputTokens).toBe(3_000_000);
    expect(s.estimatedCostUsd).toBeCloseTo(0.126);
    expect(s.meanJevLatencyMs).toBe(Math.round((400 * 3 + 10) / 4));
    expect(s.workers).toEqual({
      runs: 1,
      byStatus: { completed: 1 },
      totalDurationMs: 60_000,
      inputTokens: 500,
      outputTokens: 50,
    });
    expect(s.firstAt).toBe("2026-09-17T10:00:00.000Z");
  });
});
