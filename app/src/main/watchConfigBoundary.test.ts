// WATCH IPC-boundary loop-guard (SPEC-0037 WATCH-10, security). The end-to-end proof that
// `setActiveWatchFolder` enforces the loop-guard on the REAL wired path: a folderPath inside the vault is
// REFUSED and never persisted (a mis-wire that dropped the guard would let it through — fails-before/
// passes-after). Drives the genuine pipeline fn against a real staging worktree + registry + git commit;
// only the heavy stage/scheduler constructors are stubbed (WatchScheduler stubbed so no real chokidar).
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
import { readWatchRegistry } from '../kb/watchRegistry';
import { readEvents } from '../kb/activityIndex';
import { startPipeline, setActiveWatchFolder, removeActiveWatchFolder, listWatchFoldersForActive, stopPipeline } from './pipeline';

let dir: string | null = null;

afterEach(async () => {
  stopPipeline();
  if (dir) await fs.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  dir = null;
  vi.clearAllMocks();
});

// `setActiveWatchFolder` writes the registry + audit to the STAGING worktree (active.stagingWt), so reads
// in these assertions target staging (the same path the pipeline fn uses).
async function openVault(): Promise<{ vault: string; staging: string; outside: string }> {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'kb-watchbound-'));
  const vault = path.join(dir, 'vault');
  const outside = path.join(dir, 'dropbox');
  await createKb({ path: vault, initGitIfNeeded: true });
  const staging = await ensureStagingWorktree(vault);
  await fs.mkdir(outside, { recursive: true });
  await startPipeline(vault); // sets `active` (heavy stages + WatchScheduler stubbed)
  return { vault, staging, outside };
}

describe('setActiveWatchFolder — IPC-boundary loop-guard (WATCH-10)', () => {
  it('REFUSES a folderPath inside the vault — not persisted, distinct refused audit', async () => {
    const { vault, staging } = await openVault();
    const views = await setActiveWatchFolder({ id: 'bad', folderPath: path.join(vault, 'sources'), enabled: true });
    expect(views.find((v) => v.id === 'bad')).toBeUndefined(); // refused → no row
    expect((await readWatchRegistry(staging)).length).toBe(0); // nothing persisted (fail-safe)
    const refused = (await readEvents(staging, {})).find((e) => e.eventType === 'watch-config-change' && e.payload.refused === true);
    expect(refused).toBeDefined();
  });

  it('REFUSES the vault root itself and an ancestor (loop-guard)', async () => {
    const { vault, staging } = await openVault();
    await setActiveWatchFolder({ id: 'root', folderPath: vault, enabled: true });
    await setActiveWatchFolder({ id: 'parent', folderPath: path.dirname(vault), enabled: true });
    expect((await readWatchRegistry(staging)).length).toBe(0);
  });

  it('PERSISTS a loop-safe folder outside the vault, then removes it', async () => {
    const { staging, outside } = await openVault();
    const after = await setActiveWatchFolder({ id: 'ok', folderPath: outside, enabled: true, ignoreGlobs: ['*.tmp'] });
    expect(after.find((v) => v.id === 'ok')).toMatchObject({ folderPath: outside, enabled: true, ignoreGlobs: ['*.tmp'] });
    expect((await readWatchRegistry(staging)).map((f) => f.id)).toEqual(['ok']);

    const removed = await removeActiveWatchFolder('ok');
    expect(removed.find((v) => v.id === 'ok')).toBeUndefined();
    expect((await readWatchRegistry(staging)).length).toBe(0);
  });

  it('patches an existing folder without a folderPath change (no loop-guard needed)', async () => {
    const { outside } = await openVault();
    await setActiveWatchFolder({ id: 'ok', folderPath: outside, enabled: false });
    await setActiveWatchFolder({ id: 'ok', enabled: true, scope: 'work' });
    const views = await listWatchFoldersForActive();
    expect(views.find((v) => v.id === 'ok')).toMatchObject({ enabled: true, scope: 'work', folderPath: outside });
  });
});
