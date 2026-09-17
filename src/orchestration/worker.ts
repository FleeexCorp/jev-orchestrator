import {
  type ChoiceAnswer,
  choice,
  type DecisionSchema,
  type NoulAnswer,
  noul,
  type ScoreAnswer,
  score,
} from "../jev/types.js";
import type { WorkerAdapterId, WorkerCandidate, WorkerTier } from "../workers/catalog.js";
import {
  type CapabilityOption,
  capabilitiesFrom,
  resolveCandidate,
  strongerCapability,
} from "../workers/roles.js";
import { ask, type DecisionContext, firmYes, type Signal, signal } from "./decision.js";
import { compact, type OrchestrationState, type Subtask } from "./state.js";
import { type ConfidenceTier, classify } from "./thresholds.js";

/** Ordered difficulty rubric; the score index is what policy reasons about. */
export const DIFFICULTY_LEVELS = [
  "Mechanical: rename, config tweak, boilerplate with an obvious pattern to copy.",
  "Routine: well-specified implementation in one component with existing tests to extend.",
  "Tricky: non-obvious logic, concurrency, tricky edge cases, or several modules touched.",
  "Reasoning-heavy: unsettled design, cross-cutting integration, or judging others' work.",
] as const;

const DIFFICULTY_TRICKY = 2;

export interface WorkerAssignment {
  taskId: string;
  title: string;
  /** Capability Jev asked for. */
  capability: WorkerTier;
  adapter: WorkerAdapterId;
  /** Catalog entry the pair resolves to, after policy. */
  candidateId: string;
  candidate: WorkerCandidate;
  /** Confidence of the capability choice. */
  confidence: number;
  tier: ConfidenceTier;
  probabilities: Record<string, number>;
  /** Yes means the task needs judgment, so a Claude subagent rather than a coding worker. */
  needsJudgment: Signal;
  /** 0..3 across DIFFICULTY_LEVELS; can land between levels. */
  difficulty: number;
  difficultyConfidence: number;
  policyNotes: string[];
  /** Exact way to dispatch this worker. */
  dispatch: string;
}

export interface WorkerDecision {
  kind: "worker";
  assignments: WorkerAssignment[];
  /** Capabilities offered to Jev, weakest first. */
  capabilities: WorkerTier[];
  model: string;
  latencyMs: number;
}

function dispatchHint(c: WorkerCandidate): string {
  if (c.adapter === "codex") {
    const effort = c.reasoningEffort ? ` --reasoning ${c.reasoningEffort}` : "";
    return `jev-orchestrator codex run --model ${c.model}${effort} --cwd <worktree> --task-file <prompt>`;
  }
  return `Agent tool with model: "${c.model}" (Claude subagent)`;
}

/** Codex is out for irreversible tasks and when it is unavailable. */
function codexAllowed(task: Pick<Subtask, "irreversible">, codexAvailable: boolean): boolean {
  return codexAvailable && task.irreversible !== true;
}

/**
 * Which worker should take each (sub)task? Three narrow questions per task in
 * one call: the capability needed (one option per tier, never a model name),
 * whether the task needs judgment rather than execution, and how difficult it
 * is. Code maps capability plus adapter back to a concrete model.
 *
 * Policy: irreversible tasks never go to Codex; a task scored tricky or harder
 * never runs on a fast-tier worker.
 */
