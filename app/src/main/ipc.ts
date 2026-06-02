// IPC handlers — the main-process side of the KbApi contract (preload mirrors it).
import { ipcMain, dialog, BrowserWindow, type OpenDialogOptions } from 'electron';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { inspectPath, createKb } from '../kb/vault';
import { readAppConfig, writeAppConfig } from './appConfig';
import {
  startPipeline,
  activePipeline,
  activeStagingRoot,
  listActiveReviews,
  answerActiveReview,
  fullReplay,
  listJobsForActive,
  setActiveJobConfig,
  runActiveJobNow,
  getActiveInstanceSettings,
  setActiveInstanceSettings,
  listAgentsForActive,
} from './pipeline';
import { recall } from '../kb/recall';
import { buildActivityIndex, readEvents, filterEvents } from '../kb/activityIndex';
import { buildFeed } from '../kb/activityDigest';
import { traceLineage } from '../kb/lineage';
import { resolveExecutable } from './resolvePath';
import type { CapturePayload } from '../kb/ingest';
import type {
  AppState,
  VaultConfig,
  CreateKbOptions,
  CaptureRequest,
  CaptureResult,
  PipelineStatus,
  ReviewSummary,
  AnswerReviewRequest,
  AnswerReviewResult,
  FullReplayResult,
  AskRequest,
  AskResult,
  JobView,
  JobConfigPatch,
  RunJobResult,
  ActivityFilter,
  ActivityFeedResult,
  AuditEvent,
  Lineage,
  InstanceSettings,
  AgentView,
} from '../kb/types';

async function loadVaultConfig(vaultPath: string): Promise<VaultConfig | null> {
  try {
    return JSON.parse(await fs.readFile(path.join(vaultPath, '.kb', 'config.json'), 'utf8')) as VaultConfig;
  } catch {
    return null; // vault moved/deleted/invalid
  }
}

const NO_PIPELINE: CaptureResult = {
  ok: false,
  ids: [],
  captureBatch: null,
  committed: false,
  message: 'No active knowledge base.',
};

/** Start the orchestrator if a valid KB is already configured (called on app launch). */
export async function initPipeline(): Promise<void> {
  const cfg = await readAppConfig();
  if (cfg.activeVaultPath && (await loadVaultConfig(cfg.activeVaultPath))) {
    await startPipeline(path.resolve(cfg.activeVaultPath));
  }
}

