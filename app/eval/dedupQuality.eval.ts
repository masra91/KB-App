// OPT-IN behavioral eval for EVAL-13 — entity DEDUP + NODE-FINDING precision/recall (SPEC-0042). The
// Principal is skeptical that dedup/consolidation actually works; this MEASURES it over generalized,
// labeled fixtures and REPORTS precision/recall, with a HARD don't-false-merge-distinct guard.
//
// Like the other evals it is double-gated (lives under eval/, and self-skips unless KB_EVAL=1) because it
// drives the REAL copilot deciders (EVAL-2, no mocks) and is non-deterministic. The deterministic CI gate
// for this work is the pure metric (src/kb/dedupEval.test.ts); THIS file is the on-demand behavior probe.
//
//   Run:  cd app && KB_EVAL=1 npm run eval -- dedupQuality
//
// It measures two systems through ONE shared metric (src/kb/dedupEval.ts):
//   • CONNECT — within-block: collapse duplicate candidates / fold into the right existing node.
//   • REFLECT — cross-block: consolidate name-variant nodes ("Caroline" / "Caroline Winters Azzone")
//     that exact-name blocking can never bring together — without swallowing a distinct decoy.
// HARD per fixture (every run): NO false merge of distinct entities (precision guard). SOFT: median
// recall clears a floor (a do-nothing system is flagged; non-determinism is absorbed by the median).
import { describe, it, expect } from 'vitest';
import { makeConnectDecider, type CandidateSet } from '../src/kb/connectAgent';
import { blockKey, type Candidate } from '../src/kb/connect';
import { makeReflectDecider, type ReflectContext } from '../src/kb/reflectAgent';
import {
  scoreClustering,
  aggregateScores,
  formatDedupAggregate,
  connectClustersToGroups,
  reflectFindingsToGroups,
  type LabeledItem,
  type ClusterScore,
} from '../src/kb/dedupEval';
import {
  CONNECT_DEDUP_FIXTURES,
  REFLECT_CONSOLIDATION_FIXTURES,
  type ConnectDedupFixture,
  type ReflectConsolidationFixture,
} from './dedupFixtures';

const ENABLED = process.env.KB_EVAL === '1';
const RUNS = Number(process.env.KB_EVAL_RUNS ?? '3'); // N≥3 for robustness to non-determinism (KB-QD bar)
const RECALL_FLOOR = Number(process.env.KB_EVAL_RECALL_FLOOR ?? '0.5'); // soft: a do-nothing system reads ~0
const PER_FIXTURE_TIMEOUT_MS = 12 * 60_000; // RUNS × one disposable copilot session (slow)

/** Build the Connect CandidateSet from a fixture; assert the candidates actually share ONE block (else
 *  the agent would never compare them — the fixture would be measuring nothing). */
function toCandidateSet(fx: ConnectDedupFixture): CandidateSet {
  const candidates: Candidate[] = fx.candidates.map((c) => ({
    id: c.id,
    sourceId: c.source,
    kind: fx.kind,
    name: c.name,
    confidence: 0.8,
    mentions: c.mentions,
  }));
  const keys = new Set(candidates.map((c) => blockKey(fx.kind, c.name)));
  expect(keys.size, `${fx.name}: candidates must share one blockKey to reach the agent together`).toBe(1);
  return {
    blockKey: [...keys][0],
    kind: fx.kind,
    candidates,
    existingNodes: (fx.existingNodes ?? []).map((n) => ({ id: n.id, name: n.name })),
  };
}

/** All scored items for a Connect fixture = its candidates + any existing-node anchors (node-finding). */
function connectItems(fx: ConnectDedupFixture): LabeledItem[] {
  return [
    ...fx.candidates.map((c) => ({ id: c.id, entity: c.entity })),
    ...(fx.existingNodes ?? []).map((n) => ({ id: n.id, entity: n.entity })),
  ];
}

