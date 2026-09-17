import { realpathSync } from "node:fs";
import { mkdir, readdir, rm, rmdir } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { worktreeManifestFile } from "../config/paths.js";
import { dirExists, readJson, writeJson } from "../util/fs.js";
import { shortId, slugify } from "../util/id.js";
import { ensureExcluded } from "./exclude.js";
import { git, tryExecGit } from "./internal.js";

export const BRANCH_PREFIX = "jev/";
const MANIFEST_VERSION = 1;
const LOCK_SUFFIX = ".lock";
const LOCK_RETRY_MS = 50;
const LOCK_MAX_WAIT_MS = 10_000;

export interface ManagedWorktree {
  name: string;
  /** Absolute path of the worktree directory. */
  path: string;
  branch: string;
  baseRef: string;
  createdAt: string;
}

interface Manifest {
  version: number;
  worktrees: ManagedWorktree[];
}

export interface WorktreeStatus extends ManagedWorktree {
  /** Directory still exists on disk. */
  present: boolean;
  /** Git still lists it as a worktree. */
  registered: boolean;
}

export interface CleanupReport {
  removed: string[];
  pruned: string[];
  branchesDeleted: string[];
  skipped: { name: string; reason: string }[];
}

export type DirtyPolicy = "keep_dirty" | "discard_changes";
export type BranchPolicy = "keep_branch" | "delete_branch";
export type CleanupScope = "stale_only" | "all";

export interface RemoveOptions {
  dirty?: DirtyPolicy;
  branch?: BranchPolicy;
}

export interface CleanupOptions extends RemoveOptions {
  scope?: CleanupScope;
}

export interface WorktreeManagerOptions {
  /** Relative (to repo root) or absolute directory for worktrees. */
  directory: string;
}

/**
 * Creates and removes git worktrees that jev-orchestrator owns. Every
 * created worktree is recorded in `.jev/worktrees.json`; removal only ever
 * touches entries from that manifest, so user worktrees and branches are
 * never deleted. Manifest writes go through a lock so parallel `create`
 * calls do not lose entries.
 */
export class WorktreeManager {
  readonly root: string;
  readonly #directory: string;
  readonly #manifestFile: string;

  constructor(repoRoot: string, options: WorktreeManagerOptions) {
    // Canonical paths once, here: git reports canonical worktree paths, so comparisons stay plain strings.
    this.root = canonical(repoRoot);
    const directory = isAbsolute(options.directory)
      ? options.directory
      : resolve(this.root, options.directory);
    this.#directory = canonical(directory);
    this.#manifestFile = worktreeManifestFile(this.root);
  }

  get directory(): string {
    return this.#directory;
  }

  async #readManifest(): Promise<Manifest> {
    const data = await readJson<Manifest>(this.#manifestFile);
    if (!data || !Array.isArray(data.worktrees)) {
      return { version: MANIFEST_VERSION, worktrees: [] };
    }
    return data;
  }

