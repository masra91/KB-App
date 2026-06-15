import { describe, it, expect } from 'vitest';
import {
  scoreAffinities,
  planOrphanLinks,
  topicTagsOf,
  type AffinityEntity,
} from './entityAffinity';
import { computeCohesion, type GraphEdge } from './cohesion';

// A compact entity builder — only the fields the scorer reads.
function ent(id: string, opts: Partial<AffinityEntity> = {}): AffinityEntity {
  return {
    id,
    name: opts.name ?? id,
    kind: opts.kind ?? 'person',
    derivedFrom: opts.derivedFrom ?? [],
    topicTags: opts.topicTags ?? [],
  };
}

describe('topicTagsOf — only topic/ tags are a relatedness signal', () => {
  it('keeps topic/ tags and drops type/ (and anything else)', () => {
    expect(topicTagsOf(['type/person', 'topic/disney', 'topic/animation', 'misc'])).toEqual(['topic/disney', 'topic/animation']);
  });
});

describe('scoreAffinities — grounded signals, rarity-weighted', () => {
  it('co-mention from a FOCUSED source scores high; only the co-mentioned entity is a candidate', () => {
    const entities = [
      ent('a', { derivedFrom: ['src/focused'] }),
      ent('b', { derivedFrom: ['src/focused'] }),
      ent('c', { derivedFrom: ['src/unrelated'] }),
    ];
    const got = scoreAffinities('a', entities);
    expect(got.map((c) => c.id)).toEqual(['b']); // c shares nothing → not a candidate
    expect(got[0].sharedSources).toEqual(['src/focused']);
    expect(got[0].score).toBeCloseTo(1.0, 5); // 2-entity source ⇒ full weight 1/(2-1)
  });

  it('rarity: a BROAD source (many entities) decays toward zero — the anti-hairball core', () => {
    // One source derives 11 entities → each pair gets only 1/(11-1) = 0.1 from it.
    const entities = Array.from({ length: 11 }, (_, i) => ent(`e${i}`, { derivedFrom: ['src/dump'] }));
    const got = scoreAffinities('e0', entities);
    expect(got).toHaveLength(10);
    for (const c of got) expect(c.score).toBeCloseTo(0.1, 5);
  });

  it('a shared topic tag contributes, weighted below a shared source', () => {
    const entities = [
      ent('a', { topicTags: ['topic/x'] }),
      ent('b', { topicTags: ['topic/x'] }),
    ];
    const [c] = scoreAffinities('a', entities);
    expect(c.id).toBe('b');
    expect(c.sharedTopicTags).toEqual(['topic/x']);
    expect(c.score).toBeCloseTo(0.5, 5); // topicWeight 0.5 / (2-1)
  });

  it('signals stack: co-mention + shared topic sum', () => {
    const entities = [
      ent('a', { derivedFrom: ['s'], topicTags: ['topic/x'] }),
      ent('b', { derivedFrom: ['s'], topicTags: ['topic/x'] }),
    ];
    expect(scoreAffinities('a', entities)[0].score).toBeCloseTo(1.5, 5); // 1.0 + 0.5
  });

  it('shared HUB neighbour counts little (degree-decayed); a rare shared neighbour counts more', () => {
    // hub linked by a,b and many others; rare linked only by a,b.
    const entities = ['a', 'b', 'hub', 'rare', 'x', 'y'].map((id) => ent(id));
    const edges = [
      { from: 'a', to: 'hub' },
      { from: 'b', to: 'hub' },
      { from: 'x', to: 'hub' },
      { from: 'y', to: 'hub' }, // hub degree 4
      { from: 'a', to: 'rare' },
      { from: 'b', to: 'rare' }, // rare degree 2
    ];
    const got = scoreAffinities('a', entities, edges);
    const b = got.find((c) => c.id === 'b')!;
    expect(b.sharedNeighbors).toEqual(['hub', 'rare']);
    expect(b.score).toBeCloseTo(0.5 / 4 + 0.5 / 2, 5); // hub decayed by deg 4, rare by deg 2
  });

  it('is deterministic: ties break by id ascending', () => {
    const entities = [
      ent('z', { derivedFrom: ['s'] }),
      ent('m', { derivedFrom: ['s'] }),
      ent('a', { derivedFrom: ['s'] }),
    ];
    expect(scoreAffinities('m', entities).map((c) => c.id)).toEqual(['a', 'z']); // equal score → id order
  });

  it('an unknown target id yields no candidates (tolerant)', () => {
    expect(scoreAffinities('ghost', [ent('a')])).toEqual([]);
  });
});