/** Build the Reflect working set (the bounded rumination context) from a fixture's nodes. */
function toReflectContext(fx: ReflectConsolidationFixture): ReflectContext {
  return {
    workingSet: fx.nodes.map((n) => ({ rel: n.rel, name: n.name, kind: n.kind, tags: n.tags ?? [], excerpt: n.excerpt })),
    journalNotes: [],
  };
}

describe.skipIf(!ENABLED)('EVAL-13 — Connect dedup + node-finding precision/recall (opt-in; real copilot)', () => {
  const decide = makeConnectDecider(); // production decider — shells to `copilot -p`

  for (const fx of CONNECT_DEDUP_FIXTURES) {
    it(
      `${fx.name}: ${fx.probe} (≥${RUNS} runs)`,
      async () => {
        const set = toCandidateSet(fx);
        const items = connectItems(fx);
        const nameOf = new Map<string, string>([
          ...fx.candidates.map((c) => [c.id, `${c.name} (${c.source})`] as const),
          ...(fx.existingNodes ?? []).map((n) => [n.id, `${n.name} (existing node)`] as const),
        ]);
        const scores: ClusterScore[] = [];
        let parkedReviews = 0;
        for (let i = 0; i < RUNS; i++) {
          const decision = await decide(set);
          parkedReviews += decision.reviews?.length ?? 0;
          scores.push(scoreClustering(items, connectClustersToGroups(decision.clusters)));
        }
        const agg = aggregateScores(fx.name, scores);
        console.log('\n' + formatDedupAggregate(agg, (id) => nameOf.get(id) ?? id) + `\n  (parked reviews across runs: ${parkedReviews})`);

        // HARD GUARD (every run): distinct entities are NEVER merged — raising a review is fine (cautious,
        // not a merge); only an actual same-cluster verdict on a distinct pair fails.
        expect(agg.everFalseMerged, `PRECISION: ${fx.name} false-merged distinct entities`).toEqual([]);
        // SOFT floor: the median run found the genuine duplicates (vacuously 1 for distinct-only fixtures).
        expect(agg.medianRecall, `RECALL: ${fx.name} median below ${RECALL_FLOOR}`).toBeGreaterThanOrEqual(RECALL_FLOOR);
      },
      PER_FIXTURE_TIMEOUT_MS,
    );
  }
});

describe.skipIf(!ENABLED)('EVAL-13 — Reflect consolidation precision/recall (opt-in; real copilot)', () => {
  const ruminate = makeReflectDecider(); // production decider — shells to `copilot -p`

  for (const fx of REFLECT_CONSOLIDATION_FIXTURES) {
    it(
      `${fx.name}: ${fx.probe} (≥${RUNS} runs)`,
      async () => {
        const ctx = toReflectContext(fx);
        const items: LabeledItem[] = fx.nodes.map((n) => ({ id: n.rel, entity: n.entity }));
        const nameOf = new Map(fx.nodes.map((n) => [n.rel, n.name] as const));
        const scores: ClusterScore[] = [];
        for (let i = 0; i < RUNS; i++) {
          const result = await ruminate(ctx);
          // Each consolidation proposal {canonicalRel, loserRels} is one predicted "these are the same".
          scores.push(scoreClustering(items, reflectFindingsToGroups(result.findings)));
        }
        const agg = aggregateScores(fx.name, scores);
        console.log('\n' + formatDedupAggregate(agg, (id) => nameOf.get(id) ?? id));

        // HARD GUARD: Reflect must not PROPOSE consolidating distinct entities (an approved merge would
        // conflate two real things; REFLECT consolidations are Review-gated, but a bad PROPOSAL is the defect).
        expect(agg.everFalseMerged, `PRECISION: ${fx.name} proposed consolidating distinct entities`).toEqual([]);
        expect(agg.medianRecall, `RECALL: ${fx.name} median below ${RECALL_FLOOR}`).toBeGreaterThanOrEqual(RECALL_FLOOR);
      },
      PER_FIXTURE_TIMEOUT_MS,
    );
  }
});
