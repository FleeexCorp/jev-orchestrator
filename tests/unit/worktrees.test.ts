import { realpathSync } from "node:fs";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WorktreeManager } from "../../src/git/worktrees.js";
import { exec } from "../../src/util/exec.js";
import { initGitRepo, makeTmpDir, removeTmpDir } from "../helpers/tmp.js";

const git = async (args: string[], cwd: string) => {
  const r = await exec("git", args, { cwd });
  return r.stdout.trim();
};

describe("WorktreeManager", () => {
  let root: string;
  let mgr: WorktreeManager;

  beforeEach(async () => {
    root = await makeTmpDir();
    await initGitRepo(root);
    mgr = new WorktreeManager(root, { directory: ".jev/worktrees" });
  });

  afterEach(async () => {
    await removeTmpDir(root);
  });

  it("creates a worktree on a jev/ branch and records it", async () => {
    const wt = await mgr.create("Backend OAuth!");
    expect(wt.branch).toMatch(/^jev\/backend-oauth-[0-9a-f]{6}$/);
    expect(wt.path.startsWith(join(realpathSync(root), ".jev", "worktrees"))).toBe(true);
    expect((await stat(wt.path)).isDirectory()).toBe(true);
    expect(await git(["rev-parse", "--abbrev-ref", "HEAD"], wt.path)).toBe(wt.branch);
    const list = await mgr.list();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ name: wt.name, present: true, registered: true });
    const exclude = await readFile(join(root, ".git", "info", "exclude"), "utf8");
    expect(exclude).toContain("/.jev/");
    expect(await git(["status", "--porcelain"], root)).toBe("");
  });

  it("removes a managed worktree and keeps the branch unless asked", async () => {
    const wt = await mgr.create("frontend");
    await mgr.remove(wt.name);
    expect(await mgr.list()).toEqual([]);
    expect(await git(["branch", "--list", wt.branch], root)).toContain(wt.branch);
    const again = await mgr.create("frontend");
    const { branchDeleted } = await mgr.remove(again.name, { branch: "delete_branch" });
    expect(branchDeleted).toBe(true);
    expect(await git(["branch", "--list", again.branch], root)).toBe("");
  });

  it("refuses to remove worktrees it does not manage", async () => {
    const userWt = join(root, "..", `${root.split("/").pop()}-user-wt`);
    await exec("git", ["worktree", "add", "-b", "feature/user", userWt, "HEAD"], { cwd: root });
    await expect(mgr.remove("feature-user")).rejects.toThrow(/not a worktree managed/);
    const report = await mgr.cleanup({
      scope: "all",
      branch: "delete_branch",
      dirty: "discard_changes",
    });
    expect(report.removed).toEqual([]);
    expect((await stat(userWt)).isDirectory()).toBe(true);
    expect(await git(["branch", "--list", "feature/user"], root)).toContain("feature/user");
    await removeTmpDir(userWt);
  });

  it("cleanup prunes stale entries and --all removes the rest", async () => {
    const a = await mgr.create("a");
    const b = await mgr.create("b");
    await removeTmpDir(a.path);
    let report = await mgr.cleanup();
    expect(report.pruned).toEqual([a.name]);
    expect(report.removed).toEqual([]);
    expect((await mgr.list()).map((w) => w.name)).toEqual([b.name]);
    report = await mgr.cleanup({ scope: "all", branch: "delete_branch" });
    expect(report.removed).toEqual([b.name]);
    expect(report.branchesDeleted).toEqual([b.branch]);
    expect(await mgr.list()).toEqual([]);
  });

  it("blocks removal of a dirty worktree without --force", async () => {
    const wt = await mgr.create("dirty");
    await writeFile(join(wt.path, "tracked.txt"), "x");
    await exec("git", ["add", "tracked.txt"], { cwd: wt.path });
    const report = await mgr.cleanup({ scope: "all" });
    expect(report.skipped).toHaveLength(1);
    expect(report.skipped[0]?.name).toBe(wt.name);
    const forced = await mgr.cleanup({ scope: "all", dirty: "discard_changes" });
    expect(forced.removed).toEqual([wt.name]);
  });

  it("supports an absolute worktree directory", async () => {
    const outside = await makeTmpDir("jev wt outside ");
    await mkdir(outside, { recursive: true });
    const abs = new WorktreeManager(root, { directory: outside });
    const wt = await abs.create("x");
    expect(wt.path.startsWith(realpathSync(outside))).toBe(true);
    await abs.cleanup({ scope: "all", branch: "delete_branch" });
    await removeTmpDir(outside);
  });
});

describe("WorktreeManager robustness", () => {
  let root: string;
  let mgr: WorktreeManager;

  beforeEach(async () => {
    root = await makeTmpDir();
    await initGitRepo(root);
    mgr = new WorktreeManager(root, { directory: ".jev/worktrees" });
  });

  afterEach(async () => {
    await removeTmpDir(root);
  });

  it("records every worktree when creates run concurrently", async () => {
    const created = await Promise.all(["a", "b", "c", "d"].map((n) => mgr.create(n)));
    const names = (await mgr.list()).map((w) => w.name).sort();
    expect(names).toEqual(created.map((w) => w.name).sort());
  });

  it("rolls back the manifest entry when git refuses the worktree", async () => {
    await expect(mgr.create("x", "no-such-ref")).rejects.toThrow(/git worktree add/);
    expect(await mgr.list()).toEqual([]);
  });

  it("removes a directory git forgot only with discard_changes", async () => {
    const wt = await mgr.create("ghost");
    await exec("git", ["worktree", "remove", "--force", wt.path], { cwd: root });
    await mkdir(wt.path, { recursive: true });
    await writeFile(join(wt.path, "leftover.txt"), "x");
    const listed = await mgr.list();
    expect(listed[0]).toMatchObject({ present: true, registered: false });
    await expect(mgr.remove(wt.name)).rejects.toThrow(/not registered with git/);
    await mgr.remove(wt.name, { dirty: "discard_changes" });
    expect(await mgr.list()).toEqual([]);
    await expect(stat(wt.path)).rejects.toThrow();
  });

  it("never deletes a non-empty worktree directory", async () => {
    await mkdir(join(root, ".jev", "worktrees"), { recursive: true });
    await writeFile(join(root, ".jev", "worktrees", "user-file.txt"), "keep me");
    await mgr.removeDirectoryIfEmpty();
    expect(await readFile(join(root, ".jev", "worktrees", "user-file.txt"), "utf8")).toBe(
      "keep me",
    );
  });
});
