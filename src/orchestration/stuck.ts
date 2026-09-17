import { choice, noul } from "../jev/types.js";
import {
  ask,
  buildDecision,
  type Decision,
  type DecisionContext,
  type PolicyOverride,
  signals,
} from "./decision.js";
import type { NextAction } from "./retry.js";
import { compact, type OrchestrationState } from "./state.js";

const STUCK_RUBRIC: Record<
  Extract<NextAction, "continue" | "spawn_debug_worker" | "replan" | "finish">,
  string
> = {
  continue: "Progress is still being made; give it more time.",
  spawn_debug_worker:
    "A worker is looping on the same failure; a fresh worker focused on diagnosis should take over.",
  replan: "The approach is not converging; Claude should revise the plan.",
  finish: "Stop orchestration and hand everything back to Claude.",
};

export type StuckAction = keyof typeof STUCK_RUBRIC;

export const REPEATED_FAILURE_COUNT = 3;

/** Is the workflow stuck, and what unsticks it? */
export async function detectStuckWorkflow(
  ctx: DecisionContext,
  state: OrchestrationState,
): Promise<Decision<StuckAction>> {
  const failures = state.recentFailures ?? [];
  const repeated = failures.filter((f) => (f.count ?? 1) >= REPEATED_FAILURE_COUNT);

  const projected = compact({
    userGoal: state.userGoal,
    currentPlan: state.currentPlan,
    activeWorkers: state.activeWorkers,
    recentFailures: failures,
    attempts: state.attempts,
    elapsedMinutes: state.elapsedMinutes,
    testResults: state.testResults,
  });

  const result = await ask(ctx, "stuck", projected, {
    unstick_action: choice("What should happen to get this workflow moving again?", STUCK_RUBRIC),
    stuck: noul(
      "Is this workflow stuck: repeating the same failures or idling without measurable progress?",
      {
        true: "Same failure three or more times, or long elapsed time with no new changed files or passing tests.",
        false: "Failures are changing, or recent output shows forward progress.",
      },
    ),
  });

  const sig = signals({ stuck: result.answers.stuck }, ctx.thresholds);

  let forced: PolicyOverride<StuckAction> | undefined;
  if (repeated.length > 0 && result.answers.unstick_action.choice === "continue") {
    forced = {
      option: "spawn_debug_worker",
      note: `A failure repeated ${REPEATED_FAILURE_COUNT}+ times; continuing unchanged is not allowed.`,
    };
  }

  return buildDecision({
    kind: "stuck",
    answer: result.answers.unstick_action,
    thresholds: ctx.thresholds,
    signals: sig,
    forced,
    model: result.model,
    latencyMs: result.latencyMs,
  });
}
