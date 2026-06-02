// SPEC-0009 SETUP-2 / SETUP-6 — main-process IPC tier.
//
// SETUP-2: the Principal picks a root folder (kb:pickFolder) and that folder becomes the
//          vault root (kb:create → persisted activeVaultPath → kb:getState).
// SETUP-6: a later launch loads the existing KB — kb:getState reports the vault + its
//          config (the renderer's onboarding gate), and initPipeline hands that vault to
//          the main process to manage. No re-onboarding.
//
// Electron is mocked: ipcMain.handle captures the handlers so we can invoke them directly,
// dialog.showOpenDialog returns a scripted pick, and app.getPath('userData') points at a
// temp dir. The pipeline is mocked so no real staging worktree/orchestrator spins up — we
// only assert the main process is asked to manage the right vault. createKb itself is real
// (a genuine git repo in a temp dir), so the pick → vault-root chain is exercised end-to-end.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { makeTempDir, rmTempDir } from '../../test/tempVault';
import type { AppState, CreateKbResult } from '../kb/types';

type Handler = (event: unknown, ...args: unknown[]) => unknown;

const state = vi.hoisted(() => ({
  userData: '',
  dialogResult: { canceled: false, filePaths: [] as string[] },
  handlers: new Map<string, (event: unknown, ...args: unknown[]) => unknown>(),
  stagingRoot: null as string | null, // SPEC-0029: the active staging worktree the activity handlers read
}));

const mocks = vi.hoisted(() => ({
  startPipeline: vi.fn(async () => undefined),
  recall: vi.fn(async () => ({ question: '', answer: 'mock recall', citations: [], grounded: true, toolCalls: 1, truncated: false })),
}));

vi.mock('electron', () => ({
  app: { getPath: (): string => state.userData },
  ipcMain: { handle: (channel: string, fn: Handler) => state.handlers.set(channel, fn) },
  dialog: { showOpenDialog: vi.fn(async () => state.dialogResult) },
  BrowserWindow: { fromWebContents: (): null => null },
}));

vi.mock('./pipeline', () => ({
  startPipeline: mocks.startPipeline,
  activePipeline: (): null => null,
  activeStagingRoot: (): string | null => state.stagingRoot,
  listActiveReviews: async (): Promise<unknown[]> => [],
  answerActiveReview: async () => ({ ok: false, message: 'no active kb' }),
  fullReplay: async () => ({ ok: false, message: 'no active kb' }),
}));

vi.mock('../kb/recall', () => ({ recall: mocks.recall }));

import { registerIpc, initPipeline } from './ipc';
import { createKb } from '../kb/vault';
import type { ActivityFeedResult, AuditEvent, Lineage } from '../kb/types';

async function invoke<T>(channel: string, ...args: unknown[]): Promise<T> {
  const fn = state.handlers.get(channel);
  if (!fn) throw new Error(`no handler registered for ${channel}`);
  return (await fn({ sender: {} }, ...args)) as T;
}

let vaultDir: string;

beforeEach(async () => {
  state.userData = await makeTempDir('kb-userdata-');
  vaultDir = await makeTempDir('kb-vault-');
  state.dialogResult = { canceled: false, filePaths: [] };
  state.handlers.clear();
  state.stagingRoot = null;
  mocks.startPipeline.mockClear();
  mocks.recall.mockClear();
  delete process.env.KB_ASK_E2E_STUB;
  registerIpc();
});

afterEach(async () => {
  await rmTempDir(state.userData);
  await rmTempDir(vaultDir);
});

describe('SETUP-2 — the picked folder becomes the vault root', () => {
  it('kb:pickFolder returns the folder the Principal chose', async () => {
    state.dialogResult = { canceled: false, filePaths: [vaultDir] };
    expect(await invoke<string | null>('kb:pickFolder')).toBe(vaultDir);
  });

  it('kb:pickFolder returns null when the chooser is canceled', async () => {
    state.dialogResult = { canceled: true, filePaths: [] };
    expect(await invoke<string | null>('kb:pickFolder')).toBeNull();
  });

  it('the picked folder, once created, is the active vault root the app manages', async () => {
    // 1. Principal picks the folder…
    state.dialogResult = { canceled: false, filePaths: [vaultDir] };
    const picked = await invoke<string | null>('kb:pickFolder');
    expect(picked).toBe(vaultDir);

    // 2. …and creates the KB there.
    const res = await invoke<CreateKbResult>('kb:create', {
      path: picked,
      name: 'My KB',
      initGitIfNeeded: true,
    });
    expect(res.ok).toBe(true);

    // 3. The picked folder is now THE vault root: persisted + reported by getState…
    const app = await invoke<AppState>('kb:getState');
    expect(app.activeVaultPath).toBe(path.resolve(vaultDir));
    expect(app.vaultConfig?.name).toBe('My KB');

    // …and the main process is asked to manage exactly that vault.
    expect(mocks.startPipeline).toHaveBeenCalledWith(path.resolve(vaultDir));
  });
});

