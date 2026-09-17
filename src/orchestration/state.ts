import { z } from "zod";
import type { JsonObject } from "../jev/types.js";

/**
 * State Claude passes to `jev-orchestrator decide`. Every field is optional
 * so Claude sends only what a given decision needs; each decision helper
 * then projects the minimum onto the Jev request.
 */

const trimmed = z.string().trim();
const MAX_OUTPUT_CHARS = 4_000;
const MAX_SUMMARY_CHARS = 2_000;

export const subtaskSchema = z.object({
  id: trimmed.min(1),
  title: trimmed.min(1),
  description: trimmed.optional(),
  /** Files or directories this subtask is expected to touch. */
  files: z.array(trimmed).optional(),
  dependsOn: z.array(trimmed).optional(),
  component: trimmed.optional(),
  /** Deletes data, deploys, force-pushes or has external side effects: never delegated blind. */
  irreversible: z.boolean().optional(),
});

export const workerStatusSchema = z.enum(["running", "completed", "failed", "cancelled"]);

export const workerSummarySchema = z.object({
  id: trimmed.min(1),
  task: trimmed.min(1),
  status: workerStatusSchema,
  summary: trimmed.optional(),
  changedFiles: z.array(trimmed).optional(),
  exitCode: z.number().int().optional(),
  attempts: z.number().int().min(1).optional(),
  startedAt: trimmed.optional(),
  elapsedMinutes: z.number().min(0).optional(),
});

export const testResultsSchema = z.object({
  passed: z.number().int().min(0).optional(),
  failed: z.number().int().min(0).optional(),
  summary: trimmed.optional(),
  /** Truncated by the caller; keep it short. */
  output: trimmed.max(MAX_OUTPUT_CHARS).optional(),
});

export const failureSchema = z.object({
  workerId: trimmed.optional(),
  summary: trimmed.min(1),
  count: z.number().int().min(1).optional(),
});

export const orchestrationStateSchema = z
  .object({
    userGoal: trimmed.min(1),
    currentPlan: z.union([trimmed, z.array(trimmed)]).optional(),
    repositorySummary: trimmed.max(MAX_SUMMARY_CHARS).optional(),
    task: subtaskSchema.partial({ id: true }).optional(),
    subtasks: z.array(subtaskSchema).optional(),
    activeWorkers: z.array(workerSummarySchema).optional(),
    completedWorkers: z.array(workerSummarySchema).optional(),
    /** The worker result a retry/review decision is about. */
    workerResult: workerSummarySchema.optional(),
    changedFiles: z.array(trimmed).optional(),
    testResults: testResultsSchema.optional(),
    buildResults: testResultsSchema.optional(),
    recentFailures: z.array(failureSchema).optional(),
    attempts: z.number().int().min(0).optional(),
    maxAttempts: z.number().int().min(1).optional(),
    elapsedMinutes: z.number().min(0).optional(),
    codexAvailable: z.boolean().optional(),
    worktreesAvailable: z.boolean().optional(),
  })
  .strict();

export type OrchestrationState = z.infer<typeof orchestrationStateSchema>;
export type Subtask = z.infer<typeof subtaskSchema>;
export type WorkerSummary = z.infer<typeof workerSummarySchema>;

export function parseState(input: unknown): OrchestrationState {
  const result = orchestrationStateSchema.safeParse(input);
  if (result.success) {
    return result.data;
  }
  throw new Error(`Invalid orchestration state:\n${z.prettifyError(result.error)}`);
}

/** Drop undefined values so the JSON sent to Jev stays minimal. */
export function compact(obj: Record<string, unknown>): JsonObject {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (value === undefined) {
      continue;
    }
    if (Array.isArray(value) && value.length === 0) {
      continue;
    }
    out[key] = value;
  }
  return out as JsonObject;
}
