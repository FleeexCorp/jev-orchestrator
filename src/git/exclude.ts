import { appendFile, mkdir, readFile } from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";
import { gitPath } from "./repo.js";

/**
 * Keep a top-level directory (`.jev/`) out of `git status` via
 * `.git/info/exclude`, without touching the user's .gitignore. No-op outside
 * a repository or for paths outside the root.
 */
export async function ensureExcluded(root: string, directory: string): Promise<void> {
  const excludeFile = await gitPath(root, "info/exclude");
  if (!excludeFile) {
    return;
  }
  const rel = relative(root, directory);
  if (rel.startsWith("..") || isAbsolute(rel) || rel.length === 0) {
    return;
  }
  const entry = `/${rel.split(/[\\/]/)[0]}/`;
  let current = "";
  try {
    current = await readFile(excludeFile, "utf8");
  } catch {
    await mkdir(join(excludeFile, ".."), { recursive: true });
  }
  if (current.split("\n").some((l) => l.trim() === entry)) {
    return;
  }
  await appendFile(
    excludeFile,
    `${current.endsWith("\n") || current.length === 0 ? "" : "\n"}${entry}\n`,
  );
}
