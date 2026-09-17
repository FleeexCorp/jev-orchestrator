import { describe, expect, it } from "vitest";
import { MockDecisionEngine } from "../../src/jev/mock.js";
import type { DecisionContext } from "../../src/orchestration/decision.js";
import {
  auditChangedFiles,
  classify,
  decideCompletion,
  decideExecutionStrategy,
  decideParallelization,
  decideRetry,
  decideReview,
  detectStuckWorkflow,
  type OrchestrationState,
  parseState,
} from "../../src/orchestration/index.js";
import { noulCertainty } from "../../src/orchestration/thresholds.js";

const thresholds = { autonomous: 0.85, fallback: 0.6 };

const ctx = (engine: MockDecisionEngine): DecisionContext => ({ engine, thresholds });

const base: OrchestrationState = {
  userGoal: "Implement OAuth across backend and frontend with tests",
  subtasks: [
    { id: "backend", title: "callback", files: ["apps/api/src/auth"] },
    { id: "frontend", title: "button", files: ["apps/web/src/auth"] },
  ],
  codexAvailable: true,
};

describe("thresholds", () => {
  it("tiers confidence", () => {
    expect(classify(0.9, thresholds)).toBe("autonomous");
    expect(classify(0.85, thresholds)).toBe("autonomous");
    expect(classify(0.7, thresholds)).toBe("advisory");
    expect(classify(0.59, thresholds)).toBe("fallback");
  });

  it("maps noul probability to certainty", () => {
    expect(noulCertainty(0.5)).toBe(0);
    expect(noulCertainty(0.95)).toBeCloseTo(0.9);
    expect(noulCertainty(0.05)).toBeCloseTo(0.9);
  });
});

describe("state", () => {
  it("validates and rejects unknown keys", () => {
    expect(parseState({ userGoal: "x" }).userGoal).toBe("x");
    expect(() => parseState({ userGoal: "x", bogus: 1 })).toThrow(/Invalid orchestration state/);
    expect(() => parseState({})).toThrow();
  });
});

describe("decideExecutionStrategy", () => {
  it("high confidence -> autonomous recommendation", async () => {
    const engine = new MockDecisionEngine(
      { execution_strategy: "parallel_codex", trivial: 0.05, needs_claude_reasoning: 0.1 },
      0.9,
    );
    const d = await decideExecutionStrategy(ctx(engine), base);
    expect(d.recommendation).toBe("parallel_codex");
    expect(d.tier).toBe("autonomous");
    expect(d.signals.trivial?.yes).toBe(false);
    // Only the projection is sent, never the whole state.
    const sent = engine.requests[0]?.state as Record<string, unknown>;
    expect(Object.keys(sent).sort()).toEqual(["codexAvailable", "subtasks", "userGoal"]);
  });

  it("medium confidence -> advisory, low -> fallback", async () => {
    const mid = await decideExecutionStrategy(
      ctx(
        new MockDecisionEngine(
          { execution_strategy: "single_codex", trivial: 0.1, needs_claude_reasoning: 0.1 },
          0.7,
        ),
      ),
      base,
    );
    expect(mid.tier).toBe("advisory");
    const low = await decideExecutionStrategy(
      ctx(
        new MockDecisionEngine(
          { execution_strategy: "mixed", trivial: 0.1, needs_claude_reasoning: 0.1 },
          0.4,
        ),
      ),
      base,
    );
    expect(low.tier).toBe("fallback");
    expect(low.guidance).toMatch(/own reasoning/);
  });

  it("trivial task forces claude_direct even if Jev prefers Codex", async () => {
    const d = await decideExecutionStrategy(
      ctx(
        new MockDecisionEngine({
          execution_strategy: "single_codex",
          trivial: 0.8,
          needs_claude_reasoning: 0.1,
        }),
      ),
      {
        userGoal: "Fix a typo in README",
      },
    );
    expect(d.recommendation).toBe("claude_direct");
    expect(d.policyNotes.join(" ")).toMatch(/trivial/);
  });

  it("does not offer Codex strategies when Codex is unavailable", async () => {
    const engine = new MockDecisionEngine({
      execution_strategy: "parallel_codex",
      trivial: 0.1,
      needs_claude_reasoning: 0.1,
    });
    const d = await decideExecutionStrategy(ctx(engine), { ...base, codexAvailable: false });
    expect(Object.keys(d.probabilities).sort()).toEqual(["claude_direct", "claude_subagents"]);
    expect(d.policyNotes[0]).toMatch(/Codex is unavailable/);
  });
});

