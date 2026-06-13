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
  clipboard: '', // SPEC-0038 QCAP-7: clipboard prefill source
  orch: null as null | { capture: (surface: string, payloads: unknown[]) => Promise<{ ids: string[]; captureBatch: string; committed: boolean }> },
  // SPEC-0038 QCAP-13: the mocked screenshot module's responses.
  screenshot: { status: 'unsupported', image: null } as { status: string; image: { handle: string; name: string } | null },
  screenshotBytes: null as Uint8Array | null, // what consumeScreenshotHandle returns for a valid handle
  clipboardImage: null as { handle: string; name: string } | null,
}));

const mocks = vi.hoisted(() => ({
  openExternal: vi.fn(async () => undefined), // ASK-14: shell.openExternal for the obsidian:// deep-link
  startPipeline: vi.fn(async () => undefined),
  pipelineControl: vi.fn(async () => ({ ok: true, message: 'Retrying Ada Lovelace.' })), // OBS-17
  recall: vi.fn(async () => ({ question: '', answer: 'mock recall', citations: [], grounded: true, toolCalls: 1, truncated: false })),
  // SPEC-0028 researcher pipeline helpers (the IPC handlers delegate to these).
  listResearchers: vi.fn(async () => [{ id: 'web-1', template: 'web', label: 'Web', egressTier: 'public-web', scope: 'global', enabled: false, schedule: 'off', posture: 'guarded', topics: [], lastRun: null }]),
  setResearcherConfig: vi.fn(async () => [{ id: 'web-1', template: 'web', label: 'Web', egressTier: 'public-web', scope: 'global', enabled: true, schedule: 'off', posture: 'guarded', topics: [], lastRun: null }]),
  runResearcherNow: vi.fn(async () => ({ ran: true, sourceIds: ['SRC1'], note: 'secondary source SRC1' })),
  listResearcherRuns: vi.fn(async () => [{ ts: '2026-06-02T00:00:00.000Z', eventType: 'researched', what: 'Atlas', sourceId: 'SRC1', citations: 1 }]),
  // SPEC-0037 WATCH pipeline helpers (the IPC handlers delegate to these).
  listWatchFolders: vi.fn(async () => [{ id: 'drop', folderPath: '/abs/inbox', label: 'drop', enabled: false, scope: 'global', sensitivity: 'internal', ignoreGlobs: [], watching: false, lastEvent: null }]),
  setWatchFolder: vi.fn(async () => [{ id: 'drop', folderPath: '/abs/inbox', label: 'drop', enabled: true, scope: 'global', sensitivity: 'internal', ignoreGlobs: [], watching: true, lastEvent: null }]),
  removeWatchFolder: vi.fn(async () => []),
}));

vi.mock('electron', () => ({
  app: { getPath: (): string => state.userData },
  ipcMain: { handle: (channel: string, fn: Handler) => state.handlers.set(channel, fn) },
  dialog: { showOpenDialog: vi.fn(async () => state.dialogResult) },
  shell: { openExternal: mocks.openExternal },
  clipboard: { readText: (): string => state.clipboard }, // SPEC-0038 QCAP-7
  BrowserWindow: { fromWebContents: (): null => null },
}));

// SPEC-0038 QCAP-13: mock the screenshot glue so the IPC handlers are tested without spawning
// `screencapture` / touching the real clipboard image. consumeScreenshotHandle returns bytes only
// for the registered handle (mirrors the issued-handle security boundary).
vi.mock('./quickCaptureScreenshot', () => ({
  captureScreenshot: vi.fn(async () => state.screenshot),
  consumeScreenshotHandle: vi.fn(async (handle: string) => (state.screenshot.image?.handle === handle ? state.screenshotBytes : null)),
  clipboardImageHandle: vi.fn(async () => state.clipboardImage),
}));

