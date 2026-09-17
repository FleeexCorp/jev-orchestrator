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
import { compact, type OrchestrationState } from "./state.js";

export const REVIEW_DECISIONS = ["accept", "review_with_claude", "retry", "reject"] as const;

export type ReviewDecision = (typeof REVIEW_DECISIONS)[number];

const REVIEW_RUBRIC: Record<ReviewDecision, string> = {
  accept:
    "Result matches scope, tests pass, changes are where expected; Claude can integrate with a light skim.",
  review_with_claude:
    "Result is plausible but touches sensitive areas, has unexplained changes, or lacks test evidence; Claude must read the diff.",
  retry:
    "Result is incomplete or off-scope in a fixable way; re-run the worker with a tightened prompt.",
  reject: "Result is wrong, harmful, or far outside scope; discard it and replan.",
};

const SENSITIVE_PATH_PATTERNS = [
  /(^|\/)\.env/i,
  /(^|\/)\.github\//i,
  /(^|\/)(package|pnpm-lock|yarn\.lock|package-lock)\.(json|yaml)$/i,
  /(^|\/)(Dockerfile|docker-compose)/i,
  /(^|\/)\.claude\//i,
  /(^|\/)\.jev\//i,
  /migrations?\//i,
  /secrets?/i,
  /(^|\/)infra\//i,
];

function matchesScope(file: string, scope: readonly string[]): boolean {
  return scope.some((s) => file === s || file.startsWith(s.endsWith("/") ? s : `${s}/`));
}

/** Files changed outside the declared task scope, and sensitive files touched. */
export function auditChangedFiles(
  changed: readonly string[],
  scope: readonly string[] | undefined,
): { outOfScope: string[]; sensitive: string[] } {
  const outOfScope =
    scope && scope.length > 0 ? changed.filter((f) => !matchesScope(f, scope)) : [];
  const sensitive = changed.filter((f) => SENSITIVE_PATH_PATTERNS.some((re) => re.test(f)));
  return { outOfScope, sensitive };
}

/**
 * Should Claude read this worker output, accept it, or send it back? Code
 * audits the changed files first; Jev judges completeness and scope.
 */
export async function decideReview(
  ctx: DecisionContext,
  state: OrchestrationState,
): Promise<Decision<ReviewDecision>> {
  const changed = state.changedFiles ?? state.workerResult?.changedFiles ?? [];
  const scope = state.task?.files;
  const audit = auditChangedFiles(changed, scope);
  const failing = hasFailures(state.testResults, state.buildResults);
  const unverified = state.testResults === undefined && state.buildResults === undefined;

  const projected = compact({
    userGoal: state.userGoal,
    task: state.task,
    workerResult: state.workerResult,
    changedFiles: changed,
    outOfScopeFiles: audit.outOfScope,
    sensitiveFiles: audit.sensitive,
    testResults: state.testResults,
    buildResults: state.buildResults,
    verificationRun: !unverified,
  });

  const result = await ask(ctx, "review", projected, {
    review_decision: choice("How should this worker result be handled?", REVIEW_RUBRIC),
    likely_complete: noul("Did the worker most likely complete its assigned scope?", {
      true: "Summary and changed files cover the task; no stated remaining work.",
      false: "Parts are missing, deferred, or the worker reports open concerns.",
    }),
    scope_respected: noul(
      "Did the worker stay within its assigned scope and avoid unrelated changes?",
    ),
    needs_claude_review: noul(
      "Does this result need Claude to read the actual diff before integration (semantic risk, cross-component impact, unclear summary)?",
    ),
  });

  const sig = signals(
    {
      likely_complete: result.answers.likely_complete,
      scope_respected: result.answers.scope_respected,
      needs_claude_review: result.answers.needs_claude_review,
    },
    ctx.thresholds,
  );

  const accepted = result.answers.review_decision.choice === "accept";
  let forced: PolicyOverride<ReviewDecision> | undefined;
  if (state.task?.irreversible) {
    forced = {
      option: "review_with_claude",
      note: "Task is marked irreversible; Claude must review before anything is applied.",
    };
  } else if (audit.sensitive.length > 0) {
    forced = {
      option: "review_with_claude",
      note: `Sensitive files changed (${audit.sensitive.join(", ")}); Claude must review.`,
    };
  } else if (audit.outOfScope.length > 0 && accepted) {
    forced = {
      option: "review_with_claude",
      note: `Files outside declared scope changed (${audit.outOfScope.join(", ")}); accept is not allowed blind.`,
    };
  } else if (failing && accepted) {
    forced = {
      option: "review_with_claude",
      note: "Tests or build are failing; accept is not allowed.",
    };
  } else if (unverified && accepted) {
    forced = {
      option: "review_with_claude",
      note: "No test or build results were provided; accept requires verification.",
    };
  }

  return buildDecision({
    kind: "review",
    answer: result.answers.review_decision,
    thresholds: ctx.thresholds,
    signals: sig,
    forced,
    model: result.model,
    latencyMs: result.latencyMs,
  });
}
