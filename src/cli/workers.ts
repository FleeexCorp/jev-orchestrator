import type { Command } from "commander";
import { codexStatus } from "../codex/status.js";
import { loadCatalog } from "../workers/catalog.js";
import { loadContext } from "./context.js";
import { modeFrom, Reporter } from "./output.js";

export function registerWorkers(program: Command): void {
  const workers = program
    .command("workers")
    .description("Worker and model catalog Jev chooses from");

  workers
    .command("list")
    .description("List worker candidates: Claude subagent aliases, Codex models, config entries")
    .option("--json", "machine-readable output")
    .action(async (opts: { json?: boolean }) => {
      const reporter = new Reporter({ mode: modeFrom(opts) });
      const ctx = await loadContext();
      const codexAvailable = ctx.config.codex.enabled && (await codexStatus()).ready;
      const catalog = await loadCatalog(ctx.config, { codexAvailable, env: ctx.env });
      if (!codexAvailable) {
        reporter.warn("Codex unavailable; Codex models are hidden.");
      }
      if (catalog.length === 0) {
        reporter.warn(
          "No candidates. Enable workers.includeClaudeModels or add entries to workers.catalog.",
        );
      }
      reporter.catalog(catalog);
    });
}