describe("decideParallelization", () => {
  it("selects Codex workers for suitable subtasks", async () => {
    const engine = new MockDecisionEngine({
      independent: 0.95,
      parallel_worthwhile: 0.9,
      codex_backend: 0.9,
      claude_backend: 0.1,
      codex_frontend: 0.85,
      claude_frontend: 0.2,
    });
    const d = await decideParallelization(ctx(engine), base, 3);
    expect(d.runInParallel).toBe(true);
    expect(d.recommendedWorkers).toBe(2);
    expect(d.subtasks.map((s) => s.suggestedWorker)).toEqual(["codex", "codex"]);
    expect(Object.keys(engine.requests[0]?.questions ?? {})).toHaveLength(6);
  });

  it("refuses parallel writes when declared files overlap and caps by config", async () => {
    const engine = new MockDecisionEngine({
      independent: 0.9,
      parallel_worthwhile: 0.9,
      codex_a: 0.9,
      claude_a: 0.1,
      codex_b: 0.9,
      claude_b: 0.1,
    });
    const overlap: OrchestrationState = {
      userGoal: "x",
      subtasks: [
        { id: "a", title: "a", files: ["src/shared.ts"] },
        { id: "b", title: "b", files: ["src/shared.ts"] },
      ],
    };
    const d = await decideParallelization(ctx(engine), overlap, 3);
    expect(d.runInParallel).toBe(false);
    expect(d.policyNotes[0]).toMatch(/overlapping files/);
    const capped = await decideParallelization(
      ctx(engine),
      {
        userGoal: "x",
        subtasks: [
          { id: "a", title: "a" },
          { id: "b", title: "b" },
        ],
      },
      1,
    );
    expect(capped.recommendedWorkers).toBe(1);
  });

  it("needs at least two subtasks", async () => {
    await expect(
      decideParallelization(
        ctx(new MockDecisionEngine()),
        { userGoal: "x", subtasks: [{ id: "a", title: "a" }] },
        3,
      ),
    ).rejects.toThrow(/at least 2/);
  });
});

describe("decideRetry", () => {
  const failed: OrchestrationState = {
    userGoal: "x",
    workerResult: { id: "w", task: "t", status: "failed", summary: "tests failed" },
    recentFailures: [{ summary: "TypeError in auth.spec", count: 2 }],
  };

  it("removes retry_same_worker at the attempt cap", async () => {
    const engine = new MockDecisionEngine({
      next_action: "retry_same_worker",
      failure_repetitive: 0.2,
      likely_transient: 0.6,
    });
    const d = await decideRetry(ctx(engine), { ...failed, attempts: 2, maxAttempts: 2 });
    expect(Object.keys(d.probabilities)).not.toContain("retry_same_worker");
    expect(d.policyNotes[0]).toMatch(/Attempt cap/);
  });

  it("turns a repetitive-failure retry into a debug worker", async () => {
    const engine = new MockDecisionEngine({
      next_action: "retry_same_worker",
      failure_repetitive: 0.9,
      likely_transient: 0.1,
    });
    const d = await decideRetry(ctx(engine), { ...failed, attempts: 1 });
    expect(d.recommendation).toBe("spawn_debug_worker");
    expect(d.signals.failure_repetitive?.yes).toBe(true);
  });
});

describe("decideReview", () => {
  const done: OrchestrationState = {
    userGoal: "x",
    task: { title: "frontend", files: ["apps/web/src/auth"] },
    workerResult: { id: "w", task: "t", status: "completed", summary: "done" },
    changedFiles: ["apps/web/src/auth/Login.tsx"],
    testResults: { passed: 10, failed: 0 },
  };

  it("audits scope and sensitive paths", () => {
    const audit = auditChangedFiles(
      ["apps/web/src/auth/a.ts", "apps/api/x.ts", ".github/workflows/ci.yml", "pnpm-lock.yaml"],
      ["apps/web/src/auth"],
    );
    expect(audit.outOfScope).toEqual([
      "apps/api/x.ts",
      ".github/workflows/ci.yml",
      "pnpm-lock.yaml",
    ]);
    expect(audit.sensitive).toEqual([".github/workflows/ci.yml", "pnpm-lock.yaml"]);
  });

  it("accepts a clean in-scope result with high confidence", async () => {
    const engine = new MockDecisionEngine({
      review_decision: "accept",
      likely_complete: 0.9,
      scope_respected: 0.95,
      needs_claude_review: 0.1,
    });
    const d = await decideReview(ctx(engine), done);
    expect(d.recommendation).toBe("accept");
    expect(d.tier).toBe("autonomous");
  });

  it("forces Claude review for sensitive files and failing tests", async () => {
    const engine = new MockDecisionEngine({
      review_decision: "accept",
      likely_complete: 0.9,
      scope_respected: 0.9,
      needs_claude_review: 0.1,
    });
    const sensitive = await decideReview(ctx(engine), {
      ...done,
      changedFiles: ["apps/web/src/auth/Login.tsx", ".env.local"],
    });
    expect(sensitive.recommendation).toBe("review_with_claude");
    const failing = await decideReview(ctx(engine), {
      ...done,
      testResults: { passed: 9, failed: 1 },
    });
    expect(failing.recommendation).toBe("review_with_claude");
    const outOfScope = await decideReview(ctx(engine), {
      ...done,
      changedFiles: ["apps/api/src/main.ts"],
    });
    expect(outOfScope.recommendation).toBe("review_with_claude");
  });
});

