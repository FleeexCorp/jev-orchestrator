import { Command } from "commander";
import { packageInfo } from "../util/pkg.js";
import { registerCodex } from "./codex.js";
import { registerDecide } from "./decide.js";
import { registerDemo } from "./demo.js";
import { registerDoctor } from "./doctor.js";
import { EXIT } from "./exit-codes.js";
import { registerInstall } from "./install.js";
import { registerReport } from "./report.js";
import { registerSetup } from "./setup.js";
import { registerWorkers } from "./workers.js";
import { registerWorktree } from "./worktree.js";

export function buildProgram(): Command {
  const program = new Command();
  program
    .name("jev-orchestrator")
    .description("Claude reasons. Jev decides. Codex executes.")
    .version(packageInfo().version, "-V, --version")
    .showHelpAfterError()
    .configureOutput({ writeErr: (s) => process.stderr.write(s) });

  registerSetup(program);
  registerDoctor(program);
  registerInstall(program);
  registerDecide(program);
  registerCodex(program);
  registerWorktree(program);
  registerWorkers(program);
  registerReport(program);
  registerDemo(program);
  return program;
}

export async function main(argv = process.argv): Promise<void> {
  try {
    await buildProgram().parseAsync(argv);
  } catch (err) {
    process.stderr.write(`${(err as Error).message}\n`);
    process.exitCode = EXIT.error;
  }
}
