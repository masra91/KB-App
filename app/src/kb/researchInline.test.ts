// Inline research wiring (SPEC-0028 RESEARCH-2/3/4) — composes registry + dispatcher + cognition with
// injected fakes (no network). Real FS+git temp vault (TEST-18).
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { makeTempDir, rmTempDir } from '../../test/tempVault';
import { createKb } from './vault';
import { upsertResearcher } from './researcherRegistry';
import { readCapturedMeta } from './ingest';
import { runInlineResearch, makeResearchDeps } from './researchInline';
import { dedupKeyFor, type ResearcherConfig, type ResearchRequest } from './researchers';

function gitInstalledSync(): boolean {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}
const gitAvailable = gitInstalledSync();

async function withVault(fn: (root: string) => Promise<void>): Promise<void> {
  const dir = await makeTempDir();
  try {
    const root = path.join(dir, 'vault');
    await createKb({ path: root, initGitIfNeeded: true });
    await fn(root);
  } finally {
    await rmTempDir(dir);
  }
}

const web = (over: Partial<ResearcherConfig> = {}): ResearcherConfig => ({
  id: 'web-1', template: 'web', prompt: 'p', egressTier: 'public-web', scope: 'global',
  budget: { maxToolCalls: 8, maxDepth: 2 }, schedule: 'off', posture: 'guarded', enabled: true, ...over,
});
const req = (what: string): ResearchRequest => ({ id: `req-${what}`, ts: '2026-06-02T00:00:00.000Z', by: { stage: 'decompose', sourceId: 'S1' }, what, why: 'unknown', context: what, dedupKey: dedupKeyFor({ what, by: { sourceId: 'S1' } }) });

// A fake Web session (no network): always finds something with one allowed citation.
const fakeWeb = { session: async () => ({ note: 'finding from the web', citations: ['https://example.com/x'] }) };

describe('makeResearchDeps', () => {
  it('wires self-nomination (heuristic w/o runner) + Web run bound to root', () => {
    const deps = makeResearchDeps('/tmp/x', { web: fakeWeb, maxFanout: 2, globalCeiling: 5 });
    expect(typeof deps.selfNominate).toBe('function');
    expect(typeof deps.run).toBe('function');
    expect(deps.maxFanout).toBe(2);
    expect(deps.globalCeiling).toBe(5);
  });
});

describe.skipIf(!gitAvailable)('runInlineResearch (RESEARCH-2/3/4)', () => {
  it('routes a request to enabled researchers → writes a cited secondary source', async () => {
    await withVault(async (root) => {
      await upsertResearcher(root, web({ id: 'web-1', enabled: true }));
      const res = await runInlineResearch(root, [req('Atlas')], { web: fakeWeb });
      expect(res.fresh).toBe(1);
      const ran = res.outcomes.find((o) => o.ran)!;
      expect(ran.researcherId).toBe('web-1');
      expect(ran.sourceIds?.length).toBe(1);
      // the secondary source is on disk, origin:secondary, citing the allowed host.
      const meta = await readCapturedMeta(path.join(root, 'inbox', ran.sourceIds![0]));
      expect(meta.origin).toBe('secondary');
      expect(meta.research?.citations).toEqual(['https://example.com/x']);
    });
  });

  it('skips disabled researchers (only enabled research)', async () => {
    await withVault(async (root) => {
      await upsertResearcher(root, web({ id: 'web-off', enabled: false }));
      const res = await runInlineResearch(root, [req('Atlas')], { web: fakeWeb });
      expect(res.outcomes).toEqual([]); // none eligible (disabled filtered before dispatch)
    });
  });

  it('respects the dedup ledger across calls (D2)', async () => {
    await withVault(async (root) => {
      await upsertResearcher(root, web({ id: 'web-1', enabled: true }));
      const first = await runInlineResearch(root, [req('Atlas')], { web: fakeWeb });
      expect(first.fresh).toBe(1);
      const second = await runInlineResearch(root, [req('Atlas')], { web: fakeWeb });
      expect(second.fresh).toBe(0); // already researched — coalesced
    });
  });
});
