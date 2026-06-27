// SPEC-0028 RESEARCH-24 — gap-targeting coverage metric. Asserts the metric measures the REAL outcome
// (gap-bearing requests → oriented queries that reference the missing facet) and that the dead-rail
// regression (orient ignoring the gap → bare-topic queries) drops coverage to the floor, so it can't ship
// silently. The "real path" samples are built from the actual `chooseAngle` + `buildOrientedQuery`.
import { describe, it, expect } from 'vitest';
import { gapTargetingCoverage, queryTargetsGap, queryDiversity } from './gapOrientEval';
import { chooseAngle, buildOrientedQuery } from './researchOrient';
import type { ResearchRequest } from './researchers';
import type { EnrichmentGap } from './enrichGap';

const reqOf = (what: string, gap?: EnrichmentGap): ResearchRequest => ({
  id: 'r', ts: '2026-01-01T00:00:00.000Z', by: { stage: 'enrich', entityId: 'E' }, what, why: 'w', context: `person: ${what}`, dedupKey: what, ...(gap ? { gap } : {}),
});

describe('queryTargetsGap', () => {
  it('true when the query references a missing facet, false otherwise', () => {
    const gap: EnrichmentGap = { present: ['role or occupation'], missing: ['education', 'date of birth'] };
    expect(queryTargetsGap('Ada Lovelace · re Ada Lovelace: education', gap)).toBe(true);
    expect(queryTargetsGap('Ada Lovelace', gap)).toBe(false); // bare topic — the dead rail
  });
  it('false when there is no gap or no missing facet (nothing to target)', () => {
    expect(queryTargetsGap('anything', undefined)).toBe(false);
    expect(queryTargetsGap('anything education', { present: [], missing: [] })).toBe(false);
  });
});

describe('gapTargetingCoverage — anti-regression for the gap-driven orient', () => {
  it('empty input → coverage 0 (empty-denominator guard, never NaN)', () => {
    expect(gapTargetingCoverage([]).coverage).toBe(0);
  });

  it('only gap-bearing samples count toward the denominator', () => {
    const cov = gapTargetingCoverage([
      { query: 'X education', gap: { present: [], missing: ['education'] } }, // scorable + targeted
      { query: 'Y', gap: { present: ['role or occupation'], missing: [] } }, // no missing → not scored
      { query: 'Z', gap: undefined }, // no gap → not scored
    ]);
    expect(cov.total).toBe(1);
    expect(cov.targeted).toBe(1);
    expect(cov.coverage).toBe(1);
  });

  it('REAL path: oriented queries target the gap (high coverage); ignoring the gap drops it to the floor', () => {
    // The real fix path: chooseAngle steers at the missing facet → buildOrientedQuery folds it in.
    const samples = [
      { what: 'Ada Lovelace', gap: { present: ['role or occupation'], missing: ['education'] } },
      { what: 'Acme Corp', gap: { present: [], missing: ['founding date'] } },
    ].map(({ what, gap }) => {
      const req = reqOf(what, gap);
      const angle = chooseAngle(req, [], ['Some Neighbor'], [], what); // a generic neighbor is available too
      return { query: buildOrientedQuery(req, angle), gap };
    });
    expect(gapTargetingCoverage(samples).coverage).toBe(1); // every oriented query references its gap

    // The dead-rail regression: orient ignored the gap and queried the bare topic → coverage floors.
    const regressed = [
      { query: 'Ada Lovelace', gap: samples[0].gap },
      { query: 'Acme Corp', gap: samples[1].gap },
    ];
    expect(gapTargetingCoverage(regressed).coverage).toBe(0);
  });
});

describe('queryDiversity (RESEARCH-QUALITY) — the "same thing each time" metric', () => {
  it('1.0 when every query differs, 1/total when all identical, 0 on empty; case/space-normalized', () => {
    expect(queryDiversity(['a', 'b', 'c']).ratio).toBe(1);
    expect(queryDiversity(['a', 'a', 'a'])).toEqual({ total: 3, distinct: 1, ratio: 1 / 3 });
    expect(queryDiversity([]).ratio).toBe(0);
    expect(queryDiversity([' Acme ', 'acme'])).toMatchObject({ distinct: 1 }); // trimmed + lowercased
  });
});

describe('gap-driven rotation eval — successive runs on one entity diverge AND stay gap-targeted', () => {
  // The acceptance bar (Principal + QD-2): two runs on the SAME entity must yield materially DIFFERENT,
  // gap-targeted queries. Simulate successive runs of the REAL chooseAngle, accumulating the drilled angles
  // the field notebook feeds back. WITH rotation: distinct queries, each aimed at a real gap facet. The dead
  // rail (ignore the drilled set) re-issues the IDENTICAL query every run → diversity floors. Delete the
  // notDrilled filter in chooseAngle and the first assertion goes red (fails-before/passes-after).
  const gap: EnrichmentGap = { present: [], missing: ['founding date', 'headquarters or location', 'leadership'] };
  const req = reqOf('Acme Corp', gap);

  const simulateRuns = (useRotation: boolean, n: number): string[] => {
    const drilled: string[] = [];
    const queries: string[] = [];
    for (let i = 0; i < n; i++) {
      const angle = chooseAngle(req, [], [], [], undefined, useRotation ? drilled : []);
      queries.push(buildOrientedQuery(req, angle));
      if (angle) drilled.push(angle);
    }
    return queries;
  };

  it('WITH rotation: every run produces a distinct query, each targeting a gap facet', () => {
    const queries = simulateRuns(true, 3);
    expect(queryDiversity(queries).ratio).toBe(1); // materially different each run
    expect(gapTargetingCoverage(queries.map((q) => ({ query: q, gap }))).coverage).toBe(1); // each gap-targeted
  });

  it('WITHOUT rotation (the dead rail): the same query every run → diversity floors at 1/total', () => {
    const queries = simulateRuns(false, 3);
    expect(queryDiversity(queries).distinct).toBe(1);
    expect(queryDiversity(queries).ratio).toBeCloseTo(1 / 3);
  });
});
