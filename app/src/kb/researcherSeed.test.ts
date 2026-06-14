// SPEC-0028 RESEARCH-1 / WS-B — the default-researcher seed: a virgin vault gets one enabled Web
// researcher (so the pipeline isn't inert), but a registry that already exists — even an empty `[]`
// from a Principal who cleared it — is never re-seeded. Pure FS (no git).
import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { makeTempDir, rmTempDir } from '../../test/tempVault';
import { isSafeResearcherId } from './researchers';
import { readResearcherRegistry, writeResearcherRegistry, researcherRegistryPath } from './researcherRegistry';
import { seedDefaultResearcherIfAbsent, makeDefaultWebResearcher, DEFAULT_WEB_RESEARCHER_ID } from './researcherSeed';

async function withRoot(fn: (root: string) => Promise<void>): Promise<void> {
  const dir = await makeTempDir();
  try {
    await fn(path.join(dir, 'vault'));
  } finally {
    await rmTempDir(dir);
  }
}

describe('makeDefaultWebResearcher (WS-B)', () => {
  it('is a valid, enabled, guarded public-web researcher with a safe id', () => {
    const r = makeDefaultWebResearcher();
    expect(isSafeResearcherId(r.id)).toBe(true);
    expect(r.id).toBe(DEFAULT_WEB_RESEARCHER_ID);
    expect(r.template).toBe('web');
    expect(r.egressTier).toBe('public-web');
    expect(r.enabled).toBe(true); // a disabled seed would leave the pipeline inert — the bug WS-B fixes
    expect(r.posture).toBe('guarded'); // findings route to Review, never auto-applied
    expect(r.topics).toEqual([]); // no pre-filter → eligible for every research-request
  });
});

describe('seedDefaultResearcherIfAbsent (WS-B)', () => {
  it('seeds one default Web researcher on a virgin vault (registry file absent)', async () => {
    await withRoot(async (root) => {
      const seeded = await seedDefaultResearcherIfAbsent(root);
      expect(seeded).toBe(true);
      const reg = await readResearcherRegistry(root);
      expect(reg).toHaveLength(1);
      expect(reg[0]).toMatchObject({ id: DEFAULT_WEB_RESEARCHER_ID, template: 'web', enabled: true });
    });
  });

  it('is idempotent — a second call does not re-seed (registry file now exists)', async () => {
    await withRoot(async (root) => {
      expect(await seedDefaultResearcherIfAbsent(root)).toBe(true);
      expect(await seedDefaultResearcherIfAbsent(root)).toBe(false); // file exists → respected
      expect(await readResearcherRegistry(root)).toHaveLength(1); // still exactly one
    });
  });

  it('respects a deliberately-EMPTY registry — never re-seeds over a cleared `[]`', async () => {
    await withRoot(async (root) => {
      await writeResearcherRegistry(root, []); // Principal cleared all researchers
      const seeded = await seedDefaultResearcherIfAbsent(root);
      expect(seeded).toBe(false); // empty file exists → not virgin → leave it
      expect(await readResearcherRegistry(root)).toEqual([]);
    });
  });

  it('writes the registry where readResearcherRegistry reads it', async () => {
    await withRoot(async (root) => {
      await seedDefaultResearcherIfAbsent(root);
      const raw = await fs.readFile(researcherRegistryPath(root), 'utf8');
      expect(JSON.parse(raw)).toHaveLength(1);
    });
  });
});
