import { choice, noul } from "../jev/types.js";
import {
  ask,
  buildDecision,
  type Decision,
  type DecisionContext,
  firmYes,
  type PolicyOverride,
  signals,
} from "./decision.js";
import { compact, type OrchestrationState } from "./state.js";

export const NEXT_ACTIONS = [
  "continue",
  "review",
  "retry_same_worker",
  "spawn_debug_worker",
  "replan",
  "finish",
] as const;

export type NextAction = (typeof NEXT_ACTIONS)[number];

const NEXT_ACTION_RUBRIC: Record<NextAction, string> = {
  continue: "Nothing is blocking; move on to the next planned step.",
  review: "The output needs Claude to read it before anything else happens.",
  retry_same_worker:
    "The failure looks transient or the worker was close; give the same worker one more attempt with the same scope.",
  spawn_debug_worker:
    "A repeated or unclear failure needs a dedicated worker whose only job is to diagnose and fix it.",
  replan: "The plan itself is wrong or the scope was mis-cut; Claude should revise the plan.",
  finish: "Stop orchestrating; Claude takes over or the goal is met.",
};

export const DEFAULT_MAX_ATTEMPTS = 2;

/**
 * After a worker fails or stalls: what next? A choice plus two nouls on
 * whether the failure repeats and whether it is worth another try.
 */
export async function decideRetry(
  ctx: DecisionContext,
  state: OrchestrationState,
): Promise<Decision<NextAction>> {
  const attempts = state.attempts ?? state.workerResult?.attempts ?? 1;
  const maxAttempts = state.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const notes: string[] = [];
  const criteria = { ...NEXT_ACTION_RUBRIC } as Record<NextAction, string>;
  if (attempts >= maxAttempts) {
    delete (criteria as Partial<typeof criteria>).retry_same_worker;
    notes.push(
      `Attempt cap reached (${attempts}/${maxAttempts}); retrying the same worker was not offered.`,
    );
  }

  const projected = compact({
    userGoal: state.userGoal,
    task: state.task,
    workerResult: state.workerResult,
    recentFailures: state.recentFailures,
    testResults: state.testResults,
    buildResults: state.buildResults,
    attempts,
    maxAttempts,
  });

  const result = await ask(ctx, "retry", projected, {
    next_action: choice(
      "Given this worker outcome and failure history, what should happen next?",
      criteria,
    ),
    failure_repetitive: noul(
      "Is this the same failure recurring rather than a new or transient one?",
      {
        true: "Same error class or same failing tests as a previous attempt.",
        false: "First occurrence, or a clearly different failure, or a flaky/transient error.",
      },
    ),
    likely_transient: noul(
      "Is this failure likely transient (network, timeout, flaky test, tooling hiccup) rather than a defect in the change?",
    ),
  });

  const sig = signals(
    {
      failure_repetitive: result.answers.failure_repetitive,
      likely_transient: result.answers.likely_transient,
    },
    ctx.thresholds,
  );

  let forced: PolicyOverride<NextAction> | undefined;
  if (
    firmYes(sig.failure_repetitive) &&
    result.answers.next_action.choice === "retry_same_worker"
  ) {
    forced = {
      option: attempts >= maxAttempts ? "replan" : "spawn_debug_worker",
      note: "Failure is repetitive; blind retry of the same worker is not allowed.",
    };
  }

  return buildDecision({
    kind: "retry",
    answer: result.answers.next_action,
    thresholds: ctx.thresholds,
    signals: sig,
    policyNotes: notes,
    forced,
    model: result.model,
    latencyMs: result.latencyMs,
  });
}
