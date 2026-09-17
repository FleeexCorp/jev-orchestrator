import type {
  ChoiceAnswer,
  DecisionEngine,
  DecisionSchema,
  DecisionState,
  NoulAnswer,
} from "../jev/types.js";
import {
  type ConfidenceTier,
  classify,
  noulCertainty,
  noulYes,
  type Thresholds,
} from "./thresholds.js";

export type DecisionKind =
  | "strategy"
  | "parallel"
  | "worker"
  | "retry"
  | "review"
  | "completion"
  | "stuck";

export interface Signal {
  probability: number;
  yes: boolean;
  tier: ConfidenceTier;
}

/** A code-level rule that overrides the model's top option. */
export interface PolicyOverride<Option extends string> {
  option: Option;
  note: string;
}

/** Normalised output of every orchestration decision. */
export interface Decision<Option extends string = string> {
  kind: DecisionKind;
  /** Top option after code-level policy has been applied. */
  recommendation: Option;
  confidence: number;
  tier: ConfidenceTier;
  probabilities: Record<string, number>;
  /** Independent yes/no judgments asked alongside the main choice. */
  signals: Record<string, Signal>;
  /** Plain-language notes on what code policy changed and why. */
  policyNotes: string[];
  /** One line telling Claude what to do with this decision. */
  guidance: string;
  model: string;
  latencyMs: number;
}

export interface DecisionContext {
  engine: DecisionEngine;
  thresholds: Thresholds;
}

export function ask<T extends DecisionSchema>(
  ctx: DecisionContext,
  id: string,
  state: DecisionState,
  questions: T,
) {
  return ctx.engine.decide({ id, state, questions });
}

export function signal(answer: NoulAnswer, thresholds: Thresholds): Signal {
  return {
    probability: answer.probability,
    yes: noulYes(answer.probability),
    tier: classify(noulCertainty(answer.probability), thresholds),
  };
}

export function signals(
  answers: Record<string, NoulAnswer>,
  thresholds: Thresholds,
): Record<string, Signal> {
  const out: Record<string, Signal> = {};
  for (const [id, answer] of Object.entries(answers)) {
    out[id] = signal(answer, thresholds);
  }
  return out;
}

/** A signal is "firm" when it says yes and is at least advisory-certain; 0.5 never triggers policy. */
export const firmYes = (s: Signal | undefined): boolean => s?.yes === true && s.tier !== "fallback";

const GUIDANCE_BY_TIER: Record<ConfidenceTier, string> = {
  autonomous: "Confidence is high; you may follow this recommendation.",
  advisory: "Confidence is moderate; treat this as advice and review it before acting.",
  fallback: "Confidence is low; ignore Jev here and decide with your own reasoning.",
};

export function guidanceFor(tier: ConfidenceTier): string {
  return GUIDANCE_BY_TIER[tier];
}

export interface BuildDecisionInput<Option extends string> {
  kind: DecisionKind;
  answer: ChoiceAnswer<Option>;
  thresholds: Thresholds;
  signals?: Record<string, Signal>;
  policyNotes?: string[];
  forced?: PolicyOverride<Option> | undefined;
  model: string;
  latencyMs: number;
}

export function buildDecision<Option extends string>(
  input: BuildDecisionInput<Option>,
): Decision<Option> {
  const notes = [...(input.policyNotes ?? [])];
  let recommendation = input.answer.choice;
  let confidence = input.answer.confidence;
  if (input.forced) {
    recommendation = input.forced.option;
    confidence = 1;
    notes.push(input.forced.note);
  }
  const tier = classify(confidence, input.thresholds);
  return {
    kind: input.kind,
    recommendation,
    confidence,
    tier,
    probabilities: input.answer.probabilities,
    signals: input.signals ?? {},
    policyNotes: notes,
    guidance: input.forced ? `Policy decision: ${input.forced.note}` : guidanceFor(tier),
    model: input.model,
    latencyMs: input.latencyMs,
  };
}

/** True when any test or build report carries failures. */
export function hasFailures(...reports: ({ failed?: number | undefined } | undefined)[]): boolean {
  return reports.some((r) => (r?.failed ?? 0) > 0);
}
