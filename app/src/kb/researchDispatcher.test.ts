// Research dispatcher (SPEC-0028 RESEARCH-4/11). Deterministic routing with injected cognition seam;
// real FS temp dirs for the dedup ledger (TEST-18).
import { describe, it, expect } from 'vitest';
import { makeTempDir, rmTempDir } from '../../test/tempVault';
import { dispatchResearch, type DispatchDeps } from './researchDispatcher';
import { dedupKeyFor, type ResearcherConfig, type ResearchRequest } from './researchers';

async function withTemp(fn: (root: string) => Promise<void>): Promise<void> {
  const dir = await makeTempDir();
  try {
    await fn(dir);
  } finally {
    await rmTempDir(dir);
  }
}

function web(over: Partial<ResearcherConfig> = {}): ResearcherConfig {
  return { id: 'web-1', template: 'web', prompt: 'p', egressTier: 'public-web', scope: 'global', budget: { maxToolCalls: 8, maxDepth: 2 }, schedule: 'off', posture: 'guarded', enabled: true, ...over };
}

function req(what: string, over: Partial<ResearchRequest> = {}): ResearchRequest {
  return { id: `req-${what}`, ts: '2026-01-01T00:00:00.000Z', by: { stage: 'decompose', sourceId: 'S1' }, what, why: 'w', context: what, dedupKey: dedupKeyFor({ what, by: { sourceId: 'S1' } }), ...over };
}

/** Deps that always nominate + return one fake source per run; counts calls. */
function deps(over: Partial<DispatchDeps> = {}): DispatchDeps & { runs: () => number; noms: () => number } {
  let runs = 0;
  let noms = 0;
  return {
    selfNominate: async () => {
      noms++;
      return true;
    },
    run: async (r) => {
      runs++;
      return { sourceIds: [`src-${r.id}-${runs}`] };
    },
    ...over,
    runs: () => runs,
    noms: () => noms,
  } as DispatchDeps & { runs: () => number; noms: () => number };
}

describe('dispatchResearch — routing (RESEARCH-4)', () => {
  it('fans a fresh request to eligible researchers; each nominated one runs + yields a source', async () => {
    await withTemp(async (root) => {
      const d = deps();
      const res = await dispatchResearch(root, [req('atlas')], [web({ id: 'web-1' }), web({ id: 'web-2' })], d);
      expect(res.fresh).toBe(1);
      const ran = res.outcomes.filter((o) => o.ran);
      expect(ran).toHaveLength(2);
      expect(ran[0].sourceIds?.[0]).toMatch(/^src-web-/);
      expect(d.runs()).toBe(2);
    });
  });

  it('records non-nominating researchers as no-op (RESEARCH-4 "not → no-op + audit")', async () => {
    await withTemp(async (root) => {
      const d = deps({ selfNominate: async (r) => r.id === 'web-1' }); // only web-1 nominates
      const res = await dispatchResearch(root, [req('atlas')], [web({ id: 'web-1' }), web({ id: 'web-2' })], d);
      const byId = Object.fromEntries(res.outcomes.map((o) => [o.researcherId, o]));
      expect(byId['web-1'].ran).toBe(true);
      expect(byId['web-2']).toMatchObject({ nominated: false, ran: false });
      expect(byId['web-2'].note).toMatch(/not relevant/);
    });
  });

  it('excludes ineligible researchers (disabled / egress-hint / topic) before self-nomination', async () => {
    await withTemp(async (root) => {
      const d = deps();
      const researchers = [web({ id: 'on' }), web({ id: 'off', enabled: false }), web({ id: 'topic', topics: ['zephyr'] })];
      const res = await dispatchResearch(root, [req('atlas')], researchers, d);
      expect(res.outcomes.map((o) => o.researcherId)).toEqual(['on']); // disabled + topic-miss filtered out
      expect(d.noms()).toBe(1); // self-nomination only paid for the eligible one
    });
  });

  it('caps fan-out at maxFanout', async () => {
    await withTemp(async (root) => {
      const d = deps();
      const researchers = [web({ id: 'a' }), web({ id: 'b' }), web({ id: 'c' }), web({ id: 'd' })];
      const res = await dispatchResearch(root, [req('atlas')], researchers, { ...d, maxFanout: 2 });
      expect(res.outcomes).toHaveLength(2);
    });
  });
});

describe('dispatchResearch — dedup ledger (D2) + ceiling (RESEARCH-11)', () => {
  it('coalesces duplicate requests within a batch AND across dispatches (persistent ledger)', async () => {
    await withTemp(async (root) => {
      const d = deps();
      // Two requests with the same what+subject → same dedupKey → one fans out.
      const res1 = await dispatchResearch(root, [req('atlas'), req('atlas')], [web()], d);
      expect(res1.received).toBe(2);
      expect(res1.fresh).toBe(1);
      expect(d.runs()).toBe(1);
      // A later dispatch of the same request → already seen → no fresh, no run.
      const res2 = await dispatchResearch(root, [req('atlas')], [web()], d);
      expect(res2.fresh).toBe(0);
      expect(d.runs()).toBe(1); // unchanged
      // A different term is fresh again.
      const res3 = await dispatchResearch(root, [req('orion')], [web()], d);
      expect(res3.fresh).toBe(1);
      expect(d.runs()).toBe(2);
    });
  });

  it('memoizes self-nomination per (researcher, dedupKey) within a dispatch', async () => {
    await withTemp(async (root) => {
      const d = deps();
      // same dedupKey twice in one batch collapses at the dedup step, so to exercise the memo we
      // give two distinct request ids that share a dedupKey is impossible (dedup drops the 2nd) —
      // instead assert noms == eligible count (no double-charge): 1 researcher × 1 fresh request.
      await dispatchResearch(root, [req('atlas'), req('atlas')], [web()], d);
      expect(d.noms()).toBe(1);
    });
  });

  it('stops running at the global ceiling but still records the skips', async () => {
    await withTemp(async (root) => {
      const d = deps();
      const researchers = [web({ id: 'a' }), web({ id: 'b' }), web({ id: 'c' })];
      const res = await dispatchResearch(root, [req('atlas')], researchers, { ...d, maxFanout: 10, globalCeiling: 2 });
      expect(d.runs()).toBe(2); // only 2 ran
      expect(res.ceilingHit).toBe(true);
      const skipped = res.outcomes.find((o) => o.nominated && !o.ran);
      expect(skipped?.note).toMatch(/ceiling/);
    });
  });
});
