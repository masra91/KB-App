// Unit tests for the pure dedup/node-finding precision/recall metric (SPEC-0042 EVAL-13). Deterministic
// (no copilot) — this is the scoring logic the behavioural eval (eval/dedupQuality.eval.ts) feeds real
// decider clusters into; it is the CI gate for the metric itself (the eval is opt-in).
import { describe, it, expect } from 'vitest';
import {
  scoreClustering,
  aggregateScores,
  formatDedupAggregate,
  connectClustersToGroups,
  reflectFindingsToGroups,
  type LabeledItem,
  type ClusterScore,
} from './dedupEval';

// Two real entities: A = {a1,a2,a3} (a duplicate trio), B = {b1,b2} (a distinct pair).
const ITEMS: LabeledItem[] = [
  { id: 'a1', entity: 'A' },
  { id: 'a2', entity: 'A' },
  { id: 'a3', entity: 'A' },
  { id: 'b1', entity: 'B' },
  { id: 'b2', entity: 'B' },
];

describe('scoreClustering — pairwise precision/recall', () => {
  it('perfect clustering → precision = recall = 1, no false/missed merges', () => {
    const s = scoreClustering(ITEMS, [['a1', 'a2', 'a3'], ['b1', 'b2']]);
    expect(s.precision).toBe(1);
    expect(s.recall).toBe(1);
    expect(s.f1).toBe(1);
    expect(s.falseMerges).toEqual([]);
    expect(s.missedMerges).toEqual([]);
    expect(s.truePos).toBe(4); // 3 within-A pairs + 1 within-B pair
  });

  it('a FALSE MERGE (distinct entities in one cluster) tanks precision and is reported pair-by-pair', () => {
    // Merged everything into one cluster → all 6 cross-entity A×B pairs are false merges.
    const s = scoreClustering(ITEMS, [['a1', 'a2', 'a3', 'b1', 'b2']]);
    expect(s.falsePos).toBe(6); // 3×2 cross pairs
    expect(s.precision).toBeCloseTo(4 / 10); // tp=4, fp=6
    expect(s.recall).toBe(1); // every true pair is also (over-)merged
    // The guard surfaces the exact offending distinct pairs (sorted) for human triage.
    expect(s.falseMerges).toContainEqual(['a1', 'b1']);
    expect(s.falseMerges).toContainEqual(['a3', 'b2']);
  });

  it('a MISSED MERGE (true duplicates split apart) tanks recall but keeps precision clean', () => {
    // a3 left as its own singleton (not named in any cluster) → 2 missed A-pairs (a1-a3, a2-a3).
    const s = scoreClustering(ITEMS, [['a1', 'a2'], ['b1', 'b2']]);
    expect(s.precision).toBe(1); // no wrong merge
    expect(s.falseNeg).toBe(2);
    expect(s.recall).toBeCloseTo(2 / 4); // tp=2 (a1-a2, b1-b2), fn=2
    expect(s.missedMerges).toContainEqual(['a1', 'a3']);
    expect(s.missedMerges).toContainEqual(['a2', 'a3']);
  });

  it('all-singletons (nothing merged) → precision 1 (no wrong merge), recall 0 (found no dupes)', () => {
    const s = scoreClustering(ITEMS, []);
    expect(s.precision).toBe(1);
    expect(s.recall).toBe(0);
    expect(s.falseMerges).toEqual([]);
  });

  it('node-finding: folding a candidate into the RIGHT existing-node anchor counts as a correct merge', () => {
    // Existing node anchor `node-A` (entity A). Candidate c1 (entity A) folds into it → a true pair.
    const items: LabeledItem[] = [
      { id: 'node-A', entity: 'A' },
      { id: 'c1', entity: 'A' },
      { id: 'node-B', entity: 'B' },
    ];
    const good = scoreClustering(items, [['node-A', 'c1'], ['node-B']]);
    expect(good.recall).toBe(1);
    expect(good.precision).toBe(1);
    // Folding c1 into the WRONG node (node-B) is a false merge.
    const bad = scoreClustering(items, [['node-B', 'c1'], ['node-A']]);
    expect(bad.falsePos).toBe(1);
    expect(bad.falseMerges).toContainEqual(['c1', 'node-B']);
  });

  it('no true duplicates exist → recall is vacuously 1 (not a divide-by-zero / 0)', () => {
    const distinct: LabeledItem[] = [
      { id: 'x', entity: 'X' },
      { id: 'y', entity: 'Y' },
    ];
    const s = scoreClustering(distinct, [['x'], ['y']]);
    expect(s.recall).toBe(1);
    expect(s.precision).toBe(1);
  });
});

