import { choice, noul } from "../jev/types.js";
import {
  ask,
  buildDecision,
  type Decision,
  type DecisionContext,
  hasFailures,
  type PolicyOverride,
  signals,
} from "./decision.js";
import type { NextAction } from "./retry.js";
import { compact, type OrchestrationState } from "./state.js";

const COMPLETION_RUBRIC: Record<
  Extract<NextAction, "continue" | "review" | "finish" | "replan">,
  string
> = {
  continue: "Planned work remains; keep executing.",
  review: "All workers are done; Claude should do the final semantic review and integration now.",
  finish: "Goal is met and verified; wrap up and report to the user.",
  replan: "Results show the plan does not reach the goal; revise it.",
};

export type CompletionAction = keyof typeof COMPLETION_RUBRIC;

/** Is the workflow done, and should orchestration stop? */
export async function decideCompletion(
  ctx: DecisionContext,
  state: OrchestrationState,
): Promise<Decision<CompletionAction>> {
  const active = state.activeWorkers ?? [];

  const projected = compact({
    userGoal: state.userGoal,
    currentPlan: state.currentPlan,
    activeWorkers: active.map((w) => compact({ id: w.id, task: w.task, status: w.status })),
    completedWorkers: state.completedWorkers?.map((w) =>
      compact({ id: w.id, task: w.task, status: w.status, summary: w.summary }),
    ),
    changedFiles: state.changedFiles,
    testResults: state.testResults,
    buildResults: state.buildResults,
    recentFailures: state.recentFailures,
  });

  const result = await ask(ctx, "completion", projected, {
    next_action: choice("Where does the workflow stand?", COMPLETION_RUBRIC),
    goal_satisfied: noul(
      "Do the completed results, taken together, plausibly satisfy the user's goal?",
    ),
    needs_final_review: noul(
      "Before reporting to the user, does Claude still need to run tests or read the integrated result?",
    ),
  });

  const sig = signals(
    {
      goal_satisfied: result.answers.goal_satisfied,
      needs_final_review: result.answers.needs_final_review,
    },
    ctx.thresholds,
  );

  const finishing = result.answers.next_action.choice === "finish";
  let forced: PolicyOverride<CompletionAction> | undefined;
  if (active.some((w) => w.status === "running") && finishing) {
    forced = { option: "continue", note: "Workers are still running; cannot finish yet." };
  } else if (hasFailures(state.testResults, state.buildResults) && finishing) {
    forced = { option: "review", note: "Tests or build are failing; finishing is not allowed." };
  }

  return buildDecision({
    kind: "completion",
    answer: result.answers.next_action,
    thresholds: ctx.thresholds,
    signals: sig,
    forced,
    model: result.model,
    latencyMs: result.latencyMs,
  });
}
