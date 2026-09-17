import { git, gitVersionRaw, tryExecGit } from "./internal.js";

export { git };

export async function gitVersion(): Promise<string | undefined> {
  const out = await gitVersionRaw();
  return out?.replace(/^git version\s*/, "");
}

/** Root of the main working tree (not a worktree's own root). */
export async function repoRoot(cwd: string): Promise<string | undefined> {
  const common = await tryExecGit(["rev-parse", "--path-format=absolute", "--git-common-dir"], cwd);
  if (!common) {
    return undefined;
  }
  // The common dir is `<root>/.git` for a normal repository.
  if (common.endsWith("/.git") || common.endsWith("\\.git")) {
    return common.slice(0, -"/.git".length);
  }
  return tryExecGit(["rev-parse", "--show-toplevel"], cwd);
}

/** Absolute path of a file inside the git dir, valid for submodules and worktrees too. */
export async function gitPath(cwd: string, relative: string): Promise<string | undefined> {
  return tryExecGit(["rev-parse", "--path-format=absolute", "--git-path", relative], cwd);
}

/** Files changed relative to `base` (tracked and untracked). */
export async function changedFiles(cwd: string, base = "HEAD"): Promise<string[]> {
  const diff = (await tryExecGit(["diff", "--name-only", base], cwd)) ?? "";
  const untracked = (await tryExecGit(["ls-files", "--others", "--exclude-standard"], cwd)) ?? "";
  const set = new Set<string>();
  for (const line of `${diff}\n${untracked}`.split("\n")) {
    const f = line.trim();
    if (f.length > 0) {
      set.add(f);
    }
  }
  return [...set].sort();
}
