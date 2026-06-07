// SPEC-0042 EVAL Slice-2 — baseline diff (EVAL-8). Compares a fresh scorecard against a stored
// last-known-good baseline and surfaces regression/improvement deltas. PURE + fork-independent (operates
// on Scorecard objects regardless of how the deterministic/judge checks were produced) — so it's unit-
// testable now and stable across the Slice-2 forks. Storage (gitignored JSON) + --update-baseline land
// in the deep build; this is the diff core.
import type { Scorecard } from './scorecard';
import type { CheckResult } from './validators';

export type CheckState = 'pass' | 'fail' | 'absent';
export type DeltaKind = 'regression' | 'improvement' | 'unchanged' | 'new' | 'removed';

/** One check's before→after across a baseline diff. */
export interface ScorecardDelta {
  check: string;
  before: CheckState;
  after: CheckState;
  kind: DeltaKind;
}

export interface BaselineDiff {
  scenarioId: string;
  variant: string;
  deltas: ScorecardDelta[];
  regressions: number;
  improvements: number;
  /** True iff no check regressed (pass→fail or present→absent of a previously-passing check). */
  ok: boolean;
}

const stateOf = (c: CheckResult | undefined): CheckState => (c === undefined ? 'absent' : c.pass ? 'pass' : 'fail');

function classify(before: CheckState, after: CheckState): DeltaKind {
  if (before === after) return 'unchanged';
  if (before === 'absent') return 'new';
  if (after === 'absent') return 'removed';
  return after === 'pass' ? 'improvement' : 'regression';
}

/**
 * Diff a current scorecard against its baseline (null baseline ⇒ every check is 'new'). Checks are keyed
 * by `index:check` (both scorecards come from the same ordered scenario), so a check that flips
 * pass→fail at its position is a REGRESSION. `ok` is false iff anything regressed (the merge/ship signal);
 * a `removed` previously-passing check also counts as a regression (lost coverage).
 */
export function diffScorecards(current: Scorecard, baseline: Scorecard | null): BaselineDiff {
  const key = (i: number, c: CheckResult): string => `${i}:${c.check}`;
  const baseByKey = new Map<string, CheckResult>();
  if (baseline) baseline.checks.forEach((c, i) => baseByKey.set(key(i, c), c));
  const seen = new Set<string>();
  const deltas: ScorecardDelta[] = [];

  current.checks.forEach((c, i) => {
    const k = key(i, c);
    seen.add(k);
    const before = stateOf(baseline ? baseByKey.get(k) : undefined);
    const after = stateOf(c);
    deltas.push({ check: c.check, before, after, kind: classify(before, after) });
  });
  // Checks present in the baseline but gone now (removed coverage).
  if (baseline) {
    baseline.checks.forEach((c, i) => {
      const k = key(i, c);
      if (seen.has(k)) return;
      deltas.push({ check: c.check, before: stateOf(c), after: 'absent', kind: classify(stateOf(c), 'absent') });
    });
  }

  const regressions = deltas.filter((d) => d.kind === 'regression' || (d.kind === 'removed' && d.before === 'pass')).length;
  const improvements = deltas.filter((d) => d.kind === 'improvement').length;
  return { scenarioId: current.scenarioId, variant: current.variant, deltas, regressions, improvements, ok: regressions === 0 };
}
