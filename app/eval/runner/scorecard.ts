// SPEC-0042 EVAL Slice-1 — scorecard (EVAL-8). A run emits a structured scorecard (scenario × variant →
// deterministic pass/fail) + a human-readable summary. Baseline diffing + the judge-score distribution
// are Slice-2/3; Slice-1 lands the scorecard SHAPE over the deterministic checks. Pure, fork-independent.
import type { CheckResult } from './validators';

/** A scenario's (single-variant, in Slice-1) deterministic scorecard. */
export interface Scorecard {
  scenarioId: string;
  capability: string;
  /** Config variant label (EVAL-7 matrix is Slice-2; 'default' until then). */
  variant: string;
  checks: CheckResult[];
  passed: number;
  failed: number;
  total: number;
  /** True iff EVERY deterministic check passed. */
  ok: boolean;
}

/** Build a scorecard from a scenario's check results. */
export function buildScorecard(scenarioId: string, capability: string, checks: CheckResult[], variant = 'default'): Scorecard {
  const passed = checks.filter((c) => c.pass).length;
  const failed = checks.length - passed;
  return { scenarioId, capability, variant, checks, passed, failed, total: checks.length, ok: failed === 0 };
}

/** A human-readable summary (EVAL-8) — `✓/✗ check — detail` lines under a scenario header. */
export function formatScorecard(sc: Scorecard): string {
  const head = `${sc.ok ? '✓' : '✗'} ${sc.scenarioId} [${sc.capability} · ${sc.variant}] — ${sc.passed}/${sc.total} deterministic checks passed`;
  const lines = sc.checks.map((c) => `    ${c.pass ? '✓' : '✗'} ${c.check} — ${c.detail}`);
  return [head, ...lines].join('\n');
}
