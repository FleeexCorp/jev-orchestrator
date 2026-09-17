import { type DecisionSchema, type NoulAnswer, noul } from "../jev/types.js";
import { ask, type DecisionContext, type Signal, signal } from "./decision.js";
import { compact, type OrchestrationState, type Subtask } from "./state.js";
import type { ConfidenceTier } from "./thresholds.js";
import { classify, noulCertainty } from "./thresholds.js";

export interface SubtaskAssessment {
  id: string;
  title: string;
  /** Good fit for a narrowly scoped Codex worker. */
  codexSuitable: Signal;
  /** Needs Claude-level judgment; keep with Claude or a Claude subagent. */
  needsClaude: Signal;
  /** Suggested owner after code policy. */
  suggestedWorker: "codex" | "claude";
}

export interface ParallelizationDecision {
  kind: "parallel";
  independent: Signal;
  worthwhile: Signal;
  /** True when Jev says independent and worthwhile, and at least two Codex workers are possible. */
  runInParallel: boolean;
  tier: ConfidenceTier;
  confidence: number;
  /** Codex workers to dispatch at once: 0 or 1 when not parallel, else capped by config. */
  recommendedWorkers: number;
  subtasks: SubtaskAssessment[];
  policyNotes: string[];
  guidance: string;
  model: string;
  latencyMs: number;
}

const MIN_SUBTASKS_FOR_PARALLEL = 2;
const MIN_WORKERS_FOR_PARALLEL = 2;

function overlappingFiles(subtasks: Subtask[]): string[] {
  const seen = new Map<string, string>();
  const overlaps = new Set<string>();
  for (const subtask of subtasks) {
    for (const file of subtask.files ?? []) {
      const owner = seen.get(file);
      if (owner && owner !== subtask.id) {
        overlaps.add(file);
      }
      seen.set(file, subtask.id);
    }
  }
  return [...overlaps];
}

/**
 * Can these subtasks run independently, in parallel, and which ones suit a
 * Codex worker? One request, one pair of nouls per subtask (speculative
 * fan-out), plus two nouls for the set as a whole.
 */
export async function decideParallelization(
  ctx: DecisionContext,
  state: OrchestrationState,
  maxParallelWorkers: number,
): Promise<ParallelizationDecision> {
  const subtasks = state.subtasks ?? [];
  if (subtasks.length < MIN_SUBTASKS_FOR_PARALLEL) {
    throw new Error(`Parallelization needs at least ${MIN_SUBTASKS_FOR_PARALLEL} subtasks.`);
  }
  if (!Number.isInteger(maxParallelWorkers) || maxParallelWorkers < 1) {
    throw new Error("maxParallelWorkers must be an integer >= 1.");
  }
  const notes: string[] = [];
  const declaredOverlap = overlappingFiles(subtasks);
  const hasDependencies = subtasks.some((s) => (s.dependsOn ?? []).length > 0);

  const questions: DecisionSchema = {
    independent: noul(
      "Can the listed subtasks be implemented independently, each by a separate worker, without editing the same files or waiting on one another?",
      {
        true: "Disjoint files and no ordering constraints between them.",
        false:
          "They share files, one depends on another's output, or interfaces between them are undefined.",
      },
    ),
    parallel_worthwhile: noul(
      "Is running these subtasks in parallel worth the coordination and integration cost compared with doing them sequentially?",
      {
        true: "Each subtask is substantial and clearly specified; integration is straightforward.",
        false:
          "Subtasks are small, or integrating separate results would cost more than the time saved.",
      },
    ),
  };
  for (const subtask of subtasks) {
    questions[`codex_${subtask.id}`] = noul(
      `Is subtask \`subtasks[id=${subtask.id}]\` a good task for a Codex coding worker: narrowly scoped, concretely specified, verifiable by tests or build, and not requiring product or architecture judgment?`,
    );
    questions[`claude_${subtask.id}`] = noul(
      `Does subtask \`subtasks[id=${subtask.id}]\` require Claude-level reasoning (ambiguity, design trade-offs, cross-cutting integration, or reviewing others' work)?`,
    );
  }

  const projected = compact({
    userGoal: state.userGoal,
    currentPlan: state.currentPlan,
    repositorySummary: state.repositorySummary,
    subtasks: subtasks.map((s) => compact({ ...s })),
    declaredFileOverlap: declaredOverlap,
    hasDeclaredDependencies: hasDependencies,
  });

  const result = await ask(ctx, "parallelization", projected, questions);
  const answers = result.answers as Record<string, NoulAnswer>;
  const independentAnswer = answers.independent;
  const worthwhileAnswer = answers.parallel_worthwhile;
  if (!independentAnswer || !worthwhileAnswer) {
    throw new Error("Jev response missing parallelization answers.");
  }
  const independent = signal(independentAnswer, ctx.thresholds);
  const worthwhile = signal(worthwhileAnswer, ctx.thresholds);

  const assessments: SubtaskAssessment[] = subtasks.map((s) => {
    const codex = answers[`codex_${s.id}`];
    const claude = answers[`claude_${s.id}`];
    if (!codex || !claude) {
      throw new Error(`Jev response missing answers for subtask ${s.id}.`);
    }
    const codexSuitable = signal(codex, ctx.thresholds);
    const needsClaude = signal(claude, ctx.thresholds);
    const suggestedWorker = needsClaude.yes || !codexSuitable.yes ? "claude" : "codex";
    return { id: s.id, title: s.title, codexSuitable, needsClaude, suggestedWorker };
  });

  const codexCount = assessments.filter((a) => a.suggestedWorker === "codex").length;
  let runInParallel = independent.yes && worthwhile.yes && codexCount >= MIN_WORKERS_FOR_PARALLEL;
  if (independent.yes && worthwhile.yes && codexCount < MIN_WORKERS_FOR_PARALLEL) {
    notes.push(`Only ${codexCount} subtask(s) suit a Codex worker; nothing to run in parallel.`);
  }
  if (declaredOverlap.length > 0) {
    runInParallel = false;
    notes.push(
      `Subtasks declare overlapping files (${declaredOverlap.join(", ")}); parallel writes are unsafe.`,
    );
  }
  if (!(state.worktreesAvailable ?? true) && runInParallel) {
    runInParallel = false;
    notes.push("Worktrees unavailable; multiple write workers cannot share one working tree.");
  }
  if (hasDependencies) {
    notes.push("Some subtasks declare dependencies; run dependents after their prerequisites.");
  }
  const recommendedWorkers = runInParallel
    ? Math.min(codexCount, maxParallelWorkers)
    : Math.min(1, codexCount);
  if (runInParallel && codexCount > maxParallelWorkers) {
    notes.push(`Capped at ${maxParallelWorkers} parallel workers by config.`);
  }

  const confidence = Math.min(
    noulCertainty(independent.probability),
    noulCertainty(worthwhile.probability),
  );
  const tier = classify(confidence, ctx.thresholds);
  const guidance = runInParallel
    ? `Run ${recommendedWorkers} Codex worker(s) in isolated worktrees; keep Claude-flagged subtasks with Claude.`
    : "Run subtasks sequentially or keep them with Claude; parallel dispatch is not recommended.";

  return {
    kind: "parallel",
    independent,
    worthwhile,
    runInParallel,
    tier,
    confidence,
    recommendedWorkers,
    subtasks: assessments,
    policyNotes: notes,
    guidance,
    model: result.model,
    latencyMs: result.latencyMs,
  };
}
