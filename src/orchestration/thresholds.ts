import type { Config } from "../config/schema.js";

/**
 * How much weight a Jev answer carries.
 *
 *   confidence >= autonomous  -> "autonomous": orchestration may follow it
 *   fallback <= c < autonomous -> "advisory": Claude reviews before acting
 *   confidence < fallback      -> "fallback": ignore, Claude reasons itself
 */
export type ConfidenceTier = "autonomous" | "advisory" | "fallback";

export interface Thresholds {
  autonomous: number;
  fallback: number;
}

export const thresholdsFromConfig = (config: Config): Thresholds => ({
  autonomous: config.decisions.autonomousThreshold,
  fallback: config.decisions.fallbackThreshold,
});

export function classify(confidence: number, thresholds: Thresholds): ConfidenceTier {
  if (confidence >= thresholds.autonomous) {
    return "autonomous";
  }
  if (confidence >= thresholds.fallback) {
    return "advisory";
  }
  return "fallback";
}

const NOUL_MIDPOINT = 0.5;

/** A noul near 0.5 is uncertain; map |p - 0.5| onto 0..1 so it can be tiered like a choice. */
export function noulCertainty(probability: number): number {
  return Math.min(1, Math.abs(probability - NOUL_MIDPOINT) * 2);
}

export const noulYes = (probability: number): boolean => probability >= NOUL_MIDPOINT;