describe("completion and stuck", () => {
  it("cannot finish while workers run or tests fail", async () => {
    const engine = new MockDecisionEngine({
      next_action: "finish",
      goal_satisfied: 0.9,
      needs_final_review: 0.2,
    });
    const running = await decideCompletion(ctx(engine), {
      userGoal: "x",
      activeWorkers: [{ id: "a", task: "t", status: "running" }],
    });
    expect(running.recommendation).toBe("continue");
    const failing = await decideCompletion(ctx(engine), {
      userGoal: "x",
      testResults: { failed: 2 },
    });
    expect(failing.recommendation).toBe("review");
    const clean = await decideCompletion(ctx(engine), {
      userGoal: "x",
      testResults: { failed: 0, passed: 5 },
    });
    expect(clean.recommendation).toBe("finish");
  });

  it("blocks continue after three identical failures", async () => {
    const engine = new MockDecisionEngine({ unstick_action: "continue", stuck: 0.8 });
    const d = await detectStuckWorkflow(ctx(engine), {
      userGoal: "x",
      recentFailures: [{ summary: "same error", count: 3 }],
    });
    expect(d.recommendation).toBe("spawn_debug_worker");
    expect(d.signals.stuck?.yes).toBe(true);
  });
});

describe("policy edge cases", () => {
  it("an unsure 0.5 trivial signal never forces claude_direct", async () => {
    const engine = new MockDecisionEngine({ execution_strategy: "single_codex" });
    const d = await decideExecutionStrategy(ctx(engine), base);
    expect(d.recommendation).toBe("single_codex");
    expect(d.policyNotes).toEqual([]);
  });

  it("irreversible tasks stay with Claude and are always reviewed", async () => {
    const strategyEngine = new MockDecisionEngine({
      execution_strategy: "single_codex",
      trivial: 0.1,
      needs_claude_reasoning: 0.1,
    });
    const s = await decideExecutionStrategy(ctx(strategyEngine), {
      userGoal: "Drop the legacy tables",
      task: { title: "drop", irreversible: true },
    });
    expect(s.recommendation).toBe("claude_direct");
    const reviewEngine = new MockDecisionEngine({
      review_decision: "accept",
      likely_complete: 0.9,
      scope_respected: 0.9,
      needs_claude_review: 0.1,
    });
    const r = await decideReview(ctx(reviewEngine), {
      userGoal: "x",
      task: { title: "deploy", irreversible: true },
      workerResult: { id: "w", task: "t", status: "completed" },
      testResults: { failed: 0 },
    });
    expect(r.recommendation).toBe("review_with_claude");
  });

  it("parallel never recommends workers when nothing suits Codex", async () => {
    const engine = new MockDecisionEngine({
      independent: 0.9,
      parallel_worthwhile: 0.9,
      codex_backend: 0.2,
      claude_backend: 0.9,
      codex_frontend: 0.2,
      claude_frontend: 0.9,
    });
    const d = await decideParallelization(ctx(engine), base, 3);
    expect(d.runInParallel).toBe(false);
    expect(d.recommendedWorkers).toBe(0);
    const noWorktrees = new MockDecisionEngine({
      independent: 0.9,
      parallel_worthwhile: 0.9,
      codex_backend: 0.9,
      claude_backend: 0.1,
      codex_frontend: 0.9,
      claude_frontend: 0.1,
    });
    const w = await decideParallelization(
      ctx(noWorktrees),
      { ...base, worktreesAvailable: false },
      3,
    );
    expect(w.runInParallel).toBe(false);
    expect(w.recommendedWorkers).toBe(1);
  });

  it("review blocks accept without verification or with a failing build", async () => {
    const engine = new MockDecisionEngine({
      review_decision: "accept",
      likely_complete: 0.9,
      scope_respected: 0.9,
      needs_claude_review: 0.1,
    });
    const unverified = await decideReview(ctx(engine), {
      userGoal: "x",
      workerResult: { id: "w", task: "t", status: "completed" },
    });
    expect(unverified.recommendation).toBe("review_with_claude");
    expect(unverified.policyNotes[0]).toMatch(/No test or build results/);
    const buildBroken = await decideReview(ctx(engine), {
      userGoal: "x",
      workerResult: { id: "w", task: "t", status: "completed" },
      buildResults: { failed: 1 },
    });
    expect(buildBroken.recommendation).toBe("review_with_claude");
    const completion = new MockDecisionEngine({
      next_action: "finish",
      goal_satisfied: 0.9,
      needs_final_review: 0.1,
    });
    const c = await decideCompletion(ctx(completion), {
      userGoal: "x",
      buildResults: { failed: 2 },
    });
    expect(c.recommendation).toBe("review");
  });
});