describe('planOrphanLinks — link the degree-0 tail, conservatively', () => {
  it('links an orphan to its co-mentioned candidate; a no-evidence orphan stays unlinked', () => {
    const entities = [
      ent('orphanA', { derivedFrom: ['s1'] }),
      ent('hub', { derivedFrom: ['s1'] }),
      ent('lonely', { derivedFrom: ['s-nobody-else'] }),
    ];
    const plans = planOrphanLinks(entities, []); // no existing edges → all degree-0
    const byOrphan = new Map(plans.map((p) => [p.orphan, p.links.map((l) => l.id)]));
    expect(byOrphan.get('orphanA')).toEqual(['hub']);
    expect(byOrphan.get('hub')).toEqual(['orphanA']); // symmetric evidence
    expect(byOrphan.has('lonely')).toBe(false); // no shared signal → no link (don't-false-link)
  });

  it('a node that already has an edge is NOT an orphan → not re-linked', () => {
    const entities = [ent('a', { derivedFrom: ['s'] }), ent('b', { derivedFrom: ['s'] }), ent('c', { derivedFrom: ['s'] })];
    const plans = planOrphanLinks(entities, [{ from: 'a', to: 'b' }]); // a,b connected; c orphan
    expect(plans.map((p) => p.orphan)).toEqual(['c']); // only c is degree-0
    expect(plans[0].links.map((l) => l.id).sort()).toEqual(['a', 'b']);
  });

  it('NEVER manufactures a hairball from a broad shared source (rarity keeps it below minScore)', () => {
    // 20 entities all from one big dump → pair weight 1/19 ≈ 0.053, below the 0.2 default minScore.
    const entities = Array.from({ length: 20 }, (_, i) => ent(`e${i}`, { derivedFrom: ['src/big-dump'] }));
    const plans = planOrphanLinks(entities, []);
    expect(plans).toEqual([]); // nobody linked — a broad co-mention is NOT evidence of a real relation
  });

  it('respects the per-orphan link cap (bounded degree growth)', () => {
    // orphan co-mentioned (focused, score 1.0 each) with 5 others → capped to maxLinksPerOrphan.
    const entities = [
      ent('o', { derivedFrom: ['s0', 's1', 's2', 's3', 's4'] }),
      ent('c0', { derivedFrom: ['s0'] }),
      ent('c1', { derivedFrom: ['s1'] }),
      ent('c2', { derivedFrom: ['s2'] }),
      ent('c3', { derivedFrom: ['s3'] }),
      ent('c4', { derivedFrom: ['s4'] }),
    ];
    const plan = planOrphanLinks(entities, [], { maxLinksPerOrphan: 2 }).find((p) => p.orphan === 'o')!;
    expect(plan.links).toHaveLength(2); // capped
  });

  it('skip set leaves a node alone (link-promotion pass owns relatesTo nodes — disjoint domains)', () => {
    const entities = [ent('owned', { derivedFrom: ['s'] }), ent('free', { derivedFrom: ['s'] })];
    const plans = planOrphanLinks(entities, [], { skip: new Set(['owned']) });
    expect(plans.map((p) => p.orphan)).toEqual(['free']); // 'owned' skipped; 'free' still links to it
    expect(plans[0].links.map((l) => l.id)).toEqual(['owned']);
  });

  it('honors the SPEC-0050 distinct-pair suppression seam — never links a settled-distinct pair', () => {
    const entities = [
      ent('disney-park', { name: 'Disneyland', kind: 'organization', derivedFrom: ['s'] }),
      ent('disney-corp', { name: 'Disney', kind: 'organization', derivedFrom: ['s'] }),
      ent('other', { derivedFrom: ['s'] }),
    ];
    const blocked = (a: AffinityEntity, b: AffinityEntity): boolean => {
      const pair = [a.id, b.id].sort().join('::');
      return pair === 'disney-corp::disney-park'; // Principal settled these as distinct
    };
    const plans = planOrphanLinks(entities, [], { blocked });
    const park = plans.find((p) => p.orphan === 'disney-park')!;
    expect(park.links.map((l) => l.id)).toEqual(['other']); // links to 'other', NOT to the distinct 'disney-corp'
    const corp = plans.find((p) => p.orphan === 'disney-corp')!;
    expect(corp.links.map((l) => l.id)).toEqual(['other']); // and the suppression is symmetric
  });

  it('is idempotent in spirit: once linked (edge present) the orphan is no longer planned', () => {
    const entities = [ent('a', { derivedFrom: ['s'] }), ent('b', { derivedFrom: ['s'] })];
    // first pass would link a<->b; model the post-link graph and re-plan:
    const plansAfter = planOrphanLinks(entities, [{ from: 'a', to: 'b' }]);
    expect(plansAfter).toEqual([]); // both now have degree → nothing to do
  });
});

