// SPEC-0042 EVAL Slice-1 — scorecard (EVAL-8). A run emits a structured scorecard (scenario × variant →
// deterministic pass/fail) + a human-readable summary. Baseline diffing + the judge-score distribution
// are Slice-2/3; Slice-1 lands the scorecard SHAPE over the deterministic checks. Pure, fork-independent.
import type { CheckResult } from './validators';
import type { JudgeResult } from './judge';

/** A scenario's per-variant scorecard: deterministic checks (EVAL-3) + agent-judge results (EVAL-4). */
export interface Scorecard {
  scenarioId: string;
  capability: string;
  /** Config variant label (EVAL-7 matrix) — 'default' = the empty variant. */
  variant: string;
  checks: CheckResult[];
  passed: number;
  failed: number;
  total: number;
  /** Agent-judge results (EVAL-4; empty for deterministic-only scenarios). */
  judge: JudgeResult[];
  /** True iff EVERY deterministic check AND every judge rubric passed. */
  ok: boolean;
}

/** Build a scorecard from a scenario's deterministic results (+ optional judge results, Slice-2). */
export function buildScorecard(scenarioId: string, capability: string, checks: CheckResult[], variant = 'default', judge: JudgeResult[] = []): Scorecard {
  const passed = checks.filter((c) => c.pass).length;
  const failed = checks.length - passed;
  const judgeFailed = judge.filter((j) => !j.pass).length;
  return { scenarioId, capability, variant, checks, passed, failed, total: checks.length, judge, ok: failed === 0 && judgeFailed === 0 };
}

/** A human-readable summary (EVAL-8) — `✓/✗ check — detail` lines + judge rubric scores under a header. */
export function formatScorecard(sc: Scorecard): string {
  const head = `${sc.ok ? '✓' : '✗'} ${sc.scenarioId} [${sc.capability} · ${sc.variant}] — ${sc.passed}/${sc.total} deterministic${sc.judge.length ? ` · ${sc.judge.filter((j) => j.pass).length}/${sc.judge.length} judged` : ''}`;
  const det = sc.checks.map((c) => `    ${c.pass ? '✓' : '✗'} ${c.check} — ${c.detail}`);
  const jud = sc.judge.map((j) => `    ${j.pass ? '✓' : '✗'} judge[${j.model}] score=${j.aggregateScore.toFixed(2)}≥${j.threshold} — ${j.rubric}`);
  return [head, ...det, ...jud].join('\n');
}
