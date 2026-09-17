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

export const EXECUTION_STRATEGIES = [
  "claude_direct",
  "single_codex",
  "parallel_codex",
  "claude_subagents",
  "mixed",
] as const;

export type ExecutionStrategy = (typeof EXECUTION_STRATEGIES)[number];

const STRATEGY_RUBRIC: Record<ExecutionStrategy, string> = {
  claude_direct:
    "Claude implements it directly with its own tools. Best for small, sequential, or reasoning-heavy work where delegation overhead exceeds the work itself.",
  single_codex:
    "One Codex worker takes a well-scoped implementation task while Claude reviews. Best for a self-contained coding chunk with clear acceptance criteria.",
  parallel_codex:
    "Several Codex workers implement independent components at once in isolated worktrees. Best when subtasks touch disjoint files and are each well specified.",
  claude_subagents:
    "Claude's native subagents handle parts of the work (research, read-only analysis, or edits that need Claude-level judgment). Best when subtasks need reasoning rather than raw implementation.",
  mixed:
    "Combination: Claude keeps the reasoning-heavy part and delegates well-specified implementation chunks to Codex workers.",
};

const REASONING_FORCE_THRESHOLD = 0.75;

/**
 * Should this task be delegated, and how? Three independent questions over
 * the same state: the strategy, whether the task is trivial, and whether it
 * still needs Claude-level reasoning before any delegation.
 */
export async function decideExecutionStrategy(
  ctx: DecisionContext,
  state: OrchestrationState,
): Promise<Decision<ExecutionStrategy>> {
  const codexAvailable = state.codexAvailable ?? true;
  const criteria = { ...STRATEGY_RUBRIC } as Record<ExecutionStrategy, string>;
  const notes: string[] = [];
  if (!codexAvailable) {
    delete (criteria as Partial<typeof criteria>).single_codex;
    delete (criteria as Partial<typeof criteria>).parallel_codex;
    delete (criteria as Partial<typeof criteria>).mixed;
    notes.push("Codex is unavailable; Codex strategies were not offered.");
  }

  const projected = compact({
    userGoal: state.userGoal,
    currentPlan: state.currentPlan,
    repositorySummary: state.repositorySummary,
    task: state.task,
    subtasks: state.subtasks?.map((s) =>
      compact({ id: s.id, title: s.title, files: s.files, component: s.component }),
    ),
    codexAvailable,
  });

  const result = await ask(ctx, "execution_strategy", projected, {
    execution_strategy: choice(
      "Given the goal, plan and subtasks, which execution strategy fits best? Consider separability of the work, how well specified each part is, and whether delegation overhead is worth it.",
      criteria,
    ),
    trivial: noul(
      "Can this be completed with one small, obvious change that a capable engineer would just make directly?",
      {
        true: "A single focused edit; explaining it to a worker would take longer than doing it.",
        false: "Multiple files, components, or steps are involved.",
      },
    ),
    needs_claude_reasoning: noul(
      "Does the task still need architectural decisions or ambiguity resolved before any part could be handed to an implementation worker?",
      {
        true: "Requirements or design are unsettled; a worker would have to guess.",
        false: "The plan is concrete enough that scoped implementation tasks can be written now.",
      },
    ),
  });

  const sig = signals(
    {
      trivial: result.answers.trivial,
      needs_claude_reasoning: result.answers.needs_claude_reasoning,
    },
    ctx.thresholds,
  );

  let forced: PolicyOverride<ExecutionStrategy> | undefined;
  if (state.task?.irreversible) {
    forced = {
      option: "claude_direct",
      note: "Task is marked irreversible; it stays with Claude and the user's permission rules.",
    };
  } else if (firmYes(sig.trivial)) {
    forced = {
      option: "claude_direct",
      note: "Task judged trivial; Claude should do it directly.",
    };
  } else if (result.answers.needs_claude_reasoning.probability >= REASONING_FORCE_THRESHOLD) {
    forced = {
      option: "claude_direct",
      note: "Task still needs Claude-level design decisions before delegation makes sense.",
    };
  }

  return buildDecision({
    kind: "strategy",
    answer: result.answers.execution_strategy,
    thresholds: ctx.thresholds,
    signals: sig,
    policyNotes: notes,
    forced,
    model: result.model,
    latencyMs: result.latencyMs,
  });
}
