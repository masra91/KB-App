// SPEC-0028 RESEARCH-24 + RESEARCH-QUALITY — gap-targeting AND diversity metrics for the research orient.
// Two complementary measures over QUERIES (the egress-facing artifact), so they gate the real outcomes the
// briefs ask for, not internal intermediates:
//   - `gapTargetingCoverage` (RESEARCH-24): what fraction of gap-bearing oriented queries reference a missing
//     facet — so a regression back to the bare-topic query (re-chasing what we already know) turns red.
//   - `queryDiversity` (RESEARCH-QUALITY): across successive runs on the SAME entity, what fraction of the
//     outbound queries are distinct — so the Principal's "researchers return almost the same thing each time"
//     defect (a static per-entity query) turns red. The gap-driven facet ROTATION lifts it toward 1.0.
// High diversity AND high targeting together prove the runs are different *and* each is aimed at a real gap.
// Pure → CI-testable; mirrors `topicTagEval` and available to DEV-1's eval lane.
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

export interface QueryDiversity {
  /** Total non-empty queries in the run sequence (the denominator). */
  total: number;
  /** How many are distinct (case-insensitive, trimmed). */
  distinct: number;
  /** `distinct / total` in [0,1]; 0 when `total` is 0. 1.0 = every run produced a different query. */
  ratio: number;
}

/**
 * Diversity of a sequence of outbound queries for the SAME entity across successive research runs
 * (RESEARCH-QUALITY). The Principal's core defect — "researchers return almost the same thing each time" —
 * is a DIVERSITY failure: a static per-entity query re-issued every pass. This measures the fraction of
 * distinct queries; the gap-driven facet rotation lifts it toward 1.0, while the dead-rail regression (no
 * rotation → the same query every run) floors it at `1/total`. Pair with {@link gapTargetingCoverage}: high
 * diversity AND high targeting together prove the runs are different *and* each is aimed at a real gap.
 */
export function queryDiversity(queries: readonly string[]): QueryDiversity {
  const norm = queries.map((q) => q.trim().toLowerCase()).filter((q) => q.length > 0);
  const distinct = new Set(norm).size;
  return { total: norm.length, distinct, ratio: norm.length === 0 ? 0 : distinct / norm.length };
}