export function registerIpc(): void {
  ipcMain.handle('kb:getState', async (): Promise<AppState> => {
    const cfg = await readAppConfig();
    const vaultConfig = cfg.activeVaultPath ? await loadVaultConfig(cfg.activeVaultPath) : null;
    return { activeVaultPath: cfg.activeVaultPath, vaultConfig };
  });

  ipcMain.handle('kb:pickFolder', async (e): Promise<string | null> => {
    const win = BrowserWindow.fromWebContents(e.sender);
    const opts: OpenDialogOptions = {
      title: 'Choose a folder for your Knowledge Base',
      properties: ['openDirectory', 'createDirectory'],
    };
    const res = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts);
    return res.canceled || res.filePaths.length === 0 ? null : res.filePaths[0];
  });

  ipcMain.handle('kb:inspect', async (_e, p: string) => inspectPath(p));

  ipcMain.handle('kb:create', async (_e, opts: CreateKbOptions) => {
    const result = await createKb(opts);
    if (result.ok) {
      const vaultPath = path.resolve(opts.path);
      await writeAppConfig({ activeVaultPath: vaultPath });
      await startPipeline(vaultPath); // the KB is live — start draining captures immediately
    }
    return result;
  });

  // SPEC-0013 CAPTURE-1/2: fire-and-forget capture of text + dropped files. The renderer
  // sends file bytes; we hand them to the active orchestrator, which preserves+commits.
  ipcMain.handle('kb:capture', async (_e, req: CaptureRequest): Promise<CaptureResult> => {
    const orch = activePipeline();
    if (!orch) return NO_PIPELINE;

    const payloads: CapturePayload[] = [];
    for (const input of req.inputs) {
      if (input.kind === 'text') {
        if (input.text.trim().length > 0) payloads.push({ kind: 'text', text: input.text });
      } else {
        payloads.push({ kind: 'file', name: input.name, data: new Uint8Array(input.data) });
      }
    }
    if (payloads.length === 0) {
      return { ...NO_PIPELINE, message: 'Nothing to capture.' };
    }

    try {
      const out = await orch.capture('in-app-panel', payloads);
      return { ok: true, ids: out.ids, captureBatch: out.captureBatch, committed: out.committed, message: `Captured ${out.ids.length} item(s).` };
    } catch (err) {
      return { ...NO_PIPELINE, message: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle('kb:pipelineStatus', async (): Promise<PipelineStatus> => {
    const orch = activePipeline();
    return orch ? orch.status() : { queueDepth: 0, processing: null, lastArchived: null, updatedAt: null };
  });

  // SPEC-0018 REVIEW-10/11: the "needs you" queue + answering, over the typed contract.
  ipcMain.handle('kb:listReviews', async (): Promise<ReviewSummary[]> => {
    const reviews = await listActiveReviews();
    return reviews.map((r) => ({
      id: r.id,
      question: r.question,
      detail: r.detail,
      stage: r.raisedBy.stage,
      refs: r.subject.refs ?? [],
      createdAt: r.createdAt,
    }));
  });

  ipcMain.handle('kb:answerReview', async (_e, req: AnswerReviewRequest): Promise<AnswerReviewResult> => {
    const { ok, message } = await answerActiveReview(req.id, { verdict: req.verdict, note: req.note });
    return { ok, message };
  });

  // SPEC-0022 REPLAY-1/2: Principal-initiated "clean & rebuild". The renderer gates this behind a
  // confirm dialog; here we just run it (purge + epoch reset on staging, republish main, resume).
  ipcMain.handle('kb:fullReplay', async (): Promise<FullReplayResult> => {
    try {
      return await fullReplay();
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : String(err) };
    }
  });

  // SPEC-0026 ASK-1/2/8: grounded NL recall (pull-only — only on the Principal's ask). Runs the
  // recall engine on the active vault root (the evergreen `main` checkout). Multi-turn history is
  // supplied by the Ask view (ephemeral session, F5). KB_ASK_E2E_STUB short-circuits to a
  // deterministic answer so the UI→IPC→render path is e2e-testable without a live SDK/CLI.
  ipcMain.handle('kb:ask', async (_e, req: AskRequest): Promise<AskResult> => {
    if (process.env.KB_ASK_E2E_STUB) return stubbedAsk(req);
    const cfg = await readAppConfig();
    if (!cfg.activeVaultPath) {
      return { question: req.question, answer: 'No active knowledge base — set one up first.', citations: [], grounded: false, toolCalls: 0, truncated: false };
    }
    // BUG #65: hand recall the resolved BYOA `copilot` path so the SDK spawns it in the packaged
    // app (PATH was ensured at boot, STACK-9). Null → SDK default search (dev fallback).
    const cliPath = resolveExecutable('copilot') ?? undefined;
    return recall(path.resolve(cfg.activeVaultPath), { question: req.question, history: req.history }, { cliPath });
  });

  // SPEC-0027 PANEL-2/6/7: the Control Panel's Jobs view — list manageable jobs, persist config
  // changes (enable/schedule/posture), and trigger a manual "Run now". The renderer gates risky
  // changes behind a confirm; the main process owns the registry + scheduler.
  ipcMain.handle('kb:listJobs', async (): Promise<JobView[]> => listJobsForActive());

  ipcMain.handle('kb:setJobConfig', async (_e, patch: JobConfigPatch): Promise<JobView[]> => setActiveJobConfig(patch));

  ipcMain.handle('kb:runJobNow', async (_e, id: string): Promise<RunJobResult> => {
    try {
      return await runActiveJobNow(id);
    } catch {
      return { ran: false, reason: 'not-found' };
    }
  });

  // SPEC-0029 Audit & Activity (read-only). All three read the active `staging` worktree — the full
  // working-zone audit (AUDIT-10), a superset of the evergreen archive. Empty when no KB is active.

  // AUDIT-5: the curated feed. Uses buildActivityIndex (full rebuild → guaranteed-fresh) rather than
  // the cached load, so a recent recall whose audit landed without a HEAD move still shows (QA
  // carry-forward). The optional filter narrows within the recent window; `total`/`truncated` are
  // surfaced so the UI never silently truncates.
  ipcMain.handle('kb:activityFeed', async (_e, filter?: ActivityFilter): Promise<ActivityFeedResult> => {
    const root = activeStagingRoot();
    if (!root) return { entries: [], total: 0, truncated: false };
    const index = await buildActivityIndex(root);
    const events = filter ? filterEvents(index.events, filter) : index.events;
    return { entries: buildFeed(events), total: index.total, truncated: index.truncated };
  });

  // AUDIT-5/7: raw events for drill-down + filter/search across the FULL audit (not the capped feed).
  ipcMain.handle('kb:activityEvents', async (_e, filter?: ActivityFilter): Promise<AuditEvent[]> => {
    const root = activeStagingRoot();
    return root ? readEvents(root, filter ?? {}) : [];
  });

  // AUDIT-6: trace a subject's provenance + transformation timeline + decisions, from the full audit.
  ipcMain.handle('kb:activityLineage', async (_e, id: string): Promise<Lineage> => {
    const root = activeStagingRoot();
    if (!root) return { subjectId: id, kind: 'unknown', sources: [], events: [], decisions: [] };
    return traceLineage(root, id);
  });

  // SPEC-0027 PANEL-3/5: the Control Panel's Settings (per-Instance autonomy default) + Agents
  // (observe-only). The renderer gates a → Autonomous default behind a confirm; the main process
  // owns the per-vault `.kb/instance.json` + emits the conforming audit.
  ipcMain.handle('kb:getInstanceSettings', async (): Promise<InstanceSettings> => getActiveInstanceSettings());

  ipcMain.handle('kb:setInstanceSettings', async (_e, s: InstanceSettings): Promise<InstanceSettings> => setActiveInstanceSettings(s));

  ipcMain.handle('kb:listAgents', async (): Promise<AgentView[]> => listAgentsForActive());
}

/** Deterministic recall result for the CI e2e happy-path (KB_ASK_E2E_STUB). Never used in prod. */
function stubbedAsk(req: AskRequest): AskResult {
  return {
    question: req.question,
    answer: '**Ada Lovelace** is regarded as the first computer programmer. [1]',
    citations: [{ kind: 'claim', ref: 'claims/person/ada-lovelace.md', label: 'first computer programmer' }],
    grounded: true,
    toolCalls: 2,
    truncated: false,
  };
}
