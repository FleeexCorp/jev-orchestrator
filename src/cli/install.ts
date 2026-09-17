import type { Command } from "commander";
import { type InstallScope, installSkill, uninstallSkill } from "../skill/installer.js";
import { cliEntryPath, packageInfo, skillSourceDir } from "../util/pkg.js";
import { loadContext } from "./context.js";
import { EXIT } from "./exit-codes.js";
import { Reporter } from "./output.js";

export const INSTALL_SCOPES: InstallScope[] = ["global", "project"];

export function parseScope(value: string | undefined): InstallScope | undefined {
  if (value === undefined) {
    return undefined;
  }
  return INSTALL_SCOPES.includes(value as InstallScope) ? (value as InstallScope) : undefined;
}

/** Install or refresh the skill files at the chosen scope. */
export async function performInstall(
  scope: InstallScope,
  projectRoot: string | undefined,
  env = process.env,
) {
  return installSkill({
    scope,
    ...(projectRoot ? { projectRoot } : {}),
    sourceDir: skillSourceDir(),
    cliEntry: cliEntryPath(),
    version: packageInfo().version,
    env,
  });
}

export function registerInstall(program: Command): void {
  program
    .command("install")
    .description("Install the Claude Code skill (non-interactive)")
    .requiredOption("--scope <scope>", "global | project")
    .option("--project-root <dir>", "repository root for project scope (default: current repo)")
    .action(async (opts: { scope: string; projectRoot?: string }) => {
      const reporter = new Reporter({ mode: "normal" });
      const scope = parseScope(opts.scope);
      if (!scope) {
        reporter.fail(`--scope must be one of: ${INSTALL_SCOPES.join(", ")}`);
        process.exitCode = EXIT.usage;
        return;
      }
      const ctx = await loadContext();
      const projectRoot =
        opts.projectRoot ?? ctx.projectRoot ?? (scope === "project" ? ctx.cwd : undefined);
      const result = await performInstall(scope, projectRoot);
      reporter.ok(`${result.updated ? "Updated" : "Installed"} ${result.skillFile}`);
      reporter.info(`helper ${result.helperScript}`);
    });

  program
    .command("uninstall")
    .description("Remove the Claude Code skill installed by jev-orchestrator")
    .requiredOption("--scope <scope>", "global | project")
    .option("--project-root <dir>", "repository root for project scope")
    .action(async (opts: { scope: string; projectRoot?: string }) => {
      const reporter = new Reporter({ mode: "normal" });
      const scope = parseScope(opts.scope);
      if (!scope) {
        reporter.fail(`--scope must be one of: ${INSTALL_SCOPES.join(", ")}`);
        process.exitCode = EXIT.usage;
        return;
      }
      const ctx = await loadContext();
      const projectRoot = opts.projectRoot ?? ctx.projectRoot ?? ctx.cwd;
      const result = await uninstallSkill(scope, projectRoot);
      if (result.removed) {
        reporter.ok(`Removed ${result.skillDir}`);
        return;
      }
      reporter.warn(`Nothing removed: ${result.reason}`);
      process.exitCode = result.reason === "not installed" ? EXIT.ok : EXIT.error;
    });
}
