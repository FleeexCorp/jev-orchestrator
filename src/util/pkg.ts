import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const PACKAGE_NAME = "jev-orchestrator";

/** dist/cli/index.js -> dist/cli -> dist -> root is three levels; leave headroom for src/ layouts. */
const MAX_PARENT_WALK = 6;

interface PackageJson {
  name?: string;
  version?: string;
}

let cached: { root: string; version: string } | undefined;

/** Walk up from this module until the jev-orchestrator package.json is found. */
export function packageInfo(): { root: string; version: string } {
  if (cached) {
    return cached;
  }
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < MAX_PARENT_WALK; i++) {
    try {
      const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as PackageJson;
      if (pkg.name === PACKAGE_NAME) {
        cached = { root: dir, version: pkg.version ?? "0.0.0" };
        return cached;
      }
    } catch {
      /* keep walking */
    }
    dir = dirname(dir);
  }
  throw new Error("Could not locate the jev-orchestrator package root.");
}

export const skillSourceDir = (): string => join(packageInfo().root, "skill");
export const cliEntryPath = (): string => join(packageInfo().root, "dist", "cli", "index.js");
