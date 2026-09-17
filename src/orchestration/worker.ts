import {
  type ChoiceAnswer,
  choice,
  type DecisionSchema,
  type ScoreAnswer,
  score,
} from "../jev/types.js";
import type { WorkerCandidate } from "../workers/catalog.js";
import { ask, type DecisionContext } from "./decision.js";
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
const DIFFICULTY_FAST_CEILING = 1.5;

export interface WorkerAssignment {
  taskId: string;
  title: string;
  /** Catalog id chosen after policy. */
  candidateId: string;
  candidate: WorkerCandidate;
  confidence: number;
  tier: ConfidenceTier;
  probabilities: Record<string, number>;
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
  candidates: string[];
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

function eligible(
  candidates: WorkerCandidate[],
  task: Pick<Subtask, "irreversible">,
  codexAvailable: boolean,
): WorkerCandidate[] {
  return candidates.filter((c) => {
    if (c.adapter === "codex" && (!codexAvailable || task.irreversible)) {
      return false;
    }
    return true;
  });
}

/** Strongest non-fast candidate, preferring the same adapter as the model's pick. */
function upgrade(from: WorkerCandidate, pool: WorkerCandidate[]): WorkerCandidate | undefined {
  const rank = { fast: 0, balanced: 1, strong: 2 } as const;
  const better = pool.filter((c) => rank[c.tier] > rank[from.tier]);
  better.sort(
    (a, b) =>
      rank[b.tier] - rank[a.tier] ||
      Number(b.adapter === from.adapter) - Number(a.adapter === from.adapter),
  );
  return better[0];
}

/**
 * Which worker and model should take each (sub)task? One choice over the
 * catalog per task plus a difficulty score, all in one Jev call. Policy:
 * irreversible tasks never go to Codex; a tricky task never goes to a
 * fast-tier model; Claude-only when Codex is unavailable.
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
  if (catalog.length === 0) {
    throw new Error("No worker candidates available; check `workers` in config and Codex status.");
  }
  const codexAvailable = state.codexAvailable ?? true;

  const questions: DecisionSchema = {};
  const pools = new Map<string, WorkerCandidate[]>();
  for (const task of tasks) {
    const pool = eligible(catalog, task, codexAvailable);
    if (pool.length === 0) {
      throw new Error(`No eligible worker for subtask ${task.id}.`);
    }
    pools.set(task.id, pool);
    const criteria: Record<string, string> = {};
    for (const c of pool) {
      criteria[c.id] = `${c.description} (tier: ${c.tier})`;
    }
    questions[`worker_${task.id}`] = choice(
      `Which worker should implement subtask \`subtasks[id=${task.id}]\`? Match model capability to what the task needs; prefer the cheapest option that is likely to succeed without rework.`,
      criteria,
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
    codexAvailable,
  });
  const result = await ask(ctx, "worker_assignment", projected, questions);
  const answers = result.answers as Record<string, ChoiceAnswer | ScoreAnswer>;

  const assignments: WorkerAssignment[] = tasks.map((task) => {
    const pick = answers[`worker_${task.id}`];
    const diff = answers[`difficulty_${task.id}`];
    if (pick?.type !== "choice" || diff?.type !== "score") {
      throw new Error(`Jev response missing worker answers for subtask ${task.id}.`);
    }
    const pool = pools.get(task.id) ?? [];
    const notes: string[] = [];
    let candidate = pool.find((c) => c.id === pick.choice);
    if (!candidate) {
      throw new Error(`Jev chose unknown worker "${pick.choice}".`);
    }
    if (task.irreversible) {
      notes.push("Task is irreversible; Codex workers were not offered.");
    }
    if (diff.score >= DIFFICULTY_TRICKY && candidate.tier === "fast") {
      const better = upgrade(candidate, pool);
      if (better) {
        notes.push(
          `Difficulty ${diff.score.toFixed(1)} is too high for a fast-tier model; upgraded ${candidate.id} to ${better.id}.`,
        );
        candidate = better;
      }
    } else if (diff.score <= DIFFICULTY_FAST_CEILING && candidate.tier === "strong") {
      notes.push("Task looks easy for a strong-tier model; a cheaper candidate would likely do.");
    }
    return {
      taskId: task.id,
      title: task.title,
      candidateId: candidate.id,
      candidate,
      confidence: notes.some((n) => n.startsWith("Difficulty")) ? 1 : pick.confidence,
      tier: classify(pick.confidence, ctx.thresholds),
      probabilities: pick.probabilities,
      difficulty: diff.score,
      difficultyConfidence: diff.confidence,
      policyNotes: notes,
      dispatch: dispatchHint(candidate),
    };
  });

  return {
    kind: "worker",
    assignments,
    candidates: catalog.map((c) => c.id),
    model: result.model,
    latencyMs: result.latencyMs,
  };
}
