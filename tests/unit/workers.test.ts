import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { defaultConfig } from "../../src/config/schema.js";
import { MockDecisionEngine } from "../../src/jev/mock.js";
import { decideWorkerAssignment } from "../../src/orchestration/worker.js";
import {
  CLAUDE_BUILTIN,
  codexModelsFromCache,
  loadCatalog,
  tierFromDescription,
  type WorkerCandidate,
} from "../../src/workers/catalog.js";

const FIXTURE = join(process.cwd(), "tests", "fixtures", "codex-home", "models_cache.json");
const thresholds = { autonomous: 0.85, fallback: 0.6 };

describe("worker catalog", () => {
  it("reads visible Codex models from the cache, sorted by priority, skipping review and hidden ones", async () => {
    const models = await codexModelsFromCache(FIXTURE);
    expect(models.map((m) => m.model)).toEqual(["gpt-reserve", "gpt-5.6-sol", "gpt-5.5"]);
    expect(models[0]).toMatchObject({
      id: "codex:gpt-reserve",
      adapter: "codex",
      tier: "fast",
      source: "codex_cache",
    });
    expect(models[1]?.tier).toBe("balanced");
  });

  it("tolerates a missing or malformed cache", async () => {
    expect(await codexModelsFromCache("/nope/models_cache.json")).toEqual([]);
    expect(await codexModelsFromCache(join(process.cwd(), "package.json"))).toEqual([]);
  });

  it("infers tiers from descriptions", () => {
    expect(tierFromDescription("Fast and affordable")).toBe("fast");
    expect(tierFromDescription("Our strongest model")).toBe("strong");
    expect(tierFromDescription("Reliable workhorse")).toBe("balanced");
  });

  it("merges builtin Claude aliases, Codex models and config overrides", async () => {
    const config = defaultConfig();
    config.workers.catalog = [
      {
        id: "codex:gpt-5.6-sol",
        adapter: "codex",
        model: "gpt-5.6-sol",
        tier: "strong",
        reasoningEffort: "high",
      },
      { id: "claude:haiku", adapter: "claude_subagent", model: "haiku", enabled: false },
      {
        id: "claude:fable",
        adapter: "claude_subagent",
        model: "fable",
        description: "Fable",
        tier: "strong",
      },
    ];
    const env = {
      HOME: "/nowhere",
      CODEX_HOME: join(process.cwd(), "tests", "fixtures", "codex-home"),
    };
    const catalog = await loadCatalog(config, { codexAvailable: true, env });
    const ids = catalog.map((c) => c.id);
    expect(ids).not.toContain("claude:haiku");
    expect(ids).toContain("claude:fable");
    expect(ids).toContain("codex:gpt-reserve");
    const sol = catalog.find((c) => c.id === "codex:gpt-5.6-sol");
    expect(sol).toMatchObject({ tier: "strong", reasoningEffort: "high", source: "config" });
    expect(sol?.description).toMatch(/workhorse/);

    const noCodex = await loadCatalog(config, { codexAvailable: false, env });
    expect(noCodex.every((c) => c.adapter === "claude_subagent")).toBe(true);
  });
});

describe("decideWorkerAssignment", () => {
  const catalog: WorkerCandidate[] = [
    ...CLAUDE_BUILTIN,
    {
      id: "codex:fast",
      adapter: "codex",
      model: "fast-model",
      description: "fast",
      tier: "fast",
      source: "config",
    },
    {
      id: "codex:strong",
      adapter: "codex",
      model: "strong-model",
      description: "strong",
      tier: "strong",
      source: "config",
      reasoningEffort: "high",
    },
  ];
  const state = {
    userGoal: "OAuth",
    subtasks: [
      { id: "backend", title: "callback" },
      { id: "deploy", title: "prod deploy", irreversible: true },
    ],
  };

  it("assigns one candidate per subtask with a dispatch hint", async () => {
    const engine = new MockDecisionEngine({
      worker_backend: "codex:strong",
      difficulty_backend: 1,
      worker_deploy: "claude:opus",
      difficulty_deploy: 3,
    });
    const d = await decideWorkerAssignment({ engine, thresholds }, state, catalog);
    expect(d.assignments.map((a) => a.candidateId)).toEqual(["codex:strong", "claude:opus"]);
    expect(d.assignments[0]?.dispatch).toContain("codex run --model strong-model --reasoning high");
    expect(d.assignments[1]?.dispatch).toContain('model: "opus"');
    // Irreversible subtask never sees Codex options.
    const deployQuestion = engine.requests[0]?.questions.worker_deploy;
    expect(deployQuestion?.type === "choice" && Object.keys(deployQuestion.criteria)).toEqual([
      "claude:haiku",
      "claude:sonnet",
      "claude:opus",
    ]);
    expect(d.assignments[1]?.policyNotes[0]).toMatch(/irreversible/);
  });

  it("upgrades a fast-tier pick when the task is judged tricky", async () => {
    const engine = new MockDecisionEngine({ worker_backend: "codex:fast", difficulty_backend: 3 });
    const d = await decideWorkerAssignment(
      { engine, thresholds },
      { userGoal: "x", task: { id: "backend", title: "t" } },
      catalog,
    );
    expect(d.assignments[0]?.candidateId).toBe("codex:strong");
    expect(d.assignments[0]?.policyNotes[0]).toMatch(/too high for a fast-tier/);
  });

  it("offers only Claude when Codex is unavailable and fails without candidates", async () => {
    const engine = new MockDecisionEngine({
      worker_backend: "claude:sonnet",
      difficulty_backend: 1,
    });
    const d = await decideWorkerAssignment(
      { engine, thresholds },
      { userGoal: state.userGoal, subtasks: state.subtasks.slice(0, 1), codexAvailable: false },
      catalog,
    );
    expect(d.assignments[0]?.candidateId).toBe("claude:sonnet");
    await expect(decideWorkerAssignment({ engine, thresholds }, state, [])).rejects.toThrow(
      /No worker candidates/,
    );
    await expect(
      decideWorkerAssignment({ engine, thresholds }, { userGoal: "x" }, catalog),
    ).rejects.toThrow(/needs `task` or `subtasks`/);
  });
});
