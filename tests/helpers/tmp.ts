import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exec } from "../../src/util/exec.js";

/** Temp dir whose name contains a space, to exercise quoting everywhere. */
export async function makeTmpDir(prefix = "jev test "): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix));
}

export async function removeTmpDir(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true });
}

export interface FakeHome {
  home: string;
  env: { HOME: string; XDG_CONFIG_HOME?: string; CLAUDE_CONFIG_DIR?: string };
}

export async function makeFakeHome(): Promise<FakeHome> {
  const home = await makeTmpDir("jev home ");
  return { home, env: { HOME: home } };
}

export async function initGitRepo(dir: string): Promise<void> {
  const run = async (args: string[]) => {
    const r = await exec("git", args, { cwd: dir });
    if (r.exitCode !== 0) {
      throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
    }
  };
  await run(["init", "-q", "-b", "main"]);
  await run(["config", "user.email", "test@example.com"]);
  await run(["config", "user.name", "Test"]);
  await run(["config", "commit.gpgsign", "false"]);
  await run(["commit", "--allow-empty", "-q", "-m", "init"]);
}
