import { exec, tryExec } from "../util/exec.js";

const GIT = "git";

export async function git(args: readonly string[], cwd: string): Promise<string> {
  const result = await exec(GIT, args, { cwd });
  if (result.exitCode !== 0) {
    throw new Error(
      `git ${args.join(" ")} failed: ${result.stderr.trim() || result.stdout.trim()}`,
    );
  }
  return result.stdout.trim();
}

export const tryExecGit = (args: readonly string[], cwd: string) => tryExec(GIT, args, { cwd });

export const gitVersionRaw = () => tryExec(GIT, ["--version"]);
