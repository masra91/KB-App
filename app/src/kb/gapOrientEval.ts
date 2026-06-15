// SPEC-0028 RESEARCH-24 — gap-targeting coverage metric. The gap-driven orient (chooseAngle biases the
// outbound query toward an entity's MISSING enrichment facets) is the fix; this metric measures whether it
// actually LANDS — what fraction of gap-bearing oriented queries reference a missing facet — so a future
// prompt/decider regression back to the bare-topic query (re-chasing what we already know) turns red in the
// eval instead of shipping silently. Pure → CI-testable; mirrors `topicTagEval` and available to DEV-1's
// eval lane. The metric is over QUERIES (the egress-facing artifact), so it gates the real outcome the
// brief asks for ("query targets the gap"), not an internal intermediate.
import type { EnrichmentGap } from './enrichGap';

/** Does `query` reference any of the gap's MISSING facets (the gap-filling steer landed in the query)?
 *  Exact (case-insensitive) facet-label match — the angle folds the verbatim label, so this is precise. */
export function queryTargetsGap(query: string, gap: EnrichmentGap | undefined): boolean {
  if (!gap || gap.missing.length === 0) return false;
  const q = query.toLowerCase();
  return gap.missing.some((facet) => facet.trim().length > 0 && q.includes(facet.toLowerCase()));
}

export interface GapTargetingCoverage {
  /** Samples with a non-empty gap to target (the denominator — a sample with no missing facet can't be scored). */
  total: number;
  /** Of those, how many oriented queries actually reference a missing facet. */
  targeted: number;
  /** `targeted / total` in [0,1]; 0 when `total` is 0 (empty-denominator guard — never NaN). */
  coverage: number;
}

/**
 * Fraction of gap-bearing oriented queries that target the gap (RESEARCH-24). `samples` pairs each
 * request's resulting outbound query with the gap it carried. Only samples whose gap has ≥1 missing
 * facet count toward the denominator (a fully-covered entity has nothing to target). The dead-rail
 * regression — orient ignoring the gap and querying the bare topic — shows up as `coverage` near 0;
 * the fix lifts it off the floor. Empty input → coverage 0.
 */
export function gapTargetingCoverage(samples: readonly { query: string; gap?: EnrichmentGap }[]): GapTargetingCoverage {
  const scorable = samples.filter((s) => s.gap && s.gap.missing.length > 0);
  const total = scorable.length;
  const targeted = scorable.filter((s) => queryTargetsGap(s.query, s.gap)).length;
  return { total, targeted, coverage: total === 0 ? 0 : targeted / total };
}