describe('aggregateScores — median across runs + strict false-merge union (the guard)', () => {
  const perfect: ClusterScore = scoreClustering(ITEMS, [['a1', 'a2', 'a3'], ['b1', 'b2']]);
  const oneMiss: ClusterScore = scoreClustering(ITEMS, [['a1', 'a2'], ['b1', 'b2']]);
  const oneFalse: ClusterScore = scoreClustering(ITEMS, [['a1', 'a2', 'a3', 'b1'], ['b2']]);

  it('medians absorb a single non-deterministic recall dip', () => {
    const agg = aggregateScores('demo', [perfect, perfect, oneMiss]);
    expect(agg.runs).toBe(3);
    expect(agg.medianRecall).toBe(1); // median of [1, 1, 0.5]
    expect(agg.worstRecall).toBeCloseTo(0.5);
  });

  it('everFalseMerged unions any false merge across ALL runs (guard is "never, in any run")', () => {
    const agg = aggregateScores('demo', [perfect, oneFalse, perfect]);
    expect(agg.everFalseMerged.length).toBeGreaterThan(0); // the bad run leaks through even amid good runs
    expect(agg.everFalseMerged).toContainEqual(['a1', 'b1']);
  });

  it('a clean set has an empty everFalseMerged (the guard passes)', () => {
    const agg = aggregateScores('demo', [perfect, oneMiss]); // misses hurt recall, never precision
    expect(agg.everFalseMerged).toEqual([]);
  });
});

describe('connectClustersToGroups — Connect verdict → predicted groups (incl. node-finding fold-in)', () => {
  it('a cluster groups its members plus the existing node(s) it folds/merges into', () => {
    const groups = connectClustersToGroups([
      { memberCandidateIds: ['c1', 'c2'], existingNodeId: 'node-A', mergeExistingNodeIds: ['node-A2'] },
      { memberCandidateIds: ['c3'] }, // a born-fresh node, no fold-in
    ]);
    expect(groups).toEqual([['c1', 'c2', 'node-A', 'node-A2'], ['c3']]);
  });

  it('scores node-finding end-to-end: a candidate folded into the right node is a correct merge', () => {
    const items: LabeledItem[] = [
      { id: 'node-A', entity: 'A' },
      { id: 'cN', entity: 'A' },
    ];
    const groups = connectClustersToGroups([{ memberCandidateIds: ['cN'], existingNodeId: 'node-A' }]);
    const s = scoreClustering(items, groups);
    expect(s.recall).toBe(1);
    expect(s.precision).toBe(1);
  });
});

describe('reflectFindingsToGroups — Reflect findings → predicted consolidation groups', () => {
  it('keeps only findings that carry a consolidation proposal (others propose no merge)', () => {
    const groups = reflectFindingsToGroups([
      { review: { consolidation: { canonicalRel: 'entities/person/caroline.md', loserRels: ['entities/person/caroline-winters.md', 'entities/person/caroline-winters-azzone.md'] } } },
      { review: { consolidation: undefined } }, // a review with no consolidation → no group
      {}, // an additive finding → no group
    ]);
    expect(groups).toEqual([['entities/person/caroline.md', 'entities/person/caroline-winters.md', 'entities/person/caroline-winters-azzone.md']]);
  });

  it('no consolidation proposals → no predicted merges → precision 1, recall 0 over real duplicates', () => {
    const items: LabeledItem[] = [
      { id: 'entities/person/caroline.md', entity: 'cw' },
      { id: 'entities/person/caroline-winters.md', entity: 'cw' },
    ];
    const s = scoreClustering(items, reflectFindingsToGroups([{}, {}]));
    expect(s.precision).toBe(1);
    expect(s.recall).toBe(0); // Reflect found nothing — the "is Reflect actually working?" signal
  });
});

describe('formatDedupAggregate — human-readable report (PRIN-24: names, not bare ids)', () => {
  it('renders names for the offending pairs and a ✓ when clean', () => {
    const names: Record<string, string> = { a1: 'Caroline (climbing)', b1: 'Caroline (invoice)' };
    const dirty = aggregateScores('caroline', [scoreClustering(ITEMS, [['a1', 'b1']])]);
    const out = formatDedupAggregate(dirty, (id) => names[id] ?? id);
    expect(out).toContain('FALSE MERGES');
    expect(out).toContain('Caroline (climbing) ⇔ Caroline (invoice)');

    const clean = aggregateScores('caroline', [scoreClustering(ITEMS, [['a1', 'a2', 'a3'], ['b1', 'b2']])]);
    expect(formatDedupAggregate(clean)).toContain('no false merges');
  });
});
