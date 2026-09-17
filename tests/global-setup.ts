import { exec } from "../src/util/exec.js";

/** Integration tests spawn the built CLI, so build once before the run. */
export default async function setup(): Promise<void> {
  const result = await exec("pnpm", ["build"], { cwd: process.cwd() });
  if (result.exitCode !== 0) {
    throw new Error(`build failed before tests:\n${result.stderr}`);
  }
}
