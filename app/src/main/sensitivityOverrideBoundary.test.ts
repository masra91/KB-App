// SENSE override IPC-boundary (SPEC-0043 SENSE-7/8, security). End-to-end proof that the REAL wired
// `setActiveSourceSensitivity` path: validates the id (#29 — only a real ULID reaches a source path),
// persists the Replay-sticky override, re-stamps the live `source.md` to `by: principal`, and audits the
// change. Drives the genuine pipeline fn against a real staging worktree + git; heavy stages stubbed.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const h = vi.hoisted(() => {
  class StubStage {
    start(): void {}
    stop(): void {}
    poke(): void {}
  }
  class StubWatch {
    start(): void {}
    stop(): void {}
    async refresh(): Promise<void> {}
    watchingIds(): Set<string> {
      return new Set();
    }
  }
  return { reap: vi.fn(async () => ({ worktrees: 0, branches: 0 })), StubStage, StubWatch };
});
vi.mock('../kb/canonicalAdvance', async (orig) => ({ ...(await orig<typeof import('../kb/canonicalAdvance')>()), reapEphemeralWorktrees: h.reap }));
vi.mock('../kb/orchestrator', async (orig) => ({ ...(await orig<typeof import('../kb/orchestrator')>()), Orchestrator: h.StubStage }));
vi.mock('../kb/decomposeStage', async (orig) => ({ ...(await orig<typeof import('../kb/decomposeStage')>()), DecomposeStage: h.StubStage }));
vi.mock('../kb/connectStage', async (orig) => ({ ...(await orig<typeof import('../kb/connectStage')>()), ConnectStage: h.StubStage }));
vi.mock('../kb/claimsStage', async (orig) => ({ ...(await orig<typeof import('../kb/claimsStage')>()), ClaimsStage: h.StubStage }));
vi.mock('../kb/jobScheduler', async (orig) => ({ ...(await orig<typeof import('../kb/jobScheduler')>()), JobScheduler: h.StubStage }));
vi.mock('../kb/researcherScheduler', async (orig) => ({ ...(await orig<typeof import('../kb/researcherScheduler')>()), ResearcherScheduler: h.StubStage }));
vi.mock('../kb/intakeScheduler', async (orig) => ({ ...(await orig<typeof import('../kb/intakeScheduler')>()), IntakeScheduler: h.StubStage }));
vi.mock('../kb/watchScheduler', async (orig) => ({ ...(await orig<typeof import('../kb/watchScheduler')>()), WatchScheduler: h.StubWatch }));

import { createKb } from '../kb/vault';
import { ensureStagingWorktree } from '../kb/stagingWorktree';
import { captureToInbox } from '../kb/ingest';
import { archiveOne } from '../kb/orchestrator';
import { readSensitivityOverrides } from '../kb/sensitivityOverride';
import { readEvents } from '../kb/activityIndex';
import { ulid } from '../kb/ulid';
import { startPipeline, setActiveSourceSensitivity, stopPipeline } from './pipeline';

let dir: string | null = null;

afterEach(async () => {
  stopPipeline();
  if (dir) await fs.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  dir = null;
  vi.clearAllMocks();
});

/** Open a vault + staging, then capture & archive one source into staging; returns its id + the source.md path. */
async function openVaultWithSource(): Promise<{ staging: string; id: string; srcMd: string }> {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'kb-sensebound-'));
  const vault = path.join(dir, 'vault');
  await createKb({ path: vault, initGitIfNeeded: true });
  const staging = await ensureStagingWorktree(vault);
  await startPipeline(vault); // sets `active`; heavy stages stubbed
  const { ids } = await captureToInbox(staging, 'in-app-panel', [{ kind: 'text', text: 'a note' }]);
  const id = ids[0];
  const destRel = await archiveOne(staging, id);
  return { staging, id, srcMd: path.join(staging, destRel, 'source.md') };
}

describe('setActiveSourceSensitivity — SENSE-7/8 override IPC boundary', () => {
  it('rejects a non-ULID id (#29 guard) and a missing source — nothing written', async () => {
    await openVaultWithSource();
    expect(await setActiveSourceSensitivity('../etc/passwd', 'shareable')).toEqual({ ok: false, reason: 'bad-id' });
    expect(await setActiveSourceSensitivity(ulid(Date.now()), 'shareable')).toEqual({ ok: false, reason: 'not-found' });
  });

  it('applies a Principal override: re-stamps source.md `by: principal`, persists the sticky store, audits from→to', async () => {
    const { staging, id, srcMd } = await openVaultWithSource();
    expect(await fs.readFile(srcMd, 'utf8')).toContain('  by: default'); // precondition: classifier default

    const res = await setActiveSourceSensitivity(id, 'confidential');
    expect(res).toEqual({ ok: true, sensitivity: 'confidential' });

    const md = await fs.readFile(srcMd, 'utf8');
    expect(md).toContain('sensitivity: confidential');
    expect(md).toContain('  by: principal');

    // Replay-sticky store carries it (so a rebuild re-applies; the classifier never overwrites).
    expect((await readSensitivityOverrides(staging))[id].label).toBe('confidential');

    // SENSE-8: audited panel event with the from→to + by:principal provenance.
    const ev = (await readEvents(staging, {})).find((e) => e.eventType === 'sensitivity-override');
    expect(ev).toBeDefined();
    expect(ev!.payload.to).toBe('confidential');
    expect(ev!.payload.by).toBe('principal');
  });

  it('an empty label CLEARS the override (back to classifier/default)', async () => {
    const { staging, id } = await openVaultWithSource();
    await setActiveSourceSensitivity(id, 'shareable');
    expect((await readSensitivityOverrides(staging))[id]).toBeDefined();
    await setActiveSourceSensitivity(id, '');
    expect((await readSensitivityOverrides(staging))[id]).toBeUndefined();
  });

  it('accepts a custom label verbatim (SENSE-1 custom labels)', async () => {
    const { staging, id, srcMd } = await openVaultWithSource();
    await setActiveSourceSensitivity(id, 'legal-hold');
    expect((await readSensitivityOverrides(staging))[id].label).toBe('legal-hold');
    expect(await fs.readFile(srcMd, 'utf8')).toContain('sensitivity: legal-hold');
  });
});
