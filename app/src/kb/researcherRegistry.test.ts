// Researcher registry (SPEC-0028 RESEARCH-1/15). Real FS temp dirs (TEST-18); mirrors jobRegistry,
// incl. the #29-class path-injection guard at read/write/patch boundaries.
import { describe, it, expect, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { makeTempDir, rmTempDir } from '../../test/tempVault';
import {
  readResearcherRegistry,
  writeResearcherRegistry,
  upsertResearcher,
  patchResearcher,
  researcherRegistryPath,
} from './researcherRegistry';
import type { ResearcherConfig } from './researchers';

async function withTemp(fn: (root: string) => Promise<void>): Promise<void> {
  const dir = await makeTempDir();
  try {
    await fn(dir);
  } finally {
    await rmTempDir(dir);
  }
}

function web(over: Partial<ResearcherConfig> = {}): ResearcherConfig {
  return {
    id: 'web-1',
    template: 'web',
    prompt: 'Find prior art.',
    egressTier: 'public-web',
    scope: 'global',
    budget: { maxToolCalls: 8, maxDepth: 2 },
    schedule: 'off',
    posture: 'guarded',
    enabled: false,
    ...over,
  };
}

describe('readResearcherRegistry', () => {
  it('returns [] for a missing or malformed file', async () => {
    await withTemp(async (root) => {
      expect(await readResearcherRegistry(root)).toEqual([]);
      await fs.mkdir(path.dirname(researcherRegistryPath(root)), { recursive: true });
      await fs.writeFile(researcherRegistryPath(root), 'not json');
      expect(await readResearcherRegistry(root)).toEqual([]);
    });
  });

  it('coerces unknown template/egress/schedule/posture to safe defaults; budget per-field', async () => {
    await withTemp(async (root) => {
      await writeResearcherRegistry(root, [
        { id: 'r1', template: 'bogus', prompt: 'p', egressTier: 'nope', scope: '', budget: { maxToolCalls: -1, maxDepth: 0 }, schedule: 'whenever', posture: 'yolo', enabled: true } as unknown as ResearcherConfig,
      ]);
      const [r] = await readResearcherRegistry(root);
      expect(r.template).toBe('custom'); // unknown template → custom
      expect(r.egressTier).toBe('local-only'); // unknown egress → most-restrictive destination
      expect(r.schedule).toBe('off');
      expect(r.posture).toBe('guarded');
      expect(r.scope).toBe('global'); // empty → default
      expect(r.budget).toEqual({ maxToolCalls: 15, maxDepth: 2 }); // invalid numbers → defaults (RESEARCH-17: default 15)
    });
  });

  it('preserves the editable session timeoutMs across a write→read round-trip (WS3 / RESEARCH-18 regression)', async () => {
    // Regression: validResearcher dropped the top-level `timeoutMs` on read, so a persisted edit reverted
    // to the default on the very next read (the editable-timeout control silently didn't stick). A valid
    // positive number survives; garbage is dropped (→ resolveTimeoutMs supplies the default).
    await withTemp(async (root) => {
      await writeResearcherRegistry(root, [web({ id: 'web-1', timeoutMs: 20 * 60_000 })]);
      expect((await readResearcherRegistry(root)).find((r) => r.id === 'web-1')!.timeoutMs).toBe(20 * 60_000);
      // Garbage timeoutMs is not carried (left undefined → default applies on use).
      await writeResearcherRegistry(root, [{ ...web({ id: 'web-2' }), timeoutMs: -1 } as unknown as ResearcherConfig]);
      expect((await readResearcherRegistry(root)).find((r) => r.id === 'web-2')!.timeoutMs).toBeUndefined();
    });
  });

  it('drops a row whose id is not a bare slug and surfaces it on devlog (#29 read guard)', async () => {
    await withTemp(async (root) => {
      await writeResearcherRegistry(root, [web({ id: 'web-1' }), web({ id: '../../tmp/evil' }), web({ id: '.kb' })]);
      const warn = vi.fn();
      const loaded = await readResearcherRegistry(root, { debug() {}, info() {}, warn, error() {}, child: () => ({}) as never, flush: async () => {} } as never);
      expect(loaded.map((r) => r.id)).toEqual(['web-1']); // only the safe id loads
      expect(warn).toHaveBeenCalledTimes(2); // both unsafe ids surfaced — not silent
    });
  });
});

describe('upsertResearcher / patchResearcher', () => {
  it('inserts, then replaces by id; allows MULTIPLE researchers per template (unlike jobs)', async () => {
    await withTemp(async (root) => {
      await upsertResearcher(root, web({ id: 'web-1', topics: ['atlas'] }));
      await upsertResearcher(root, web({ id: 'web-2', topics: ['orion'] })); // 2nd web researcher — allowed
      let reg = await readResearcherRegistry(root);
      expect(reg.map((r) => r.id).sort()).toEqual(['web-1', 'web-2']);

      await upsertResearcher(root, web({ id: 'web-1', prompt: 'Updated.' })); // replace
      reg = await readResearcherRegistry(root);
      expect(reg.length).toBe(2);
      expect(reg.find((r) => r.id === 'web-1')!.prompt).toBe('Updated.');
    });
  });

  it('rejects an unsafe id at the write boundary (throw, never persist) — #29', async () => {
    await withTemp(async (root) => {
      await expect(upsertResearcher(root, web({ id: '../x' }))).rejects.toThrow(/unsafe id/);
      await expect(patchResearcher(root, 'a/b', { enabled: true })).rejects.toThrow(/unsafe id/);
      expect(await readResearcherRegistry(root)).toEqual([]); // nothing persisted
    });
  });

  it('patches mutable fields; no-op on an absent id', async () => {
    await withTemp(async (root) => {
      await upsertResearcher(root, web({ id: 'web-1', enabled: false, schedule: 'off' }));
      await patchResearcher(root, 'web-1', { enabled: true, schedule: 'daily', posture: 'autonomous' });
      const r = (await readResearcherRegistry(root)).find((x) => x.id === 'web-1')!;
      expect(r).toMatchObject({ enabled: true, schedule: 'daily', posture: 'autonomous' });
      await patchResearcher(root, 'nope', { enabled: false }); // absent → no throw, no change
      expect((await readResearcherRegistry(root)).length).toBe(1);
    });
  });
});
