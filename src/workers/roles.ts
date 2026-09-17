import type { WorkerAdapterId, WorkerCandidate, WorkerTier } from "./catalog.js";

/**
 * Jev is never asked to pick a model name: vendor blurbs ("balanced agentic
 * coding model") are indistinguishable, so the distribution comes back flat.
 * It answers two narrow questions instead, capability and kind of agent, and
 * code maps the pair back to a concrete model.
 */
export interface CapabilityOption {
  tier: WorkerTier;
  /** Rubric: when to pick this capability. No vendor names. */
  description: string;
  /** Models this capability resolves to, per adapter. */
  candidates: WorkerCandidate[];
}

const TIER_RUBRIC: Record<WorkerTier, string> = {
  fast: "Cheapest and fastest, weakest judgment. Enough when the change is mechanical and fully specified: the files, the pattern to follow and the command that verifies it are all given.",
  balanced:
    "Ordinary capability at moderate cost. Enough for normal implementation inside one component, where existing code shows the conventions and tests or a build can verify the result.",
  strong:
    "Strongest judgment, most expensive. Needed only when a cheaper worker would get it wrong: unclear requirements, design trade-offs, cross-component integration, or judging someone else's change.",
};

export const TIER_ORDER: Record<WorkerTier, number> = { fast: 0, balanced: 1, strong: 2 };

/** One option per capability present in the catalog, weakest first. */
export function capabilitiesFrom(candidates: readonly WorkerCandidate[]): CapabilityOption[] {
  const groups = new Map<WorkerTier, CapabilityOption>();
  for (const candidate of candidates) {
    const existing = groups.get(candidate.tier);
    if (existing) {
      existing.candidates.push(candidate);
      continue;
    }
    groups.set(candidate.tier, {
      tier: candidate.tier,
      description: TIER_RUBRIC[candidate.tier],
      candidates: [candidate],
    });
  }
  return [...groups.values()].sort((a, b) => TIER_ORDER[a.tier] - TIER_ORDER[b.tier]);
}

/**
 * First candidate of the capability on the preferred adapter, else any
 * candidate of that capability. Catalog order decides within an adapter, so a
 * `workers.catalog` entry listed first wins.
 */
export function resolveCandidate(
  option: CapabilityOption,
  prefer: WorkerAdapterId,
): WorkerCandidate {
  const preferred = option.candidates.find((c) => c.adapter === prefer);
  const candidate = preferred ?? option.candidates[0];
  if (!candidate) {
    throw new Error(`No candidate for capability "${option.tier}".`);
  }
  return candidate;
}

/** Next capability up from `from`, if the catalog has one. */
export function strongerCapability(
  from: WorkerTier,
  options: readonly CapabilityOption[],
): CapabilityOption | undefined {
  return options.filter((o) => TIER_ORDER[o.tier] > TIER_ORDER[from]).at(-1);
}