vi.mock('./pipeline', () => ({
  startPipeline: mocks.startPipeline,
  activePipeline: () => state.orch,
  activeStagingRoot: (): string | null => state.stagingRoot,
  listActiveReviews: async (): Promise<unknown[]> => [],
  answerActiveReview: async () => ({ ok: false, message: 'no active kb' }),
  pipelineControlForActive: mocks.pipelineControl,
  fullReplay: async () => ({ ok: false, message: 'no active kb' }),
  composeBacklog: async () => ({ ok: false, message: 'no active kb' }),
  composeBacklogStatus: async () => ({ ok: false, message: 'no active kb' }),
  listResearchersForActive: mocks.listResearchers,
  setActiveResearcherConfig: mocks.setResearcherConfig,
  runActiveResearcherNow: mocks.runResearcherNow,
  listResearcherRunsForActive: mocks.listResearcherRuns,
  listWatchFoldersForActive: mocks.listWatchFolders,
  setActiveWatchFolder: mocks.setWatchFolder,
  removeActiveWatchFolder: mocks.removeWatchFolder,
  // ASK-17: kb:ask reads the configured recall budget from here before calling recall.
  getActiveInstanceSettings: async () => ({ autonomyDefault: 'guarded', devLogLevel: 'info', quickCaptureAccelerator: 'Alt+Space', recallBudgetMs: 240_000 }),
}));

vi.mock('../kb/recall', () => ({ recall: mocks.recall }));

import { registerIpc, initPipeline } from './ipc';
import { createKb } from '../kb/vault';
import { obsidianOpenUri } from '../kb/citationLink';
import { setQuickCaptureAgent } from './quickCaptureService';
import type { QuickCaptureAgent, SelectionRead } from './quickCaptureAgent';
import type { ActivityFeedResult, AuditEvent, Lineage, OpenCitationResult, CaptureResult, QuickCaptureContext } from '../kb/types';

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
  state.clipboard = '';
  state.orch = null;
  state.screenshot = { status: 'unsupported', image: null };
  state.screenshotBytes = null;
  state.clipboardImage = null;
  setQuickCaptureAgent(null); // SPEC-0038: reset the QCAP agent singleton between tests (no cross-leak)
  mocks.startPipeline.mockClear();
  mocks.pipelineControl.mockClear();
  mocks.recall.mockClear();
  mocks.openExternal.mockClear();
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

