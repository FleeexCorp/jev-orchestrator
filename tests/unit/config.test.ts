import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConfigError, deepMerge, loadConfig } from "../../src/config/loader.js";
import {
  globalSkillDir,
  projectConfigFile,
  userConfigDir,
  userConfigFile,
} from "../../src/config/paths.js";
import { configSchema, defaultConfig } from "../../src/config/schema.js";
import { type FakeHome, makeFakeHome, removeTmpDir } from "../helpers/tmp.js";

describe("paths", () => {
  it("derive from HOME and honour XDG_CONFIG_HOME / CLAUDE_CONFIG_DIR", () => {
    expect(userConfigDir({ HOME: "/h" })).toBe("/h/.config/jev-orchestrator");
    expect(userConfigDir({ HOME: "/h", XDG_CONFIG_HOME: "/xdg" })).toBe("/xdg/jev-orchestrator");
    expect(globalSkillDir({ HOME: "/h" })).toBe("/h/.claude/skills/jev-orchestrator");
    expect(globalSkillDir({ HOME: "/h", CLAUDE_CONFIG_DIR: "/cc" })).toBe(
      "/cc/skills/jev-orchestrator",
    );
    expect(projectConfigFile("/p")).toBe("/p/.jev/config.json");
  });
});

describe("config schema", () => {
  it("fills every default", () => {
    const c = defaultConfig();
    expect(c.jev.model).toBe("jev-latest");
    expect(c.decisions.autonomousThreshold).toBe(0.85);
    expect(c.decisions.fallbackThreshold).toBe(0.6);
    expect(c.codex.maxParallelWorkers).toBe(3);
    expect(c.worktrees.directory).toBe(".jev/worktrees");
  });

  it("rejects fallback above autonomous and unknown keys", () => {
    expect(
      configSchema.safeParse({ decisions: { autonomousThreshold: 0.5, fallbackThreshold: 0.9 } })
        .success,
    ).toBe(false);
    expect(configSchema.safeParse({ jev: { model: "x", nope: 1 } }).success).toBe(false);
    expect(
      configSchema.safeParse({ decisions: { destructiveActionRequiresClaude: false } }).success,
    ).toBe(false);
  });

  it("deepMerge lets override win and keeps siblings", () => {
    const merged = deepMerge({ a: { x: 1, y: 2 }, b: 1 }, { a: { y: 3 }, c: 4 });
    expect(merged).toEqual({ a: { x: 1, y: 3 }, b: 1, c: 4 });
  });
});

describe("config loader", () => {
  let fake: FakeHome;
  let project: string;

  beforeEach(async () => {
    fake = await makeFakeHome();
    project = join(fake.home, "repo with space");
    await mkdir(join(project, ".jev"), { recursive: true });
  });

  afterEach(async () => {
    await removeTmpDir(fake.home);
  });

  it("returns defaults when no file exists", async () => {
    const { config, sources } = await loadConfig({ env: fake.env, projectRoot: project });
    expect(config).toEqual(defaultConfig());
    expect(sources).toEqual({});
  });

  it("reads user config", async () => {
    await mkdir(userConfigDir(fake.env), { recursive: true });
    await writeFile(
      userConfigFile(fake.env),
      JSON.stringify({ jev: { timeoutMs: 9000 }, codex: { enabled: false } }),
    );
    const { config, sources } = await loadConfig({ env: fake.env });
    expect(config.jev.timeoutMs).toBe(9000);
    expect(config.codex.enabled).toBe(false);
    expect(sources.user).toBe(userConfigFile(fake.env));
  });

  it("project config overrides user config field by field", async () => {
    await mkdir(userConfigDir(fake.env), { recursive: true });
    await writeFile(
      userConfigFile(fake.env),
      JSON.stringify({
        decisions: { autonomousThreshold: 0.9, fallbackThreshold: 0.5 },
        codex: { maxParallelWorkers: 2 },
      }),
    );
    await writeFile(
      projectConfigFile(project),
      JSON.stringify({ decisions: { autonomousThreshold: 0.95 } }),
    );
    const { config, sources } = await loadConfig({ env: fake.env, projectRoot: project });
    expect(config.decisions.autonomousThreshold).toBe(0.95);
    expect(config.decisions.fallbackThreshold).toBe(0.5);
    expect(config.codex.maxParallelWorkers).toBe(2);
    expect(sources.project).toBe(projectConfigFile(project));
  });

  it("rejects invalid JSON and invalid values with the file name", async () => {
    await writeFile(projectConfigFile(project), "{ not json");
    await expect(loadConfig({ env: fake.env, projectRoot: project })).rejects.toThrow(ConfigError);
    await writeFile(projectConfigFile(project), JSON.stringify({ jev: { timeoutMs: -1 } }));
    await expect(loadConfig({ env: fake.env, projectRoot: project })).rejects.toThrow(/timeoutMs/);
  });

  it("refuses secrets inside config files", async () => {
    await writeFile(projectConfigFile(project), JSON.stringify({ jev: { apiKey: "sk-test" } }));
    await expect(loadConfig({ env: fake.env, projectRoot: project })).rejects.toThrow(
      /looks like a secret/,
    );
  });
});
