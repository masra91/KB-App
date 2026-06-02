// Unit tests for the enrich-quality eval SCORING logic (DECOMP-17 behavioral close). The scoring is
// pure + deterministic, so it's CI-tested here with synthetic decompose decisions; the LLM RUN that
// produces real decisions is the opt-in `eval/enrichQuality.eval.ts` (needs a BYOA copilot).
import { describe, it, expect } from 'vitest';
import { evaluateGranularity, aggregateRuns, formatAggregate, type GranularityFixture } from './enrichEval';
import type { DecomposeDecision, EntityDecision } from './decompose';

const ent = (name: string, kind = 'concept'): EntityDecision => ({ kind, name, confidence: 0.9, mentions: [name] });
const decision = (names: string[]): DecomposeDecision => ({ sourceId: '01S', entities: names.map((n) => ent(n)) });

// The dogfood headline fixture: 2 sentences that used to yield 6 nodes.
const ada: GranularityFixture = {
  name: 'ada-lovelace-bio',
  sourceText:
    'Ada Lovelace worked with Charles Babbage on the Analytical Engine. She is regarded as the first computer programmer.',
  mustBeNodes: ['Ada Lovelace', 'Charles Babbage'],
  mustNotBeNodes: ['first computer programmer', 'computer programmer'],
  maxNodes: 3,
};

describe('evaluateGranularity (DECOMP-17 behavioral eval)', () => {
  it('passes when genuine entities are nodes, descriptors are not, and count is within bound', () => {
    const r = evaluateGranularity(decision(['Ada Lovelace', 'Charles Babbage', 'Analytical Engine']), ada);
    expect(r.pass).toBe(true);
    expect(r.missingMustBe).toEqual([]);
    expect(r.presentMustNot).toEqual([]);
    expect(r.nodeCount).toBe(3);
  });

  it('FAILS on a missing must-be node (recall) — case/space-insensitive match', () => {
    const r = evaluateGranularity(decision(['ada   lovelace']), ada); // Babbage missing; Ada still matches
    expect(r.missingMustBe).toEqual(['Charles Babbage']);
    expect(r.pass).toBe(false);
  });

  it('FAILS when a descriptor leaks in as a node (precision) — exact OR substring', () => {
    const exact = evaluateGranularity(decision(['Ada Lovelace', 'Charles Babbage', 'first computer programmer']), ada);
    expect(exact.presentMustNot).toContain('first computer programmer');
    expect(exact.pass).toBe(false);
    // substring: a node named "The First Computer Programmer" still trips the guard
    const sub = evaluateGranularity(decision(['Ada Lovelace', 'Charles Babbage', 'The First Computer Programmer']), ada);
    expect(sub.presentMustNot).toContain('first computer programmer');
  });

  it('FAILS on over-extraction beyond the loose bound', () => {
    const r = evaluateGranularity(decision(['Ada Lovelace', 'Charles Babbage', 'Analytical Engine', 'Engine', 'Programmer', 'England']), ada);
    expect(r.overMax).toBe(true);
    expect(r.pass).toBe(false);
  });
});

describe('aggregateRuns — robustness across N runs (KB-QD bar item 2)', () => {
  it('passedAllRuns requires the HARD set assertions to hold in EVERY run', () => {
    const good = [decision(['Ada Lovelace', 'Charles Babbage']), decision(['Ada Lovelace', 'Charles Babbage', 'Analytical Engine'])]
      .map((d) => evaluateGranularity(d, ada));
    const agg = aggregateRuns(ada.name, good);
    expect(agg.passedAllRuns).toBe(true);
    expect(agg.medianNodes).toBe(2.5);
    expect(agg.minNodes).toBe(2);
    expect(agg.maxNodes).toBe(3);

    // one run leaks a descriptor → the whole aggregate fails (must hold in ALL runs)
    const mixed = [
      evaluateGranularity(decision(['Ada Lovelace', 'Charles Babbage']), ada),
      evaluateGranularity(decision(['Ada Lovelace', 'Charles Babbage', 'first computer programmer']), ada),
    ];
    const aggMixed = aggregateRuns(ada.name, mixed);
    expect(aggMixed.passedAllRuns).toBe(false);
    expect(aggMixed.everPresentMustNot).toContain('first computer programmer');
  });

  it('reports the loose total bound (runsOverMax) without failing the aggregate on it alone', () => {
    // within recall/precision but over the loose count bound in one run → passedAllRuns stays true
    const checks = [
      evaluateGranularity(decision(['Ada Lovelace', 'Charles Babbage']), ada),
      evaluateGranularity(decision(['Ada Lovelace', 'Charles Babbage', 'Analytical Engine', 'Mathematics', 'England']), ada),
    ];
    const agg = aggregateRuns(ada.name, checks);
    expect(agg.passedAllRuns).toBe(true); // set-assertions held in both runs
    expect(agg.runsOverMax).toBe(1); // but over-extraction is surfaced for the reviewer
  });

  it('formats a readable one-line verdict', () => {
    const agg = aggregateRuns(ada.name, [evaluateGranularity(decision(['Ada Lovelace', 'Charles Babbage']), ada)]);
    expect(formatAggregate(agg)).toMatch(/^\[PASS\] ada-lovelace-bio: nodes median 2/);
  });
});
