import { readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { exec } from "../../src/util/exec.js";
import { type FakeHome, initGitRepo, makeFakeHome, removeTmpDir } from "../helpers/tmp.js";

const CLI = join(process.cwd(), "dist", "cli", "index.js");

async function cli(args: string[], env: Record<string, string | undefined>, cwd?: string) {
  const merged: NodeJS.ProcessEnv = { ...process.env, ...env };
  delete merged.TYPESAFE_API_KEY;
  return exec(process.execPath, [CLI, ...args], { env: merged, ...(cwd ? { cwd } : {}) });
}

describe("built CLI", () => {
  let fake: FakeHome;

  beforeEach(async () => {
    fake = await makeFakeHome();
    await stat(CLI);
  });

  afterEach(async () => {
    await removeTmpDir(fake.home);
  });

  it("installs the skill globally into a fake HOME and generates a valid SKILL.md", async () => {
    const r = await cli(["install", "--scope", "global"], fake.env);
    expect(r.exitCode, r.stderr).toBe(0);
    const skillDir = join(fake.home, ".claude", "skills", "jev-orchestrator");
    const skill = await readFile(join(skillDir, "SKILL.md"), "utf8");
    expect(skill).toMatch(/^---\nname: jev-orchestrator\ndescription: >\n/);
    expect(skill).toContain("when_to_use: >");
    const skillDirVar = `${"$"}{CLAUDE_SKILL_DIR}`;
    expect(skill).toContain(`allowed-tools: Bash(${skillDirVar}/scripts/jev-orchestrator *)`);
    expect(skill).toContain(`${skillDirVar}/scripts/jev-orchestrator`);
    expect(skill).not.toContain("disable-model-invocation");

    // The generated helper runs the same CLI.
    const helper = join(skillDir, "scripts", "jev-orchestrator");
    const h = await exec(helper, ["--version"], { env: { ...process.env, HOME: fake.home } });
    expect(h.exitCode, h.stderr).toBe(0);
    expect(h.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);

    const u = await cli(["uninstall", "--scope", "global"], fake.env);
    expect(u.exitCode).toBe(0);
    await expect(stat(skillDir)).rejects.toThrow();
  });

  it("installs into a project repository", async () => {
    const repo = join(fake.home, "repo with space");
    await initGitRepo(repo).catch(async () => {
      await exec("mkdir", ["-p", repo]);
      await initGitRepo(repo);
    });
    const r = await cli(["install", "--scope", "project"], fake.env, repo);
    expect(r.exitCode, r.stderr).toBe(0);
    const skill = await readFile(
      join(repo, ".claude", "skills", "jev-orchestrator", "SKILL.md"),
      "utf8",
    );
    expect(skill).toContain("name: jev-orchestrator");
    // Nothing secret-shaped lands in the repository.
    expect(skill).not.toMatch(/TYPESAFE_API_KEY\s*=/);
  });

  it("decide --mock returns structured JSON and exits 0", async () => {
    const state = join(fake.home, "state.json");
    await writeFile(
      state,
      JSON.stringify({
        userGoal: "Implement OAuth across backend, frontend and tests",
        subtasks: [
          { id: "backend", title: "callback", files: ["api/auth"] },
          { id: "frontend", title: "button", files: ["web/auth"] },
        ],
      }),
    );
    const r = await cli(
      ["decide", "strategy", "--state-file", state, "--mock", "--json"],
      fake.env,
    );
    expect(r.exitCode, r.stderr).toBe(0);
    const parsed = JSON.parse(r.stdout);
    expect(parsed.kind).toBe("strategy");
    expect(["autonomous", "advisory", "fallback"]).toContain(parsed.tier);
    expect(typeof parsed.confidence).toBe("number");
  });

  it("decide without a key fails gracefully with exit code 3", async () => {
    const r = await cli(
      ["decide", "strategy", "--state", JSON.stringify({ userGoal: "x" })],
      fake.env,
    );
    expect(r.exitCode).toBe(3);
    expect(r.stdout + r.stderr).toMatch(/No TypeSafe API key/);
  });

  it("rejects an invalid state with a usage error", async () => {
    const r = await cli(
      ["decide", "review", "--state", JSON.stringify({ nope: 1 }), "--mock"],
      fake.env,
    );
    expect(r.exitCode).toBe(2);
  });

  it("demo --mock --json runs offline", async () => {
    const r = await cli(["demo", "--mock", "--json"], fake.env);
    expect(r.exitCode, r.stderr).toBe(0);
    const parsed = JSON.parse(r.stdout);
    expect(parsed.engine).toBe("mock");
    expect(parsed.strategy.recommendation).toBe("parallel_codex");
    expect(parsed.parallel.runInParallel).toBe(true);
  });
});

describe("built CLI error output", () => {
  let fake: FakeHome;

  beforeEach(async () => {
    fake = await makeFakeHome();
  });

  afterEach(async () => {
    await removeTmpDir(fake.home);
  });

  it("emits JSON errors in --json mode", async () => {
    const r = await cli(
      ["decide", "review", "--state", JSON.stringify({ nope: 1 }), "--mock", "--json"],
      fake.env,
    );
    expect(r.exitCode).toBe(2);
    expect(JSON.parse(r.stdout).error).toMatch(/Invalid orchestration state/);
    const noKey = await cli(
      ["decide", "strategy", "--state", JSON.stringify({ userGoal: "x" }), "--json"],
      fake.env,
    );
    expect(noKey.exitCode).toBe(3);
    expect(JSON.parse(noKey.stdout).error).toMatch(/No TypeSafe API key/);
  });

  it("rejects junk numeric options", async () => {
    const state = JSON.stringify({
      userGoal: "x",
      subtasks: [
        { id: "a", title: "a" },
        { id: "b", title: "b" },
      ],
    });
    const r = await cli(
      ["decide", "parallel", "--state", state, "--mock", "--max-workers", "zero"],
      fake.env,
    );
    expect(r.exitCode).toBe(2);
    expect(r.stdout).toMatch(/--max-workers must be an integer/);
  });

  it("runs through a symlinked bin like npm creates", async () => {
    const binDir = join(fake.home, "bin");
    await exec("mkdir", ["-p", binDir]);
    const link = join(binDir, "jev-orchestrator");
    await exec("ln", ["-s", CLI, link]);
    const r = await exec(link, ["--version"], { env: { ...process.env, HOME: fake.home } });
    expect(r.exitCode, r.stderr).toBe(0);
    expect(r.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
  });
});

describe("workers", () => {
  let fake: FakeHome;

  beforeEach(async () => {
    fake = await makeFakeHome();
  });

  afterEach(async () => {
    await removeTmpDir(fake.home);
  });

  it("lists the catalog and assigns workers with the mock engine", async () => {
    const env = { ...fake.env, CODEX_HOME: join(process.cwd(), "tests", "fixtures", "codex-home") };
    const list = await cli(["workers", "list", "--json"], env);
    expect(list.exitCode, list.stderr).toBe(0);
    const ids = (JSON.parse(list.stdout) as { id: string }[]).map((c) => c.id);
    expect(ids).toContain("claude:sonnet");

    const state = JSON.stringify({
      userGoal: "x",
      codexAvailable: false,
      subtasks: [
        { id: "a", title: "a" },
        { id: "b", title: "b" },
      ],
    });
    const r = await cli(["decide", "worker", "--state", state, "--mock", "--json"], env);
    expect(r.exitCode, r.stderr).toBe(0);
    const parsed = JSON.parse(r.stdout);
    expect(parsed.kind).toBe("worker");
    expect(parsed.assignments).toHaveLength(2);
    expect(parsed.assignments[0].candidate.adapter).toBe("claude_subagent");
  });
});

describe("session report", () => {
  let fake: FakeHome;

  beforeEach(async () => {
    fake = await makeFakeHome();
  });

  afterEach(async () => {
    await removeTmpDir(fake.home);
  });

  it("records mock decisions and reports them", async () => {
    const repo = join(fake.home, "repo");
    await exec("mkdir", ["-p", repo]);
    await initGitRepo(repo);
    const state = JSON.stringify({
      userGoal: "x",
      subtasks: [
        { id: "a", title: "a" },
        { id: "b", title: "b" },
      ],
    });
    const d1 = await cli(
      ["decide", "strategy", "--state", state, "--mock", "--session", "t1", "--json"],
      fake.env,
      repo,
    );
    expect(d1.exitCode, d1.stderr).toBe(0);
    const d2 = await cli(
      ["decide", "parallel", "--state", state, "--mock", "--session", "t1", "--json"],
      fake.env,
      repo,
    );
    expect(d2.exitCode, d2.stderr).toBe(0);
    const bad = await cli(
      [
        "decide",
        "parallel",
        "--state",
        JSON.stringify({ userGoal: "x" }),
        "--mock",
        "--session",
        "t1",
        "--json",
      ],
      fake.env,
      repo,
    );
    expect(bad.exitCode).toBe(1);

    const raw = await readFile(join(repo, ".jev", "sessions", "t1.jsonl"), "utf8");
    expect(raw.trim().split("\n")).toHaveLength(3);

    const list = await cli(["report", "--list"], fake.env, repo);
    expect(list.stdout.trim()).toBe("t1");
    const report = await cli(["report", "t1", "--json"], fake.env, repo);
    expect(report.exitCode, report.stderr).toBe(0);
    const { summary } = JSON.parse(report.stdout);
    expect(summary.decisions).toBe(3);
    expect(summary.failedDecisions).toBe(1);
    expect(summary.byKind).toEqual({ strategy: 1, parallel: 2 });
    expect(summary.mockCalls).toBe(2);
    expect(summary.estimatedCostUsd).toBe(0);
    const human = await cli(["report", "t1", "--timeline"], fake.env, repo);
    expect(human.stdout).toMatch(/Session t1/);
    expect(human.stdout).toMatch(/JEV\s+strategy/);
    const gitStatus = await exec("git", ["status", "--porcelain"], { cwd: repo });
    expect(gitStatus.stdout.trim()).toBe("");
  });
});