describe('SETUP-6 — later launches load the existing KB (no re-onboarding)', () => {
  it('first run (no configured KB): getState reports no vault → setup is shown', async () => {
    const app = await invoke<AppState>('kb:getState');
    expect(app.activeVaultPath).toBeNull();
    expect(app.vaultConfig).toBeNull();
  });

  it('first run: initPipeline starts nothing when no KB is configured', async () => {
    await initPipeline();
    expect(mocks.startPipeline).not.toHaveBeenCalled();
  });

  it('a 2nd launch with a configured KB loads it and skips onboarding', async () => {
    // --- Launch #1: configure a KB at the picked folder. ---
    state.dialogResult = { canceled: false, filePaths: [vaultDir] };
    await invoke<CreateKbResult>('kb:create', { path: vaultDir, name: 'Relaunch KB', initGitIfNeeded: true });

    // --- Launch #2: a fresh process re-registers handlers; only the persisted config
    //     (in userData) carries over. ---
    mocks.startPipeline.mockClear();
    state.handlers.clear();
    registerIpc();

    // The renderer's onboarding gate is `activeVaultPath && vaultConfig`. Both present →
    // it mounts the shell instead of the Setup wizard. No re-onboarding.
    const app = await invoke<AppState>('kb:getState');
    expect(app.activeVaultPath).toBe(path.resolve(vaultDir));
    expect(app.vaultConfig).not.toBeNull();
    expect(app.vaultConfig?.name).toBe('Relaunch KB');

    // And on launch the main process resumes managing the configured vault.
    await initPipeline();
    expect(mocks.startPipeline).toHaveBeenCalledWith(path.resolve(vaultDir));
  });

  it('a 2nd launch whose configured vault has vanished does not falsely report a loaded KB', async () => {
    // Configure, then delete the vault from disk (moved/deleted between launches).
    state.dialogResult = { canceled: false, filePaths: [vaultDir] };
    await invoke<CreateKbResult>('kb:create', { path: vaultDir, name: 'Gone KB', initGitIfNeeded: true });
    await rmTempDir(vaultDir);

    const app = await invoke<AppState>('kb:getState');
    // Path is still remembered, but the config can't load → renderer's gate (needs both)
    // falls back to setup rather than mounting a broken shell.
    expect(app.activeVaultPath).toBe(path.resolve(vaultDir));
    expect(app.vaultConfig).toBeNull();

    // initPipeline likewise refuses to manage a vault whose config is gone
    // (clear the call kb:create made on launch #1 so we observe only this launch).
    mocks.startPipeline.mockClear();
    await initPipeline();
    expect(mocks.startPipeline).not.toHaveBeenCalled();
  });
});

describe('SPEC-0026 ASK — kb:ask grounded recall', () => {
  async function configureVault(p: string): Promise<void> {
    await fs.writeFile(path.join(state.userData, 'kb-app.config.json'), JSON.stringify({ activeVaultPath: p }) + '\n');
  }

  it('runs recall on the active vault root and returns its result', async () => {
    await configureVault(vaultDir);
    const res = await invoke<{ answer: string }>('kb:ask', { question: 'Who?', history: [] });
    // 3rd arg carries the resolved BYOA cliPath (BUG #65); its value is env-dependent, so match loosely.
    expect(mocks.recall).toHaveBeenCalledWith(path.resolve(vaultDir), { question: 'Who?', history: [] }, expect.any(Object));
    expect(res.answer).toBe('mock recall');
  });

  it('returns an honest ungrounded result when no KB is configured (recall not run)', async () => {
    const res = await invoke<{ grounded: boolean; answer: string }>('kb:ask', { question: 'Who?' });
    expect(res.grounded).toBe(false);
    expect(res.answer).toContain('No active knowledge base');
    expect(mocks.recall).not.toHaveBeenCalled();
  });

  it('KB_ASK_E2E_STUB short-circuits to a deterministic grounded answer (no recall, no vault)', async () => {
    process.env.KB_ASK_E2E_STUB = '1';
    const res = await invoke<{ grounded: boolean; citations: { ref: string }[] }>('kb:ask', { question: 'Who?' });
    expect(res.grounded).toBe(true);
    expect(res.citations[0].ref).toBe('claims/person/ada-lovelace.md');
    expect(mocks.recall).not.toHaveBeenCalled();
  });
});