  /** Read-modify-write under a mkdir-based lock. */
  async #updateManifest(update: (manifest: Manifest) => void): Promise<void> {
    const lockDir = `${this.#manifestFile}${LOCK_SUFFIX}`;
    const deadline = Date.now() + LOCK_MAX_WAIT_MS;
    for (;;) {
      try {
        await mkdir(lockDir, { recursive: false });
        break;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") {
          await mkdir(join(lockDir, ".."), { recursive: true });
          continue;
        }
        if ((err as NodeJS.ErrnoException).code !== "EEXIST" || Date.now() > deadline) {
          throw new Error(`Could not lock ${this.#manifestFile}: ${(err as Error).message}`);
        }
        await new Promise((r) => setTimeout(r, LOCK_RETRY_MS));
      }
    }
    try {
      const manifest = await this.#readManifest();
      update(manifest);
      await writeJson(this.#manifestFile, manifest);
    } finally {
      await rmdir(lockDir).catch(() => undefined);
    }
  }

  /** `git worktree add -b jev/<slug>-<id> <dir> <baseRef>` */
  async create(name: string, baseRef = "HEAD"): Promise<ManagedWorktree> {
    const slug = slugify(name);
    const id = shortId();
    const branch = `${BRANCH_PREFIX}${slug}-${id}`;
    const path = join(this.#directory, `${slug}-${id}`);
    await mkdir(this.#directory, { recursive: true });
    await ensureExcluded(this.root, this.#directory);
    const entry: ManagedWorktree = {
      name: `${slug}-${id}`,
      path,
      branch,
      baseRef,
      createdAt: new Date().toISOString(),
    };
    // Record first so a crash between the two steps leaves a prunable entry, never an orphan.
    await this.#updateManifest((m) => m.worktrees.push(entry));
    try {
      await git(["worktree", "add", "-b", branch, path, baseRef], this.root);
    } catch (err) {
      await this.#updateManifest((m) => {
        m.worktrees = m.worktrees.filter((w) => w.name !== entry.name);
      });
      throw err;
    }
    return entry;
  }

  async list(): Promise<WorktreeStatus[]> {
    const manifest = await this.#readManifest();
    const registered = await this.#registeredPaths();
    return Promise.all(
      manifest.worktrees.map(async (wt) => ({
        ...wt,
        present: await dirExists(wt.path),
        registered: registered.has(resolve(wt.path)),
      })),
    );
  }

  /** Paths git knows about; git already reports canonical paths, as does repoRoot(). */
  async #registeredPaths(): Promise<Set<string>> {
    const raw = await tryExecGit(["worktree", "list", "--porcelain"], this.root);
    const paths = new Set<string>();
    for (const line of (raw ?? "").split("\n")) {
      if (line.startsWith("worktree ")) {
        paths.add(resolve(line.slice("worktree ".length).trim()));
      }
    }
    return paths;
  }

  /**
   * Remove one managed worktree. Refuses names not in the manifest. Uncommitted
   * changes block removal unless `dirty: "discard_changes"`. The branch is kept
   * unless `branch: "delete_branch"`, so Codex work is never lost silently.
   */
  async remove(name: string, options: RemoveOptions = {}): Promise<{ branchDeleted: boolean }> {
    const manifest = await this.#readManifest();
    const entry = manifest.worktrees.find((w) => w.name === name);
    if (!entry) {
      throw new Error(
        `"${name}" is not a worktree managed by jev-orchestrator; refusing to remove it.`,
      );
    }
    const force = options.dirty === "discard_changes";
    const registered = (await this.#registeredPaths()).has(resolve(entry.path));
    if (registered) {
      const args = ["worktree", "remove"];
      if (force) {
        args.push("--force");
      }
      args.push(entry.path);
      await git(args, this.root);
    } else if (await dirExists(entry.path)) {
      // Git forgot it (manual prune, recreated dir): only our own directory is deleted.
      if (!force) {
        throw new Error(
          `${entry.path} is not registered with git; re-run with --force to delete the directory.`,
        );
      }
      await rm(entry.path, { recursive: true, force: true });
    }
    await tryExecGit(["worktree", "prune"], this.root);

    let branchDeleted = false;
    if (options.branch === "delete_branch" && entry.branch.startsWith(BRANCH_PREFIX)) {
      const flag = force ? "-D" : "-d";
      branchDeleted = (await tryExecGit(["branch", flag, entry.branch], this.root)) !== undefined;
    }
    await this.#updateManifest((m) => {
      m.worktrees = m.worktrees.filter((w) => w.name !== name);
    });
    return { branchDeleted };
  }

  /**
   * Remove stale entries (directory gone) and, with `scope: "all"`, every
   * managed worktree. Never touches worktrees absent from the manifest.
   */
  async cleanup(options: CleanupOptions = {}): Promise<CleanupReport> {
    const report: CleanupReport = { removed: [], pruned: [], branchesDeleted: [], skipped: [] };
    for (const wt of await this.list()) {
      const stale = !wt.present;
      if (!stale && options.scope !== "all") {
        continue;
      }
      try {
        const { branchDeleted } = await this.remove(wt.name, options);
        (stale ? report.pruned : report.removed).push(wt.name);
        if (branchDeleted) {
          report.branchesDeleted.push(wt.branch);
        }
      } catch (err) {
        report.skipped.push({ name: wt.name, reason: (err as Error).message });
      }
    }
    return report;
  }

  /** Remove the worktree directory when it is empty. Never recursive: unmanaged content stays. */
  async removeDirectoryIfEmpty(): Promise<void> {
    if (!(await dirExists(this.#directory))) {
      return;
    }
    const entries = await readdir(this.#directory);
    if (entries.length > 0) {
      return;
    }
    await rmdir(this.#directory);
  }
}

/** realpath of the deepest existing ancestor, joined with the rest. */
function canonical(path: string): string {
  const missing: string[] = [];
  let current = resolve(path);
  for (;;) {
    try {
      return join(realpathSync(current), ...missing.reverse());
    } catch {
      const parent = resolve(current, "..");
      if (parent === current) {
        return resolve(path);
      }
      missing.push(current.slice(parent.length + 1));
      current = parent;
    }
  }
}

export async function worktreesSupported(cwd: string): Promise<boolean> {
  return (await tryExecGit(["worktree", "list"], cwd)) !== undefined;
}
