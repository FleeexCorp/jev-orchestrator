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
import { capabilitiesFrom, resolveCandidate, strongerCapability } from "../../src/workers/roles.js";

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

describe("capability options", () => {
  const candidates: WorkerCandidate[] = [
    {
      id: "codex:pinned",
      adapter: "codex",
      model: "gpt-pinned",
      description: "pinned",
      tier: "balanced",
      source: "config",
    },
    {
      id: "codex:other",
      adapter: "codex",
      model: "gpt-other",
      description: "other",
      tier: "balanced",
      source: "codex_cache",
    },
    {
      id: "codex:quick",
      adapter: "codex",
      model: "gpt-quick",
      description: "quick",
      tier: "fast",
      source: "codex_cache",
    },
    ...CLAUDE_BUILTIN,
  ];

  it("offers one option per capability, weakest first, with no model names", () => {
    const options = capabilitiesFrom(candidates);
    expect(options.map((o) => o.tier)).toEqual(["fast", "balanced", "strong"]);
    for (const o of options) {
      for (const c of candidates) {
        expect(o.description).not.toContain(c.model);
      }
    }
    expect(options[0]?.description).toMatch(/mechanical and fully specified/);
  });

  it("resolves a capability to the preferred adapter, catalog order winning inside it", () => {
    const options = capabilitiesFrom(candidates);
    const balanced = options.find((o) => o.tier === "balanced");
    if (!balanced) {
      throw new Error("missing capability");
    }
    expect(resolveCandidate(balanced, "codex").model).toBe("gpt-pinned");
    expect(resolveCandidate(balanced, "claude_subagent").model).toBe("sonnet");
    const claudeOnly = capabilitiesFrom(CLAUDE_BUILTIN);
    const fast = claudeOnly.find((o) => o.tier === "fast");
    if (!fast) {
      throw new Error("missing capability");
    }
    // Falls back when the preferred adapter has nothing at that capability.
    expect(resolveCandidate(fast, "codex").model).toBe("haiku");
  });

  it("finds the next capability up, or nothing at the top", () => {
    const options = capabilitiesFrom(candidates);
    expect(strongerCapability("fast", options)?.tier).toBe("strong");
    expect(strongerCapability("strong", options)).toBeUndefined();
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
      id: "codex:balanced",
      adapter: "codex",
      model: "std-model",
      description: "std",
      tier: "balanced",
      source: "config",
      reasoningEffort: "high",
    },
    {
      id: "codex:strong",
      adapter: "codex",
      model: "strong-model",
      description: "strong",
      tier: "strong",
      source: "config",
    },
  ];
  const state = {
    userGoal: "OAuth",
    subtasks: [
      { id: "backend", title: "callback" },
      { id: "deploy", title: "prod deploy", irreversible: true },
    ],
  };

  it("asks capability without naming models, and resolves the pair to one candidate", async () => {
    const engine = new MockDecisionEngine({
      capability_backend: "balanced",
      judgment_backend: 0.05,
      difficulty_backend: 1,
      capability_deploy: "balanced",
      judgment_deploy: 0.05,
      difficulty_deploy: 1,
    });
    const d = await decideWorkerAssignment({ engine, thresholds }, state, catalog);
    expect(d.capabilities).toEqual(["fast", "balanced", "strong"]);
    const question = engine.requests[0]?.questions.capability_backend;
    expect(question?.type === "choice" && Object.keys(question.criteria)).toEqual([
      "fast",
      "balanced",
      "strong",
    ]);
    expect(d.assignments[0]).toMatchObject({
      capability: "balanced",
      adapter: "codex",
      candidateId: "codex:balanced",
    });
    expect(d.assignments[0]?.dispatch).toContain("codex run --model std-model --reasoning high");
    // Irreversible: same capability, Claude instead of Codex.
    expect(d.assignments[1]).toMatchObject({
      capability: "balanced",
      adapter: "claude_subagent",
      candidateId: "claude:sonnet",
    });
    expect(d.assignments[1]?.dispatch).toContain('model: "sonnet"');
    expect(d.assignments[1]?.policyNotes[0]).toMatch(/irreversible/);
  });

  it("sends judgment work to a Claude subagent only when the signal is firm", async () => {
    const firm = new MockDecisionEngine({
      capability_backend: "balanced",
      judgment_backend: 0.95,
      difficulty_backend: 1,
    });
    const one = { userGoal: "x", subtasks: [state.subtasks[0]] } as typeof state;
    const d1 = await decideWorkerAssignment({ engine: firm, thresholds }, one, catalog);
    expect(d1.assignments[0]?.adapter).toBe("claude_subagent");
    expect(d1.assignments[0]?.policyNotes[0]).toMatch(/needs judgment/);

    const unsure = new MockDecisionEngine({
      capability_backend: "balanced",
      judgment_backend: 0.65,
      difficulty_backend: 1,
    });
    const d2 = await decideWorkerAssignment({ engine: unsure, thresholds }, one, catalog);
    expect(d2.assignments[0]?.needsJudgment).toMatchObject({ yes: true, tier: "fallback" });
    expect(d2.assignments[0]?.adapter).toBe("codex");
  });

  it("upgrades a fast pick when the task is judged tricky", async () => {
    const engine = new MockDecisionEngine({
      capability_backend: "fast",
      judgment_backend: 0.05,
      difficulty_backend: 3,
    });
    const d = await decideWorkerAssignment(
      { engine, thresholds },
      { userGoal: "x", task: { id: "backend", title: "t" } },
      catalog,
    );
    expect(d.assignments[0]).toMatchObject({
      capability: "strong",
      candidateId: "codex:strong",
      confidence: 1,
    });
    expect(d.assignments[0]?.policyNotes[0]).toMatch(/too high for a fast worker/);
  });

  it("falls back to Claude when Codex is unavailable, and fails without candidates", async () => {
    const engine = new MockDecisionEngine({
      capability_backend: "balanced",
      judgment_backend: 0.05,
      difficulty_backend: 1,
    });
    const d = await decideWorkerAssignment(
      { engine, thresholds },
      { userGoal: "x", subtasks: [state.subtasks[0]], codexAvailable: false } as typeof state,
      catalog,
    );
    expect(d.assignments[0]).toMatchObject({
      adapter: "claude_subagent",
      candidateId: "claude:sonnet",
    });
    expect(d.assignments[0]?.policyNotes[0]).toMatch(/Codex unavailable/);
    await expect(decideWorkerAssignment({ engine, thresholds }, state, [])).rejects.toThrow(
      /No worker candidates/,
    );
    await expect(
      decideWorkerAssignment({ engine, thresholds }, { userGoal: "x" }, catalog),
    ).rejects.toThrow(/needs `task` or `subtasks`/);
  });
});