describe('SPEC-0029 Audit & Activity — read-only IPC over the active staging worktree', () => {
  /** Seed a KB with a small spread of real audit lines and point the (mocked) staging root at it. */
  async function seedActivityVault(): Promise<void> {
    await createKb({ path: vaultDir, name: 'Activity KB', initGitIfNeeded: true });
    const write = async (rel: string, lines: Record<string, unknown>[]): Promise<void> => {
      const abs = path.join(vaultDir, rel);
      await fs.mkdir(path.dirname(abs), { recursive: true });
      await fs.appendFile(abs, lines.map((l) => JSON.stringify(l)).join('\n') + '\n', 'utf8');
    };
    await write(path.join('sources', '2026', '01', 'S1', 'audit.jsonl'), [
      { action: 'archived', id: 'S1', archivedAt: '2026-01-01T00:00:00.000Z', decision: {}, agent: { via: 'deterministic' } },
      { ts: '2026-01-01T00:01:00.000Z', stage: 'claims', runId: 'C1', entityId: 'E1', sourceId: 'S1', event: 'claimed', claims: 2 },
    ]);
    await write(path.join('connect', 'audit.jsonl'), [
      { ts: '2026-01-01T00:02:00.000Z', stage: 'connect', runId: 'N1', blockKey: 'k', event: 'resolved', node: 'entities/2026/01/E1.md', candidates: 1, merged: 0 },
    ]);
    state.stagingRoot = vaultDir;
  }

  it('returns empty results when no KB is active (no staging root)', async () => {
    state.stagingRoot = null;
    expect(await invoke<ActivityFeedResult>('kb:activityFeed')).toEqual({ entries: [], total: 0, truncated: false });
    expect(await invoke<AuditEvent[]>('kb:activityEvents')).toEqual([]);
    const lin = await invoke<Lineage>('kb:activityLineage', 'E1');
    expect(lin).toMatchObject({ subjectId: 'E1', kind: 'unknown', events: [] });
  });

  it('kb:activityFeed returns curated entries + the window-cap signal', async () => {
    await seedActivityVault();
    const res = await invoke<ActivityFeedResult>('kb:activityFeed');
    expect(res.total).toBe(3);
    expect(res.truncated).toBe(false);
    expect(res.entries.length).toBeGreaterThan(0);
    expect(res.entries[0]).toHaveProperty('summary');
    expect(res.entries[0]).toHaveProperty('events'); // raw events ride along for drill-down
  });

  it('kb:activityFeed honors an actor filter', async () => {
    await seedActivityVault();
    const res = await invoke<ActivityFeedResult>('kb:activityFeed', { actors: ['connect'] });
    expect(res.entries.every((e) => e.actor === 'connect')).toBe(true);
    expect(res.entries.length).toBe(1);
  });

  it('kb:activityEvents returns raw events filtered across the full audit', async () => {
    await seedActivityVault();
    const all = await invoke<AuditEvent[]>('kb:activityEvents');
    expect(all.map((e) => e.actor)).toEqual(['connect', 'claims', 'archivist']); // newest-first
    const byEntity = await invoke<AuditEvent[]>('kb:activityEvents', { subjectId: 'E1' });
    expect(byEntity.map((e) => e.actor).sort()).toEqual(['claims', 'connect']);
  });

  it('kb:activityLineage traces a subject from the audit', async () => {
    await seedActivityVault();
    const lin = await invoke<Lineage>('kb:activityLineage', 'E1');
    expect(lin.kind).toBe('entity');
    expect(lin.sources).toContain('S1');
    expect(lin.events.length).toBeGreaterThanOrEqual(2);
  });
});
