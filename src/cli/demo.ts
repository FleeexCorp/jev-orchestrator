import type { Command } from "commander";
import pc from "picocolors";
import { ENV } from "../config/paths.js";
import { MockDecisionEngine } from "../jev/mock.js";
import type { DecisionEngine } from "../jev/types.js";
import type { DecisionContext } from "../orchestration/decision.js";
import {
  decideExecutionStrategy,
  decideParallelization,
  decideReview,
  type OrchestrationState,
  thresholdsFromConfig,
} from "../orchestration/index.js";
import { engineFor, loadContext } from "./context.js";
import { EXIT } from "./exit-codes.js";
import { Reporter } from "./output.js";

const DEMO_MAX_WORKERS = 3;

export const DEMO_STATE: OrchestrationState = {
  userGoal:
    "Implement authentication with a NestJS backend, a React frontend and integration tests",
  currentPlan: [
    "backend: /auth/login and /auth/me endpoints with JWT",
    "frontend: login form, session store, route guard",
    "tests: Playwright login flow against both",
  ],
  repositorySummary: "pnpm monorepo: apps/api (NestJS), apps/web (React + Vite), e2e/ (Playwright)",
  subtasks: [
    { id: "backend", title: "JWT auth endpoints", files: ["apps/api/src/auth"], component: "api" },
    {
      id: "frontend",
      title: "Login form and session store",
      files: ["apps/web/src/auth"],
      component: "web",
    },
    {
      id: "tests",
      title: "Playwright login flow",
      files: ["e2e/auth"],
      dependsOn: ["backend", "frontend"],
      component: "e2e",
    },
  ],
  codexAvailable: true,
  worktreesAvailable: true,
};

const DEMO_REVIEW_STATE: OrchestrationState = {
  userGoal: DEMO_STATE.userGoal,
  task: { id: "frontend", title: "Login form and session store", files: ["apps/web/src/auth"] },
  workerResult: {
    id: "frontend",
    task: "Login form and session store",
    status: "completed",
    summary:
      "Added LoginForm, useSession hook and AuthGuard. Vitest: 14 passed. Note: API base URL hardcoded to localhost.",
    changedFiles: [
      "apps/web/src/auth/LoginForm.tsx",
      "apps/web/src/auth/useSession.ts",
      "apps/web/src/config.ts",
    ],
  },
  changedFiles: [
    "apps/web/src/auth/LoginForm.tsx",
    "apps/web/src/auth/useSession.ts",
    "apps/web/src/config.ts",
  ],
  testResults: { passed: 14, failed: 0 },
};

const MOCK_SCRIPT = {
  execution_strategy: "parallel_codex",
  trivial: 0.03,
  needs_claude_reasoning: 0.12,
  independent: 0.94,
  parallel_worthwhile: 0.9,
  codex_backend: 0.92,
  claude_backend: 0.1,
  codex_frontend: 0.88,
  claude_frontend: 0.15,
  codex_tests: 0.55,
  claude_tests: 0.7,
  review_decision: "review_with_claude",
  likely_complete: 0.86,
  scope_respected: 0.4,
  needs_claude_review: 0.78,
};

export function registerDemo(program: Command): void {
  program
    .command("demo")
    .description(
      "Show the concept on a fake task; uses Jev when a key exists, else a labelled mock",
    )
    .option("--mock", "force the offline mock engine")
    .option("--json", "machine-readable output")
    .action(async (opts: { mock?: boolean; json?: boolean }) => {
      const reporter = new Reporter({ mode: opts.json ? "json" : "verbose" });
      const ctx = await loadContext();
      let engine: DecisionEngine;
      let label: string;
      const real = opts.mock ? undefined : await engineFor(ctx);
      if (real) {
        engine = real;
        label = `TypeSafe ${ctx.config.jev.model}`;
      } else {
        engine = new MockDecisionEngine(MOCK_SCRIPT);
        label = `MOCK engine (no ${ENV.typesafeApiKey} found; these are scripted answers, not Jev)`;
      }
      const dctx: DecisionContext = { engine, thresholds: thresholdsFromConfig(ctx.config) };

      reporter.title("Jev Orchestrator demo");
      reporter.line(pc.dim(`Decision engine: ${label}`));
      reporter.line();
      reporter.line("Task:");
      reporter.line(`  ${DEMO_STATE.userGoal}`);
      for (const s of DEMO_STATE.subtasks ?? []) {
        reporter.line(`  - ${s.id}: ${s.title} (${(s.files ?? []).join(", ")})`);
      }
      reporter.line();

      try {
        const [strategy, parallel, review] = await Promise.all([
          decideExecutionStrategy(dctx, DEMO_STATE),
          decideParallelization(dctx, DEMO_STATE, DEMO_MAX_WORKERS),
          decideReview(dctx, DEMO_REVIEW_STATE),
        ]);
        if (reporter.json) {
          reporter.emitJson({ engine: engine.id, strategy, parallel, review });
          return;
        }
        reporter.decision(strategy);
        reporter.line();
        reporter.parallel(parallel);
        reporter.line();
        for (const s of parallel.subtasks.filter((x) => x.suggestedWorker === "codex")) {
          reporter.codexBlock(
            s.id,
            "would start",
            `worktree jev/${s.id}-xxxxxx  (demo: nothing is executed)`,
          );
        }
        reporter.line();
        reporter.line(pc.dim("After the frontend worker reports back:"));
        reporter.decision(review);
        reporter.line();
        reporter.line(
          pc.dim(
            "Claude now reads apps/web/src/config.ts, fixes the hardcoded URL, runs tests, and integrates.",
          ),
        );
      } catch (err) {
        reporter.fail((err as Error).message);
        process.exitCode = EXIT.jevUnavailable;
      }
    });
}
