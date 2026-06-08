// SENSE — Sensitivity Classification (SPEC-0043): the label set + the **comparator** every gate reads.
//
// This module is the single home of the sensitivity ordering (SENSE-3): a total preorder
// `restrictiveness(label) → rank` (SPEC-0043 §4) that surfacing AND the researcher egress/orient gate
// both consume — **no consumer re-implements the ordering**. It is pure + dependency-free (the load-
// bearing security unit), so it is exhaustively unit-testable in isolation.
//
// Two hard invariants (SPEC-0043 §4, D1):
//   • unknown / custom labels resolve **most-restrictive** (rank 3) — "unknown ≠ safe".
//   • `private-opinion` / `embargoed` are NOT a linear extension of `confidential`; for the egress/
//     surfacing gate they sit at rank 3 (only a `local-only` researcher or an explicit Principal
//     override may touch them). This is the gate *rank*, not the label's product meaning.
import type { EgressTier } from './researchers';

/** The default sensitivity label set that ships (SENSE-1). Custom labels are supported — the comparator
 *  treats any label not in this set as most-restrictive, so the set is a convenience, not a closed enum. */
export const SENSITIVITY_LABELS = ['shareable', 'internal', 'confidential', 'private-opinion', 'embargoed'] as const;
export type SensitivityLabel = (typeof SENSITIVITY_LABELS)[number];

/** The conservative default applied when nothing classifies a source (SENSE-2). Unknown ≠ shareable. */
export const DEFAULT_SENSITIVITY: SensitivityLabel = 'internal';

/** How a sensitivity label was assigned (SENSE-8 provenance). Signal priority: principal > classifier >
 *  connector > default (SENSE-4). Slice 1 produces `default`/`connector`/`principal`; `classifier` is Slice 2. */
export type SensitivityBy = 'default' | 'connector' | 'classifier' | 'principal';

/** The frontmatter provenance block (SPEC-0043 §7) kept beside the scalar label. `confidence` is present
 *  only for `by: classifier`; `suggested` only while a Review suggestion is open (Slice 2). */
export interface SensitivityMeta {
  by: SensitivityBy;
  confidence?: number;
  at: string;
  suggested?: string;
}

/** The most-restrictive rank — where `private-opinion`/`embargoed` and every unknown/custom label land. */
export const MOST_RESTRICTIVE_RANK = 3;

/** The §4 ranks for the known labels. Anything absent resolves to MOST_RESTRICTIVE_RANK (unknown ≠ safe). */
const RANK: Readonly<Record<string, number>> = Object.freeze({
  shareable: 0,
  internal: 1,
  confidential: 2,
  'private-opinion': MOST_RESTRICTIVE_RANK,
  embargoed: MOST_RESTRICTIVE_RANK,
});

/**
 * The comparator (SENSE-3): a label's restrictiveness rank. Higher = more restricted. A label not in the
 * known set — a custom label, a typo, a future label this build doesn't know — resolves **most-restrictive**
 * (rank 3): unknown is never treated as safe. This is the one ordering every sensitivity gate reads.
 */
export function restrictiveness(label: string): number {
  return Object.prototype.hasOwnProperty.call(RANK, label) ? RANK[label] : MOST_RESTRICTIVE_RANK;
}

/** True iff `a` is no more restricted than `b` — i.e. anywhere `b` may go, `a` may go too. */
export function isAtMostAsRestrictiveAs(a: string, b: string): boolean {
  return restrictiveness(a) <= restrictiveness(b);
}

/**
 * The most-restrictive label of a set (SENSE-6 propagation primitive — a derived artifact inherits this).
 * Ranks the inputs and returns the actual label with the highest rank (ties resolve to the first such
 * input, preserving the caller's label string). An empty set returns the conservative default (SENSE-2).
 */
export function mostRestrictive(labels: readonly string[]): string {
  let winner: string | undefined;
  let best = -1;
  for (const l of labels) {
    const r = restrictiveness(l);
    if (r > best) {
      best = r;
      winner = l;
    }
  }
  return winner ?? DEFAULT_SENSITIVITY;
}

/**
 * The SPEC-0028 D6 map (ratified 2026-06-07): the maximum KB-content rank a researcher of a given egress
 * tier may read during orient. Ordered by destination trust — a `public-web` researcher's outbound queries
 * are the least contained, so it may only read `shareable`; `local-only` never leaves the machine, so it
 * may read anything.
 */
export const TIER_MAX_ORIENT_READ_RANK: Readonly<Record<EgressTier, number>> = Object.freeze({
  'public-web': 0, // shareable only
  'internal-tenant': 2, // shareable / internal / confidential
  'local-only': MOST_RESTRICTIVE_RANK, // any (incl. private-opinion / embargoed)
});

/**
 * THE EGRESS/ORIENT GATE (SENSE-9, security-load-bearing): may a researcher on `tier` read KB content
 * labeled `sensitivity` during its warm-start orient phase (SPEC-0028 RESEARCH-22 / D6)? The same
 * comparator that protects produced outputs (SCOPE-11) protects the researcher's outbound queries — a
 * `public-web` researcher reading a `confidential` neighbor would be a leak. Custom/unknown labels are
 * most-restrictive, so a typo'd label fails CLOSED (refused), never open. Consumers call this; they do
 * not re-derive the ordering (SENSE-3).
 */
export function sensitivityAllowsOrientRead(tier: EgressTier, sensitivity: string): boolean {
  return restrictiveness(sensitivity) <= TIER_MAX_ORIENT_READ_RANK[tier];
}