describe('MACOS-7 — folder-permission IPC ("Asking for the keys")', () => {
  it('kb:probeVaultAccess writes+removes a hidden probe marker; succeeds on an accessible vault (leaves no trace)', async () => {
    await invoke<CreateKbResult>('kb:create', { path: vaultDir, name: 'KB', initGitIfNeeded: true });
    const res = await invoke<{ ok: boolean; denied: boolean }>('kb:probeVaultAccess', vaultDir);
    expect(res.ok).toBe(true);
    expect(res.denied).toBe(false);
    // the probe marker is cleaned up — nothing pollutes the user's vault (no synthetic artifact)
    await expect(fs.stat(path.join(vaultDir, '.kb', '.permission-probe'))).rejects.toThrow();
  });

  it('kb:probeVaultAccess refuses an off-config path (defense-in-depth) — never writes outside the active vault', async () => {
    await invoke<CreateKbResult>('kb:create', { path: vaultDir, name: 'KB', initGitIfNeeded: true }); // active = vaultDir
    const offConfig = path.join(vaultDir, 'elsewhere'); // a different path than the active vault
    const res = await invoke<{ ok: boolean; denied: boolean }>('kb:probeVaultAccess', offConfig);
    expect(res.ok).toBe(false);
    expect(res.denied).toBe(false); // a config mismatch is NOT a permission denial (doesn't route to Blocked)
    // the probe never touched the off-config path — no marker written there (rejected before any fs write)
    await expect(fs.stat(path.join(offConfig, '.kb', '.permission-probe'))).rejects.toThrow();
  });

  it('kb:probeVaultAccess refuses when no KB is configured (null active vault)', async () => {
    const res = await invoke<{ ok: boolean; denied: boolean }>('kb:probeVaultAccess', vaultDir);
    expect(res.ok).toBe(false); // no active vault yet → nothing to probe
    expect(res.denied).toBe(false);
  });

  it('kb:openSystemSettingsPrivacy deep-links to the Files-and-Folders Privacy anchor', async () => {
    const res = await invoke<{ ok: boolean; usedFallback?: boolean }>('kb:openSystemSettingsPrivacy');
    expect(res.ok).toBe(true);
    expect(res.usedFallback).toBeUndefined();
    expect(mocks.openExternal).toHaveBeenCalledWith('x-apple.systempreferences:com.apple.preference.security?Privacy_FilesAndFolders');
  });

  it('kb:openSystemSettingsPrivacy falls back to the general Privacy pane if the exact anchor rejects (never a no-op)', async () => {
    mocks.openExternal.mockRejectedValueOnce(new Error('anchor not resolvable'));
    const res = await invoke<{ ok: boolean; usedFallback?: boolean }>('kb:openSystemSettingsPrivacy');
    expect(res.ok).toBe(true);
    expect(res.usedFallback).toBe(true);
    expect(mocks.openExternal).toHaveBeenNthCalledWith(1, 'x-apple.systempreferences:com.apple.preference.security?Privacy_FilesAndFolders');
    expect(mocks.openExternal).toHaveBeenNthCalledWith(2, 'x-apple.systempreferences:com.apple.preference.security?Privacy');
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

describe('SPEC-0026 ASK-14 — kb:openCitation opens an Obsidian deep-link', () => {
  async function configureVault(p: string): Promise<void> {
    await fs.writeFile(path.join(state.userData, 'kb-app.config.json'), JSON.stringify({ activeVaultPath: p }) + '\n');
  }

  it('resolves a contained ref to an absolute path and opens the percent-encoded obsidian:// URI', async () => {
    await configureVault(vaultDir);
    const res = await invoke<OpenCitationResult>('kb:openCitation', 'entities/person/ada lovelace.md');
    expect(res).toEqual({ ok: true });
    // the URI is built from the ABSOLUTE vault path + encoded (the space → %20)
    const expectedAbs = path.join(path.resolve(vaultDir), 'entities/person/ada lovelace.md');
    const expectedUri = obsidianOpenUri(expectedAbs);
    expect(expectedUri).toContain('%20'); // the space is percent-encoded, not a raw URI break
    expect(mocks.openExternal).toHaveBeenCalledWith(expectedUri);
  });

  it('refuses a ref that escapes the vault (containment, #30) — no open', async () => {
    await configureVault(vaultDir);
    const res = await invoke<OpenCitationResult>('kb:openCitation', '../../etc/passwd');
    expect(res).toEqual({ ok: false, reason: 'invalid-ref' });
    expect(mocks.openExternal).not.toHaveBeenCalled();
  });

  it('refuses an empty/non-string ref', async () => {
    await configureVault(vaultDir);
    expect(await invoke<OpenCitationResult>('kb:openCitation', '')).toEqual({ ok: false, reason: 'invalid-ref' });
    expect(await invoke<OpenCitationResult>('kb:openCitation', 42)).toEqual({ ok: false, reason: 'invalid-ref' });
    expect(mocks.openExternal).not.toHaveBeenCalled();
  });

  it('returns no-vault when no KB is configured (nothing opened)', async () => {
    const res = await invoke<OpenCitationResult>('kb:openCitation', 'entities/x.md');
    expect(res).toEqual({ ok: false, reason: 'no-vault' });
    expect(mocks.openExternal).not.toHaveBeenCalled();
  });

  it('maps a failed open to open-failed (never rejects the renderer)', async () => {
    await configureVault(vaultDir);
    mocks.openExternal.mockRejectedValueOnce(new Error('no handler for obsidian://'));
    const res = await invoke<OpenCitationResult>('kb:openCitation', 'entities/x.md');
    expect(res).toEqual({ ok: false, reason: 'open-failed' });
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

describe('SPEC-0028 Researchers — Control Panel IPC delegates to the pipeline helpers', () => {
  it('kb:listResearchers returns the researcher views', async () => {
    const views = await invoke<{ id: string }[]>('kb:listResearchers');
    expect(mocks.listResearchers).toHaveBeenCalled();
    expect(views[0].id).toBe('web-1');
  });

  it('kb:setResearcherConfig forwards the patch + returns the refreshed list', async () => {
    const views = await invoke<{ enabled: boolean }[]>('kb:setResearcherConfig', { id: 'web-1', enabled: true });
    expect(mocks.setResearcherConfig).toHaveBeenCalledWith({ id: 'web-1', enabled: true });
    expect(views[0].enabled).toBe(true);
  });

  it('kb:listWatchFolders returns the watched-folder views (SPEC-0037)', async () => {
    const views = await invoke<{ id: string; watching: boolean }[]>('kb:listWatchFolders');
    expect(mocks.listWatchFolders).toHaveBeenCalled();
    expect(views[0].id).toBe('drop');
  });

  it('kb:setWatchFolder forwards the patch + returns the refreshed list', async () => {
    const views = await invoke<{ enabled: boolean }[]>('kb:setWatchFolder', { id: 'drop', enabled: true });
    expect(mocks.setWatchFolder).toHaveBeenCalledWith({ id: 'drop', enabled: true });
    expect(views[0].enabled).toBe(true);
  });

  it('kb:removeWatchFolder forwards the id + returns the refreshed list', async () => {
    const views = await invoke<unknown[]>('kb:removeWatchFolder', 'drop');
    expect(mocks.removeWatchFolder).toHaveBeenCalledWith('drop');
    expect(views).toEqual([]);
  });

  it('kb:runResearcherNow forwards the id + returns the run result', async () => {
    const res = await invoke<{ ran: boolean; sourceIds: string[] }>('kb:runResearcherNow', 'web-1');
    expect(mocks.runResearcherNow).toHaveBeenCalledWith('web-1');
    expect(res).toMatchObject({ ran: true, sourceIds: ['SRC1'] });
  });

  it('kb:runResearcherNow maps a thrown error to a not-found result (never rejects the renderer)', async () => {
    mocks.runResearcherNow.mockRejectedValueOnce(new Error('boom'));
    const res = await invoke<{ ran: boolean; reason?: string }>('kb:runResearcherNow', 'web-1');
    expect(res).toEqual({ ran: false, reason: 'not-found' });
  });

  it('kb:listResearcherRuns forwards the id + returns recent runs', async () => {
    const runs = await invoke<{ eventType: string }[]>('kb:listResearcherRuns', 'web-1');
    expect(mocks.listResearcherRuns).toHaveBeenCalledWith('web-1');
    expect(runs[0].eventType).toBe('researched');
  });
});

describe('SPEC-0030 OBS-17 — kb:pipelineControl delegates set-aside recovery', () => {
  it('forwards the {action, stage, itemId} request + returns the result', async () => {
    const res = await invoke<{ ok: boolean; message?: string }>('kb:pipelineControl', { action: 'retry', stage: 'claims', itemId: '01ADAID' });
    expect(mocks.pipelineControl).toHaveBeenCalledWith({ action: 'retry', stage: 'claims', itemId: '01ADAID' });
    expect(res).toEqual({ ok: true, message: 'Retrying Ada Lovelace.' });
  });
});

describe('SPEC-0046 COMPOSE-9 — kb:composeBacklog / kb:composeBacklogStatus are wired', () => {
  it('registers the backfill trigger + read-only status handlers and returns the pipeline result', async () => {
    expect(await invoke<{ ok: boolean; message: string }>('kb:composeBacklog')).toEqual({ ok: false, message: 'no active kb' });
    expect(await invoke<{ ok: boolean; message: string }>('kb:composeBacklogStatus')).toEqual({ ok: false, message: 'no active kb' });
  });
});

describe('SPEC-0038 QCAP — quick capture IPC', () => {
  it('QCAP-1: with no active KB, kb:quickCapture reports it (never silently drops)', async () => {
    state.orch = null;
    const res = await invoke<CaptureResult>('kb:quickCapture', { inputs: [{ kind: 'text', text: 'hi' }] });
    expect(res.ok).toBe(false);
  });

  it('QCAP-5/2: delivers onto the SPEC-0013 path with surface=quick-capture (fast-out — delegates to capture())', async () => {
    const capture = vi.fn(async () => ({ ids: ['Q1'], captureBatch: 'qb', committed: true }));
    state.orch = { capture };
    const res = await invoke<CaptureResult>('kb:quickCapture', { inputs: [{ kind: 'text', text: 'mid-read thought' }] });
    expect(capture).toHaveBeenCalledTimes(1);
    expect(capture).toHaveBeenCalledWith('quick-capture', [{ kind: 'text', text: 'mid-read thought' }]);
    expect(res).toEqual({ ok: true, ids: ['Q1'], captureBatch: 'qb', committed: true, message: 'Captured 1 item(s).' });
  });

  it('fork #3: the frictionless sheet is text-only — file inputs are ignored', async () => {
    const capture = vi.fn(async () => ({ ids: ['Q1'], captureBatch: 'qb', committed: true }));
    state.orch = { capture };
    await invoke<CaptureResult>('kb:quickCapture', {
      inputs: [
        { kind: 'text', text: 'note' },
        { kind: 'file', name: 'x.png', data: new Uint8Array([1]) },
      ],
    });
    expect(capture).toHaveBeenCalledWith('quick-capture', [{ kind: 'text', text: 'note' }]);
  });

  it('empty text → nothing captured', async () => {
    const capture = vi.fn(async () => ({ ids: [], captureBatch: 'qb', committed: true }));
    state.orch = { capture };
    const res = await invoke<CaptureResult>('kb:quickCapture', { inputs: [{ kind: 'text', text: '   ' }] });
    expect(capture).not.toHaveBeenCalled();
    expect(res.ok).toBe(false);
  });

  it('QCAP-7: kb:quickCaptureContext returns the clipboard + degrades selection when no agent is wired', async () => {
    state.clipboard = 'something I was reading';
    // No QCAP agent → no summon-time selection → selection null + accessibility unsupported (clipboard-only).
    const ctx = await invoke<QuickCaptureContext>('kb:quickCaptureContext');
    expect(ctx).toEqual({ clipboard: 'something I was reading', selection: null, accessibility: 'unsupported', clipboardImage: null, screenshotSupported: process.platform === 'darwin' });
  });

  it('QCAP-7/9 (Slice 2): kb:quickCaptureContext folds in the agent selection read at summon time', async () => {
    state.clipboard = 'on the clipboard';
    // A contract-faithful stub agent: takeSelectionContext returns what the real agent stashed on open().
    const stub = { takeSelectionContext: (): SelectionRead => ({ status: 'granted', text: 'the highlighted line' }) };
    setQuickCaptureAgent(stub as unknown as QuickCaptureAgent);
    const ctx = await invoke<QuickCaptureContext>('kb:quickCaptureContext');
    expect(ctx).toEqual({ clipboard: 'on the clipboard', selection: 'the highlighted line', accessibility: 'granted', clipboardImage: null, screenshotSupported: process.platform === 'darwin' });
  });

  it('QCAP-9 (Slice 2): a denied grant degrades — selection null, accessibility denied, clipboard still flows', async () => {
    state.clipboard = 'fallback text';
    const stub = { takeSelectionContext: (): SelectionRead => ({ status: 'denied', text: null }) };
    setQuickCaptureAgent(stub as unknown as QuickCaptureAgent);
    const ctx = await invoke<QuickCaptureContext>('kb:quickCaptureContext');
    expect(ctx).toEqual({ clipboard: 'fallback text', selection: null, accessibility: 'denied', clipboardImage: null, screenshotSupported: process.platform === 'darwin' });
  });

  it('QCAP-13: kb:quickCaptureContext folds in a clipboard image (the "paste an image" prefill)', async () => {
    state.clipboardImage = { handle: '/tmp/kb-qcap-shots/clip.png', name: 'pasted-image-1.png' };
    const ctx = await invoke<QuickCaptureContext>('kb:quickCaptureContext');
    expect(ctx.clipboardImage).toEqual({ handle: '/tmp/kb-qcap-shots/clip.png', name: 'pasted-image-1.png' });
  });

  it('QCAP-13: kb:quickCaptureScreenshot returns the capture result', async () => {
    state.screenshot = { status: 'granted', image: { handle: '/tmp/kb-qcap-shots/shot.png', name: 'screenshot-1.png' } };
    const res = await invoke<{ status: string; image: { handle: string } | null }>('kb:quickCaptureScreenshot', 'region');
    expect(res).toEqual({ status: 'granted', image: { handle: '/tmp/kb-qcap-shots/shot.png', name: 'screenshot-1.png' } });
  });

  it('QCAP-13: kb:quickCapture resolves a screenshot input → a file payload on the SPEC-0013 path (surface=quick-capture)', async () => {
    const capture = vi.fn(async () => ({ ids: ['SHOT1'], captureBatch: 'b1', committed: true }));
    state.orch = { capture };
    state.screenshot = { status: 'granted', image: { handle: '/tmp/kb-qcap-shots/shot.png', name: 'screenshot-1.png' } };
    state.screenshotBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47]); // PNG magic
    const res = await invoke<CaptureResult>('kb:quickCapture', {
      inputs: [{ kind: 'screenshot', handle: '/tmp/kb-qcap-shots/shot.png', name: 'screenshot-1.png' }],
    });
    expect(res.ok).toBe(true);
    expect(capture).toHaveBeenCalledTimes(1);
    const [surface, payloads] = capture.mock.calls[0] as unknown as [string, Array<{ kind: string; name?: string }>];
    expect(surface).toBe('quick-capture');
    expect(payloads).toEqual([{ kind: 'file', name: 'screenshot-1.png', data: new Uint8Array([0x89, 0x50, 0x4e, 0x47]) }]);
  });

  it('QCAP-13: a screenshot handle we did NOT issue is ignored (nothing captured) — security boundary', async () => {
    const capture = vi.fn(async () => ({ ids: ['x'], captureBatch: 'b', committed: true }));
    state.orch = { capture };
    state.screenshot = { status: 'granted', image: { handle: '/tmp/kb-qcap-shots/legit.png', name: 'legit.png' } };
    state.screenshotBytes = new Uint8Array([1, 2, 3]);
    // A forged handle (not the one the mock "issued") → consume returns null → no payload → nothing captured.
    const res = await invoke<CaptureResult>('kb:quickCapture', {
      inputs: [{ kind: 'screenshot', handle: '/etc/passwd', name: 'evil.png' }],
    });
    expect(res.ok).toBe(false);
    expect(res.message).toBe('Nothing to capture.');
    expect(capture).not.toHaveBeenCalled();
  });

  it('QCAP-13: kb:openScreenRecordingSettings deep-links to the Screen-Recording anchor, falls back to Privacy', async () => {
    const ok = await invoke<{ ok: boolean; usedFallback?: boolean }>('kb:openScreenRecordingSettings');
    expect(ok).toEqual({ ok: true });
    expect(mocks.openExternal).toHaveBeenCalledWith('x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture');
    mocks.openExternal.mockClear();
    mocks.openExternal.mockRejectedValueOnce(new Error('anchor not resolvable'));
    const fb = await invoke<{ ok: boolean; usedFallback?: boolean }>('kb:openScreenRecordingSettings');
    expect(fb).toEqual({ ok: true, usedFallback: true });
    expect(mocks.openExternal).toHaveBeenNthCalledWith(2, 'x-apple.systempreferences:com.apple.preference.security?Privacy');
  });

  it('QCAP-9 (Slice 2): kb:openAccessibilitySettings deep-links to the Accessibility Privacy anchor', async () => {
    const res = await invoke<{ ok: boolean; usedFallback?: boolean }>('kb:openAccessibilitySettings');
    expect(res.ok).toBe(true);
    expect(res.usedFallback).toBeUndefined();
    expect(mocks.openExternal).toHaveBeenCalledWith('x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility');
  });

  it('QCAP-9 (Slice 2): kb:openAccessibilitySettings falls back to the general Privacy pane (never a no-op)', async () => {
    mocks.openExternal.mockRejectedValueOnce(new Error('anchor not resolvable'));
    const res = await invoke<{ ok: boolean; usedFallback?: boolean }>('kb:openAccessibilitySettings');
    expect(res).toEqual({ ok: true, usedFallback: true });
    expect(mocks.openExternal).toHaveBeenNthCalledWith(1, 'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility');
    expect(mocks.openExternal).toHaveBeenNthCalledWith(2, 'x-apple.systempreferences:com.apple.preference.security?Privacy');
  });

  it('QCAP-2: kb:quickCaptureClose resolves (no-op when no agent is wired)', async () => {
    await expect(invoke<void>('kb:quickCaptureClose')).resolves.toBeUndefined();
  });
});
