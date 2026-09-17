import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  detectInstallations,
  helperScript,
  installSkill,
  uninstallSkill,
} from "../../src/skill/installer.js";
import { type FakeHome, makeFakeHome, removeTmpDir } from "../helpers/tmp.js";

const sourceDir = join(process.cwd(), "skill");
const cliEntry = "/opt/some dir/jev-orchestrator/dist/cli/index.js";
const SKILL_DIR_VAR = `${"$"}{CLAUDE_SKILL_DIR}`;

describe("skill installer", () => {
  let fake: FakeHome;
  let project: string;

  beforeEach(async () => {
    fake = await makeFakeHome();
    project = join(fake.home, "my project");
    await mkdir(project, { recursive: true });
  });

  afterEach(async () => {
    await removeTmpDir(fake.home);
  });

  it("installs globally under ~/.claude/skills with a working frontmatter", async () => {
    const result = await installSkill({
      scope: "global",
      sourceDir,
      cliEntry,
      version: "0.1.0",
      env: fake.env,
    });
    expect(result.skillDir).toBe(join(fake.home, ".claude", "skills", "jev-orchestrator"));
    expect(result.updated).toBe(false);
    const skill = await readFile(result.skillFile, "utf8");
    expect(skill.startsWith("---\nname: jev-orchestrator\n")).toBe(true);
    expect(skill).toContain(`allowed-tools: Bash(${SKILL_DIR_VAR}/scripts/jev-orchestrator *)`);
    expect(skill).not.toMatch(/disable-model-invocation/);
    expect(skill).not.toMatch(/Bash\(\*\)/);
    expect(skill).not.toMatch(/context:\s*fork/);
    const mode = (await stat(result.helperScript)).mode & 0o777;
    expect(mode & 0o111).toBeTruthy();
    const helper = await readFile(result.helperScript, "utf8");
    expect(helper).toContain(`CLI="${cliEntry}"`);
    expect(helper).toContain('exec node "$CLI" "$@"');
    expect(helper).not.toMatch(/exec npx|npx --yes/);
    for (const ref of ["orchestration.md", "decisions.md", "codex-workers.md"]) {
      expect((await stat(join(result.skillDir, "references", ref))).isFile()).toBe(true);
    }
  });

  it("installs into the project .claude/skills and never writes secrets", async () => {
    const result = await installSkill({
      scope: "project",
      projectRoot: project,
      sourceDir,
      cliEntry,
      version: "0.1.0",
      env: fake.env,
    });
    expect(result.skillDir).toBe(join(project, ".claude", "skills", "jev-orchestrator"));
    const manifest = JSON.parse(
      await readFile(join(result.skillDir, ".jev-orchestrator.json"), "utf8"),
    );
    expect(manifest.scope).toBe("project");
    for (const file of [
      result.skillFile,
      result.helperScript,
      join(result.skillDir, ".jev-orchestrator.json"),
    ]) {
      const text = await readFile(file, "utf8");
      expect(text).not.toMatch(/TYPESAFE_API_KEY\s*[=:]\s*\S/);
      expect(text).not.toMatch(/sk-[a-z0-9]{10,}/i);
    }
  });

  it("updates an existing installation in place", async () => {
    const first = await installSkill({
      scope: "global",
      sourceDir,
      cliEntry,
      version: "0.1.0",
      env: fake.env,
    });
    await writeFile(first.skillFile, "stale");
    const second = await installSkill({
      scope: "global",
      sourceDir,
      cliEntry: "/new/cli.js",
      version: "0.2.0",
      env: fake.env,
    });
    expect(second.updated).toBe(true);
    expect(await readFile(second.skillFile, "utf8")).not.toBe("stale");
    expect(await readFile(second.helperScript, "utf8")).toContain("/new/cli.js");
    const installs = await detectInstallations(project, fake.env);
    expect(installs).toHaveLength(1);
    expect(installs[0]?.manifest?.version).toBe("0.2.0");
  });

  it("uninstalls only what it installed", async () => {
    await installSkill({ scope: "global", sourceDir, cliEntry, version: "0.1.0", env: fake.env });
    const removed = await uninstallSkill("global", undefined, fake.env);
    expect(removed.removed).toBe(true);
    await expect(stat(removed.skillDir)).rejects.toThrow();
    expect((await uninstallSkill("global", undefined, fake.env)).reason).toBe("not installed");

    const foreign = join(project, ".claude", "skills", "jev-orchestrator");
    await mkdir(foreign, { recursive: true });
    await writeFile(join(foreign, "SKILL.md"), "---\nname: jev-orchestrator\n---\nuser-made");
    const refused = await uninstallSkill("project", project, fake.env);
    expect(refused.removed).toBe(false);
    expect(refused.reason).toMatch(/not installed by jev-orchestrator/);
    expect(await readFile(join(foreign, "SKILL.md"), "utf8")).toContain("user-made");
  });

  it("helper script quotes paths with spaces", () => {
    const script = helperScript("/Users/me/dev perso/x/dist/cli/index.js");
    expect(script).toContain('CLI="/Users/me/dev perso/x/dist/cli/index.js"');
    expect(script).toContain("Reinstall with");
  });

  it("keeps description plus when_to_use under the 1536 character cap", async () => {
    const skill = await readFile(join(sourceDir, "SKILL.md"), "utf8");
    const front = skill.split("---")[1] ?? "";
    const grab = (key: string) => {
      const m = front.match(new RegExp(`${key}: >\\n((?:  .*\\n)+)`));
      return (m?.[1] ?? "").replace(/\n\s+/g, " ").trim();
    };
    const combined = `${grab("description")} ${grab("when_to_use")}`;
    expect(combined.length).toBeGreaterThan(200);
    expect(combined.length).toBeLessThanOrEqual(1536);
  });
});
