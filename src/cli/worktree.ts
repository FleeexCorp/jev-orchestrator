import type { Command } from "commander";
import { type BranchPolicy, type DirtyPolicy, WorktreeManager } from "../git/worktrees.js";
import { loadContext } from "./context.js";
import { EXIT } from "./exit-codes.js";
import { modeFrom, Reporter } from "./output.js";

const dirtyPolicy = (force: boolean | undefined): DirtyPolicy =>
  force ? "discard_changes" : "keep_dirty";
const branchPolicy = (del: boolean | undefined): BranchPolicy =>
  del ? "delete_branch" : "keep_branch";

async function manager(reporter: Reporter): Promise<WorktreeManager | undefined> {
  const ctx = await loadContext();
  if (!ctx.projectRoot) {
    reporter.fail("Not inside a git repository.");
    process.exitCode = EXIT.error;
    return undefined;
  }
  if (!ctx.config.worktrees.enabled) {
    reporter.fail("Worktrees are disabled in config (worktrees.enabled = false).");
    process.exitCode = EXIT.error;
    return undefined;
  }
  return new WorktreeManager(ctx.projectRoot, { directory: ctx.config.worktrees.directory });
}

export function registerWorktree(program: Command): void {
  const wt = program
    .command("worktree")
    .alias("wt")
    .description("Isolated git worktrees for write workers");

  wt.command("create")
    .description("Create a worktree on a new jev/<name>-<id> branch")
    .argument("<name>", "short name, e.g. backend")
    .option("--base <ref>", "base ref", "HEAD")
    .option("--json", "machine-readable output")
    .action(async (name: string, opts: { base: string; json?: boolean }) => {
      const reporter = new Reporter({ mode: modeFrom(opts) });
      const mgr = await manager(reporter);
      if (!mgr) {
        return;
      }
      try {
        const entry = await mgr.create(name, opts.base);
        if (reporter.json) {
          reporter.emitJson(entry);
          return;
        }
        reporter.ok(`${entry.name}`);
        reporter.info(`path    ${entry.path}`);
        reporter.info(`branch  ${entry.branch}`);
      } catch (err) {
        reporter.fail((err as Error).message);
        process.exitCode = EXIT.error;
      }
    });

  wt.command("list")
    .description("List worktrees managed by jev-orchestrator")
    .option("--json", "machine-readable output")
    .action(async (opts: { json?: boolean }) => {
      const reporter = new Reporter({ mode: modeFrom(opts) });
      const mgr = await manager(reporter);
      if (!mgr) {
        return;
      }
      const list = await mgr.list();
      if (reporter.json) {
        reporter.emitJson(list);
        return;
      }
      if (list.length === 0) {
        reporter.info("No managed worktrees.");
        return;
      }
      for (const w of list) {
        const state = w.present && w.registered ? "ok" : "stale";
        reporter.line(`${state.padEnd(6)} ${w.name.padEnd(24)} ${w.branch.padEnd(32)} ${w.path}`);
      }
    });

  wt.command("remove")
    .description("Remove one managed worktree (refuses unmanaged ones)")
    .argument("<name>")
    .option("--force", "discard uncommitted changes")
    .option("--delete-branch", "also delete the jev/ branch")
    .action(async (name: string, opts: { force?: boolean; deleteBranch?: boolean }) => {
      const reporter = new Reporter({ mode: "normal" });
      const mgr = await manager(reporter);
      if (!mgr) {
        return;
      }
      try {
        const { branchDeleted } = await mgr.remove(name, {
          dirty: dirtyPolicy(opts.force),
          branch: branchPolicy(opts.deleteBranch),
        });
        reporter.ok(`removed ${name}${branchDeleted ? " (branch deleted)" : ""}`);
      } catch (err) {
        reporter.fail((err as Error).message);
        process.exitCode = EXIT.error;
      }
    });

  wt.command("cleanup")
    .description("Prune stale managed worktrees; --all removes every managed worktree")
    .option("--all", "remove all managed worktrees, not only stale ones")
    .option("--force", "discard uncommitted changes")
    .option("--delete-branches", "also delete jev/ branches")
    .option("--json", "machine-readable output")
    .action(
      async (opts: {
        all?: boolean;
        force?: boolean;
        deleteBranches?: boolean;
        json?: boolean;
      }) => {
        const reporter = new Reporter({ mode: modeFrom(opts) });
        const mgr = await manager(reporter);
        if (!mgr) {
          return;
        }
        const report = await mgr.cleanup({
          scope: opts.all ? "all" : "stale_only",
          dirty: dirtyPolicy(opts.force),
          branch: branchPolicy(opts.deleteBranches),
        });
        if (opts.all && report.skipped.length === 0) {
          await mgr.removeDirectoryIfEmpty();
        }
        if (reporter.json) {
          reporter.emitJson(report);
          return;
        }
        for (const n of report.pruned) {
          reporter.ok(`pruned  ${n}`);
        }
        for (const n of report.removed) {
          reporter.ok(`removed ${n}`);
        }
        for (const b of report.branchesDeleted) {
          reporter.info(`deleted branch ${b}`);
        }
        for (const s of report.skipped) {
          reporter.warn(`skipped ${s.name}: ${s.reason}`);
        }
        if (report.pruned.length + report.removed.length + report.skipped.length === 0) {
          reporter.info("Nothing to clean.");
        }
      },
    );
}