describe('cohesion trajectory — the linker REDUCES orphans WITHOUT building a hairball (COHERE-3)', () => {
  // Apply a plan's links as new graph edges (what linkOrphansOnce renders).
  function applyPlan(entities: AffinityEntity[], edges: GraphEdge[]): GraphEdge[] {
    const plans = planOrphanLinks(entities, edges);
    const added = plans.flatMap((p) => p.links.map((l) => ({ from: p.orphan, to: l.id })));
    return [...edges, ...added];
  }

  it('a fragmented vault of source-grouped clusters: orphans drop, clusters stay real (modularity holds)', () => {
    // Three focused sources, each deriving 3 entities → three genuine 3-cliques once linked. No edges yet.
    const entities: AffinityEntity[] = [];
    for (const [grp, n] of [['film', 'a'], ['lab', 'b'], ['team', 'c']] as const) {
      for (let i = 0; i < 3; i++) entities.push(ent(`${n}${i}`, { derivedFrom: [`src/${grp}`] }));
    }
    const before = computeCohesion(entities.map((e) => ({ id: e.id })), []);
    expect(before.orphanShare).toBe(1); // all 9 orphaned
    expect(before.giantComponentShare).toBeCloseTo(1 / 9, 5); // fully fragmented

    const after = computeCohesion(entities.map((e) => ({ id: e.id })), applyPlan(entities, []));
    expect(after.orphanShare).toBe(0); // every entity now linked — the tail recovered
    expect(after.communities).toBe(3); // the three source clusters detected as distinct communities
    expect(after.modularity).toBeGreaterThan(0.5); // strong clusters — NOT a hairball
    expect(after.crossClusterRatio).toBe(0); // clusters do not bleed together
  });

  it('a broad dump source does NOT collapse into a hairball — it simply stays unlinked', () => {
    const entities = Array.from({ length: 15 }, (_, i) => ent(`e${i}`, { derivedFrom: ['src/dump'] }));
    const after = computeCohesion(entities.map((e) => ({ id: e.id })), applyPlan(entities, []));
    expect(after.edges).toBe(0); // rarity weighting suppressed every weak pair
    expect(after.orphanShare).toBe(1); // honest: a dump isn't evidence, so coverage is NOT faked
  });
});
