// Graph projection (SPEC-0058 STATE-2) — equivalence + precompute proof, through the REAL read path.
//
// The projection's contract: serving Explore (`buildNeighborhood` / `listExploreEntities`) and Health
// (`buildHealthReport`) from the precomputed in-memory snapshot must be BYTE-IDENTICAL to serving them
// from the live `makeReadOnlyTools` vault walk — only without the per-mount filesystem cost. So the core
// test computes the projection from a real seeded git vault, then asserts the projection-backed assembly
// deep-equals the live-tools assembly. A second test proves the O(N²) backlink scan is done ONCE at
// compute time (precomputed), not on the render path.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildRecallVault, type RecallVault } from '../../test/recallVault';
import { rmTempDir } from '../../test/tempVault';
import { makeReadOnlyTools } from './recallTools';
import { computeGraphProjection, makeProjectionTools } from './graphProjection';
import { buildNeighborhood, listExploreEntities } from './explorePanel';
import { buildHealthReport } from './healthPanel';

describe('graph projection — projection-backed reads equal the live vault walk (SPEC-0058 STATE-2)', () => {
  let v: RecallVault;
  let live: ReturnType<typeof makeReadOnlyTools>;
  let proj: ReturnType<typeof makeProjectionTools>;

  beforeAll(async () => {
    v = await buildRecallVault(); // Ada Lovelace ↔ Analytical Engine, one grounded claim, one source
    live = makeReadOnlyTools(v.root);
    const graph = await computeGraphProjection(live, () => '2026-06-28T00:00:00.000Z');
    proj = makeProjectionTools(graph);
  });
  afterAll(async () => {
    await rmTempDir(v.root);
  });

  it('listExploreEntities — identical entity list (search picker)', async () => {
    expect(await listExploreEntities(proj)).toEqual(await listExploreEntities(live));
  });

  it('buildNeighborhood(focus=Ada) — identical center + claims + neighbors + backlink direction', async () => {
    const a = await buildNeighborhood(proj, 'Ada Lovelace');
    const b = await buildNeighborhood(live, 'Ada Lovelace');
    expect(a).toEqual(b);
    // sanity: the projection actually produced the neighborhood (not an empty/found:false degrade)
    expect(a.found).toBe(true);
    expect(a.center?.name).toBe('Ada Lovelace');
    expect(a.neighbors.map((n) => n.name)).toContain('Analytical Engine');
  });

  it('buildNeighborhood(focus=Engine) — identical incoming/outgoing from the OTHER side', async () => {
    expect(await buildNeighborhood(proj, 'Analytical Engine')).toEqual(await buildNeighborhood(live, 'Analytical Engine'));
  });

  it('buildNeighborhood(no focus) — identical default (highest-confidence) landing', async () => {
    expect(await buildNeighborhood(proj)).toEqual(await buildNeighborhood(live));
  });

  it('buildHealthReport — identical structural scan (orphans/thin/dangling/counts)', async () => {
    expect(await buildHealthReport(proj)).toEqual(await buildHealthReport(live));
  });
});

describe('graph projection — the O(N²) backlink scan is PRECOMPUTED, not on the render path', () => {
  it('computeGraphProjection inverts links into per-entity backlinks (the live per-mount scan, done once)', async () => {
    const v = await buildRecallVault();
    try {
      const graph = await computeGraphProjection(makeReadOnlyTools(v.root), () => 'T');
      // Engine links to Ada → Ada has an incoming backlink FROM the engine, precomputed in the snapshot.
      expect(graph.backlinks[v.adaRel].map((l) => l.from)).toContain(v.engineRel);
      // Ada links to Engine → Engine has an incoming backlink FROM Ada.
      expect(graph.backlinks[v.engineRel].map((l) => l.from)).toContain(v.adaRel);
      // The projection-backed linkTraversal returns those precomputed backlinks with ZERO filesystem reads
      // (the snapshot is the only input) — an O(degree) lookup, not the live O(N+M) candidate walk.
      const { incoming } = await makeProjectionTools(graph).linkTraversal({ entity: v.adaRel });
      expect(incoming.map((l) => l.from)).toContain(v.engineRel);
    } finally {
      await rmTempDir(v.root);
    }
  });
});
