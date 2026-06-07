// SPEC-0042 EVAL Slice-2 — baseline diff (EVAL-8). Pure/deterministic — runs in normal CI.
import { describe, it, expect } from 'vitest';
import { diffScorecards } from './baseline';
import { buildScorecard } from './scorecard';
import type { CheckResult } from './validators';

const chk = (check: string, pass: boolean): CheckResult => ({ check, pass, detail: '' });
const card = (checks: CheckResult[]) => buildScorecard('s', 'decompose', checks);

describe('diffScorecards (baseline regression/improvement deltas)', () => {
  it('a null baseline marks every check new (no regressions)', () => {
    const d = diffScorecards(card([chk('a', true), chk('b', false)]), null);
    expect(d.deltas.map((x) => x.kind)).toEqual(['new', 'new']);
    expect(d).toMatchObject({ regressions: 0, ok: true });
  });

  it('flags a pass→fail flip as a regression (ok=false) and fail→pass as an improvement', () => {
    const base = card([chk('a', true), chk('b', false)]);
    const cur = card([chk('a', false), chk('b', true)]);
    const d = diffScorecards(cur, base);
    expect(d.deltas.find((x) => x.check === 'a')).toMatchObject({ before: 'pass', after: 'fail', kind: 'regression' });
    expect(d.deltas.find((x) => x.check === 'b')).toMatchObject({ before: 'fail', after: 'pass', kind: 'improvement' });
    expect(d).toMatchObject({ regressions: 1, improvements: 1, ok: false });
  });

  it('unchanged checks are unchanged; ok=true when nothing regressed', () => {
    const base = card([chk('a', true)]);
    const d = diffScorecards(card([chk('a', true)]), base);
    expect(d.deltas[0].kind).toBe('unchanged');
    expect(d.ok).toBe(true);
  });

  it('a removed previously-PASSING check is a regression (lost coverage)', () => {
    const base = card([chk('a', true), chk('b', true)]);
    const cur = card([chk('a', true)]);
    const d = diffScorecards(cur, base);
    expect(d.deltas.find((x) => x.check === 'b')).toMatchObject({ after: 'absent', kind: 'removed' });
    expect(d).toMatchObject({ regressions: 1, ok: false });
  });
});
