// SPEC-0042 EVAL Slice-2 — scorecard with agent-judge results (EVAL-4/8). Pure — runs in CI.
import { describe, it, expect } from 'vitest';
import { buildScorecard, formatScorecard } from './scorecard';
import type { CheckResult } from './validators';
import type { JudgeResult } from './judge';

const chk = (check: string, pass: boolean): CheckResult => ({ check, pass, detail: 'd' });
const jr = (pass: boolean): JudgeResult => ({ rubric: 'is it good?', model: 'judge-m', runs: [], aggregateScore: pass ? 0.9 : 0.4, threshold: 0.8, pass });

describe('buildScorecard with judge (EVAL-4)', () => {
  it('ok requires deterministic AND judge to pass', () => {
    expect(buildScorecard('s', 'recall', [chk('a', true)], 'default', [jr(true)]).ok).toBe(true);
    expect(buildScorecard('s', 'recall', [chk('a', true)], 'default', [jr(false)]).ok).toBe(false);
    expect(buildScorecard('s', 'recall', [chk('a', false)], 'default', [jr(true)]).ok).toBe(false);
  });
  it('formatScorecard renders the judge line with score≥threshold', () => {
    const out = formatScorecard(buildScorecard('s', 'recall', [chk('a', true)], 'default', [jr(true)]));
    expect(out).toMatch(/judged/);
    expect(out).toMatch(/judge\[judge-m\] score=0\.90≥0\.8/);
  });
});
