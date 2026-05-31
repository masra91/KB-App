// IPC handlers — the main-process side of the KbApi contract (preload mirrors it).
import { ipcMain, dialog, BrowserWindow, type OpenDialogOptions } from 'electron';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { inspectPath, createKb } from '../kb/vault';
import { readAppConfig, writeAppConfig } from './appConfig';
import { startPipeline, activePipeline, listActiveReviews, answerActiveReview } from './pipeline';
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
    startPipeline(path.resolve(cfg.activeVaultPath));
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
      startPipeline(vaultPath); // the KB is live — start draining captures immediately
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
}