export async function decideWorkerAssignment(
  ctx: DecisionContext,
  state: OrchestrationState,
  catalog: WorkerCandidate[],
): Promise<WorkerDecision> {
  const tasks: Subtask[] =
    state.subtasks ?? (state.task ? [{ ...state.task, id: state.task.id ?? "task" }] : []);
  if (tasks.length === 0) {
    throw new Error("Worker assignment needs `task` or `subtasks` in the state.");
  }
  const codexAvailable = state.codexAvailable ?? true;
  const pool = catalog.filter((c) => c.adapter !== "codex" || codexAvailable);
  const options = capabilitiesFrom(pool);
  if (options.length === 0) {
    throw new Error("No worker candidates available; check `workers` in config and Codex status.");
  }

  const criteria: Record<string, string> = {};
  for (const o of options) {
    criteria[o.tier] = o.description;
  }

  const questions: DecisionSchema = {};
  for (const task of tasks) {
    questions[`capability_${task.id}`] = choice(
      `What capability does a worker need to complete subtask \`subtasks[id=${task.id}]\` correctly without rework? Pick the cheapest one that suffices.`,
      criteria,
    );
    questions[`judgment_${task.id}`] = noul(
      `Does subtask \`subtasks[id=${task.id}]\` require weighing trade-offs or resolving something the specification leaves open, rather than executing a specification that is already settled?`,
      {
        true: "The worker would have to make a call the task does not answer: an interface, a product choice, or how to reconcile two components.",
        false: "What to build is settled; the work is to implement and verify it.",
      },
    );
    questions[`difficulty_${task.id}`] = score(
      `How difficult is subtask \`subtasks[id=${task.id}]\` for an autonomous coding agent?`,
      [DIFFICULTY_LEVELS[0], DIFFICULTY_LEVELS[1], DIFFICULTY_LEVELS[2], DIFFICULTY_LEVELS[3]],
    );
  }

  const projected = compact({
    userGoal: state.userGoal,
    currentPlan: state.currentPlan,
    repositorySummary: state.repositorySummary,
    subtasks: tasks.map((t) => compact({ ...t })),
  });
  const result = await ask(ctx, "worker_assignment", projected, questions);
  const answers = result.answers as Record<string, ChoiceAnswer | NoulAnswer | ScoreAnswer>;

  const assignments = tasks.map((task) =>
    assign(task, answers, options, ctx, codexAllowed(task, codexAvailable), codexAvailable),
  );

  return {
    kind: "worker",
    assignments,
    capabilities: options.map((o) => o.tier),
    model: result.model,
    latencyMs: result.latencyMs,
  };
}

function assign(
  task: Subtask,
  answers: Record<string, ChoiceAnswer | NoulAnswer | ScoreAnswer>,
  options: CapabilityOption[],
  ctx: DecisionContext,
  allowCodex: boolean,
  codexAvailable: boolean,
): WorkerAssignment {
  const pick = answers[`capability_${task.id}`];
  const judgment = answers[`judgment_${task.id}`];
  const diff = answers[`difficulty_${task.id}`];
  if (pick?.type !== "choice" || judgment?.type !== "noul" || diff?.type !== "score") {
    throw new Error(`Jev response missing worker answers for subtask ${task.id}.`);
  }
  let option = options.find((o) => o.tier === pick.choice);
  if (!option) {
    throw new Error(`Jev chose unknown capability "${pick.choice}".`);
  }

  const notes: string[] = [];
  let confidence = pick.confidence;
  const needsJudgment = signal(judgment, ctx.thresholds);

  if (diff.score >= DIFFICULTY_TRICKY && option.tier === "fast") {
    const better = strongerCapability(option.tier, options);
    if (better) {
      notes.push(
        `Difficulty ${diff.score.toFixed(1)} is too high for a fast worker; upgraded ${option.tier} to ${better.tier}.`,
      );
      option = better;
      confidence = 1;
    }
  }

  // Judgment work goes to a Claude subagent: it reasons before editing and shares Claude's context.
  const wantsClaude = firmYes(needsJudgment) || !allowCodex;
  const adapter: WorkerAdapterId = wantsClaude ? "claude_subagent" : "codex";
  if (task.irreversible === true) {
    notes.push("Task is irreversible; it stays with Claude rather than a Codex worker.");
  } else if (!codexAvailable) {
    notes.push("Codex unavailable; assigned to a Claude subagent.");
  } else if (firmYes(needsJudgment)) {
    notes.push("Task needs judgment rather than execution; assigned to a Claude subagent.");
  }

  const candidate = resolveCandidate(option, adapter);
  return {
    taskId: task.id,
    title: task.title,
    capability: option.tier,
    adapter: candidate.adapter,
    candidateId: candidate.id,
    candidate,
    confidence,
    tier: classify(confidence, ctx.thresholds),
    probabilities: pick.probabilities,
    needsJudgment,
    difficulty: diff.score,
    difficultyConfidence: diff.confidence,
    policyNotes: notes,
    dispatch: dispatchHint(candidate),
  };
}
