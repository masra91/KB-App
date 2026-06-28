// IPC handlers — the main-process side of the KbApi contract (preload mirrors it).
import { ipcMain, dialog, shell, BrowserWindow, clipboard, type OpenDialogOptions } from 'electron';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { inspectPath, createKb } from '../kb/vault';
import { isPermissionDeniedError } from '../kb/permissions';
import { readAppConfig, writeAppConfig } from './appConfig';
import {
  startPipeline,
  activePipeline,
  activeStagingRoot,
  pipelineStatusForActive,
  pipelineControlForActive,
  reviewProjectionForActive,
  answerActiveReview,
  saveRecallOutput,
  fullReplay,
  composeBacklog,
  composeBacklogStatus,
  listJobsForActive,
  setActiveJobConfig,
  runActiveJobNow,
  getActiveInstanceSettings,
  setActiveInstanceSettings,
  listAgentsForActive,
  getModelCatalogForActive,
  setActiveModel,
  setActiveAgentModel,
  listResearchersForActive,
  setActiveResearcherConfig,
  removeActiveResearcher,
  runActiveResearcherNow,
  listResearcherRunsForActive,
  listWatchFoldersForActive,
  setActiveWatchFolder,
  removeActiveWatchFolder,
  listIntakeConnectorsForActive,
  setActiveIntakeConnectorConfig,
  removeActiveIntakeConnector,
  runActiveIntakeConnectorNow,
  setActiveSourceSensitivity,
  getActiveSourceSensitivities,
  quiesceActive,
  resumeActive,
  quiesceStatusForActive,
  isActiveQuiescing,
} from './pipeline';
import { getQuickCaptureAgent } from './quickCaptureService';
import { captureScreenshot, consumeScreenshotHandle, clipboardImageHandle } from './quickCaptureScreenshot';
import { noteRendererError } from './telemetry';
import { recall } from '../kb/recall';
import { resolveCopilotModel } from '../kb/copilotModel';
import { copilotScaleRuntime } from '../kb/copilotConcurrency';
import { makeReadOnlyTools } from '../kb/recallTools';
import { buildNeighborhood, listExploreEntities, type ExploreEntityRef, type ExploreNeighborhood } from '../kb/explorePanel';
import { resolveContainedRel } from '../kb/pathContainment';
import { obsidianOpenUri } from '../kb/citationLink';
import { locateSourceRef } from '../kb/sourceOpen';
import { buildActivityIndex, readEvents, filterEvents } from '../kb/activityIndex';
import { buildFeed } from '../kb/activityDigest';
import { traceLineage } from '../kb/lineage';
import { resolveExecutable } from './resolvePath';
import type { CapturePayload } from '../kb/ingest';
import type {
  AppState,
  VaultConfig,
  CreateKbOptions,
  ProbeVaultAccessResult,
  OpenSettingsResult,
  CaptureRequest,
  CaptureResult,
  QuickCaptureContext,
  ScreenshotMode,
  ScreenshotResult,
  PipelineStatus,
  PipelineStatusView,
  RendererErrorReport,
  ReviewSummary,
  Projection,
  AnswerReviewRequest,
  AnswerReviewResult,
  PipelineControlRequest,
  PipelineControlResult,
  QuiesceStatus,
  FullReplayResult,
  ComposeBacklogResult,
  AskRequest,
  AskResult,
  SaveRecallOutputResult,
  OpenCitationResult,
  OpenSourceRefResult,
  JobView,
  JobConfigPatch,
  RunJobResult,
  ActivityFilter,
  ActivityFeedResult,
  AuditEvent,
  Lineage,
  InstanceSettings,
  ScaleRuntime,
  AgentView,
  ModelCatalogView,
  SetModelResult,
  ResearcherView,
  ResearcherConfigPatch,
  ResearcherLastRun,
  RunResearcherResult,
  WatchFolderView,
  WatchFolderPatch,
  IntakeConnectorView,
  IntakeConnectorConfigPatch,
  RunIntakeConnectorResult,
  WorkIqStatus,
  InstallWorkIqResult,
} from '../kb/types';
import { workIqStatus, installWorkIq } from './researchWiring';

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

  // SPEC-0034 MACOS-7: probe vault write-access. A benign write+delete of a hidden marker under the
  // vault's `.kb/` — the app's own first protected-folder access — so the macOS TCC grant dialog fires
  // THEN (coupled to the pre-prompt's Continue), not later, decoupled, mid-pipeline (MACOS-5). The
  // marker is removed immediately so nothing pollutes the user's vault. `denied` distinguishes a
  // permission failure (→ the Blocked recovery) from a generic one.
  ipcMain.handle('kb:probeVaultAccess', async (_e, vaultPath: string): Promise<ProbeVaultAccessResult> => {
    // Defense-in-depth (KB-QD #201): this handler writes to a renderer-supplied path, so confine it to
    // the ACTIVE vault — never probe (write into) an arbitrary off-config path. Mirrors the path-
    // containment posture at every fs-touching IPC boundary.
    const resolved = path.resolve(vaultPath);
    const cfg = await readAppConfig();
    if (!cfg.activeVaultPath || resolved !== cfg.activeVaultPath) {
      return { ok: false, denied: false, message: 'That folder isn’t the active knowledge base.' };
    }
    const marker = path.join(resolved, '.kb', '.permission-probe');
    try {
      await fs.writeFile(marker, '', 'utf8');
      await fs.rm(marker, { force: true });
      return { ok: true, denied: false, message: 'Vault folder is accessible.' };
    } catch (err) {
      await fs.rm(marker, { force: true }).catch(() => {}); // best-effort cleanup if the write half-landed
      return { ok: false, denied: isPermissionDeniedError(err), message: err instanceof Error ? err.message : String(err) };
    }
  });

  // SPEC-0034 MACOS-7: open macOS System Settings → Privacy & Security → Files and Folders for the
  // denied-recovery flow. The precise sub-anchor is historically flaky across macOS versions, so a
  // reject falls back to the general Privacy & Security pane — never a no-op click (the dead-end the
  // design forbids).
  ipcMain.handle('kb:openSystemSettingsPrivacy', async (): Promise<OpenSettingsResult> => {
    const FILES = 'x-apple.systempreferences:com.apple.preference.security?Privacy_FilesAndFolders';
    const PRIVACY = 'x-apple.systempreferences:com.apple.preference.security?Privacy';
    try {
      await shell.openExternal(FILES);
      return { ok: true };
    } catch {
      try {
        await shell.openExternal(PRIVACY);
        return { ok: true, usedFallback: true };
      } catch (err) {
        return { ok: false, message: err instanceof Error ? err.message : String(err) };
      }
    }
  });

  // SPEC-0013 CAPTURE-1/2: fire-and-forget capture of text + dropped files. The renderer
  // sends file bytes; we hand them to the active orchestrator, which preserves+commits.
  ipcMain.handle('kb:capture', async (_e, req: CaptureRequest): Promise<CaptureResult> => {
    const orch = activePipeline();
    if (!orch) return NO_PIPELINE;
    // SPEC-0045 QUIESCE-1: new ingestion is paused while preparing for shutdown — surface a clear reason,
    // never a silent drop. The user can Resume to capture again.
    if (isActiveQuiescing()) {
      return { ...NO_PIPELINE, message: 'Preparing to shut down — new capture is paused. Resume to capture again.' };
    }

    const payloads: CapturePayload[] = [];
    for (const input of req.inputs) {
      if (input.kind === 'text') {
        // RICHIN-2: carry the original clipboard HTML (if any) so ingest writes the verbatim sidecar.
        if (input.text.trim().length > 0) payloads.push({ kind: 'text', text: input.text, ...(input.html ? { html: input.html } : {}) });
      } else if (input.kind === 'file') {
        payloads.push({ kind: 'file', name: input.name, data: new Uint8Array(input.data) });
      }
      // (a `screenshot` input is QCAP-only — resolved in kb:quickCapture, never reaches the in-app panel)
    }
    if (payloads.length === 0) {
      return { ...NO_PIPELINE, message: 'Nothing to capture.' };
    }

    try {
      const out = await orch.capture('in-app-panel', payloads);
      return { ok: true, ids: out.ids, captureBatch: out.captureBatch, committed: out.committed, message: `Captured ${out.ids.length} item(s).` };
    } catch (err) {
      // #56 / MACOS-7: a folder-permission denial (TCC not granted) must route to the Blocked recovery,
      // never surface the raw `Operation not permitted` to the user (no dev jargon, no silent stall).
      if (isPermissionDeniedError(err)) {
        return { ...NO_PIPELINE, blocked: true, message: 'Vellum can’t write to your vault folder — access is turned off.' };
      }
      return { ...NO_PIPELINE, message: err instanceof Error ? err.message : String(err) };
    }
  });

  // SPEC-0038 QCAP-1/2/5: fire-and-forget quick capture (text + clipboard + screenshot) onto the SAME
  // SPEC-0013 capture path, recording provenance surface='quick-capture'. QCAP adds NO preservation
  // logic — it hands payloads to the active orchestrator, which returns on preserve+commit and never
  // blocks on Enrich (CAPTURE-2 fast-out). QCAP-13: a `screenshot` input is a temp-PNG handle main
  // issued — read it (validating it's ours) into a file payload; the bytes never came through the DOM.
  ipcMain.handle('kb:quickCapture', async (_e, req: CaptureRequest): Promise<CaptureResult> => {
    const orch = activePipeline();
    if (!orch) return NO_PIPELINE;

    const payloads: CapturePayload[] = [];
    for (const input of req.inputs) {
      if (input.kind === 'text' && input.text.trim().length > 0) {
        payloads.push({ kind: 'text', text: input.text });
      } else if (input.kind === 'screenshot') {
        const bytes = await consumeScreenshotHandle(input.handle); // null if not a handle WE issued
        if (bytes) payloads.push({ kind: 'file', name: input.name, data: bytes });
      }
    }
    if (payloads.length === 0) return { ...NO_PIPELINE, message: 'Nothing to capture.' };

    try {
      const out = await orch.capture('quick-capture', payloads); // QCAP-5: provenance surface=quick-capture
      return { ok: true, ids: out.ids, captureBatch: out.captureBatch, committed: out.committed, message: `Captured ${out.ids.length} item(s).` };
    } catch (err) {
      if (isPermissionDeniedError(err)) {
        return { ...NO_PIPELINE, blocked: true, message: 'Vellum can’t write to your vault folder — access is turned off.' };
      }
      return { ...NO_PIPELINE, message: err instanceof Error ? err.message : String(err) };
    }
  });

  // QCAP-2: the sheet asks the agent to dismiss + restore focus to the prior app after submit/cancel.
  ipcMain.handle('kb:quickCaptureClose', async (): Promise<void> => {
    getQuickCaptureAgent()?.close();
  });

  // QCAP-7: the sheet pre-fills so "save what I'm looking at" is one gesture. Slice 1 = the current
  // clipboard; Slice 2 folds in the focused-app `selection` the agent read at summon time (before the
  // sheet stole focus) + the Accessibility grant state. No agent / no summon → clipboard-only (the
  // selection is null + unsupported), so this path also serves the non-macOS + headless-test cases.
  ipcMain.handle('kb:quickCaptureContext', async (): Promise<QuickCaptureContext> => {
    const sel = getQuickCaptureAgent()?.takeSelectionContext();
    return {
      clipboard: clipboard.readText(),
      selection: sel?.text ?? null,
      accessibility: sel?.status ?? 'unsupported',
      clipboardImage: await clipboardImageHandle(), // QCAP-13: "paste an image" prefill / denied-degrade
      screenshotSupported: process.platform === 'darwin', // QCAP-13: the cluster shows only where capture works
    };
  });

  // SPEC-0038 QCAP-13: capture a screenshot (full/region/window) to a temp PNG handle. The bytes stay
  // in main; the sheet gets only the handle + submits it back. denied → the sheet's brass steer.
  ipcMain.handle('kb:quickCaptureScreenshot', async (_e, mode: ScreenshotMode): Promise<ScreenshotResult> => {
    return captureScreenshot(mode);
  });

  // SPEC-0038 QCAP-13: open System Settings → Privacy & Security → Screen Recording for the denied
  // recovery steer (the SPEC-0034 / QCAP-9 pattern). Exact anchor → general Privacy fallback, never a no-op.
  ipcMain.handle('kb:openScreenRecordingSettings', async (): Promise<OpenSettingsResult> => {
    const SCREEN = 'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture';
    const PRIVACY = 'x-apple.systempreferences:com.apple.preference.security?Privacy';
    try {
      await shell.openExternal(SCREEN);
      return { ok: true };
    } catch {
      try {
        await shell.openExternal(PRIVACY);
        return { ok: true, usedFallback: true };
      } catch (err) {
        return { ok: false, message: err instanceof Error ? err.message : String(err) };
      }
    }
  });

  // SPEC-0038 QCAP-9 (Slice 2): open macOS System Settings → Privacy & Security → Accessibility for the
  // denied-selection-capture recovery. Mirrors kb:openSystemSettingsPrivacy (SPEC-0034 pattern): the
  // precise Accessibility sub-anchor can be flaky across macOS versions, so a reject falls back to the
  // general Privacy & Security pane — never a no-op click (the dead-end the design forbids, QCAP-9).
  ipcMain.handle('kb:openAccessibilitySettings', async (): Promise<OpenSettingsResult> => {
    const ACCESSIBILITY = 'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility';
    const PRIVACY = 'x-apple.systempreferences:com.apple.preference.security?Privacy';
    try {
      await shell.openExternal(ACCESSIBILITY);
      return { ok: true };
    } catch {
      try {
        await shell.openExternal(PRIVACY);
        return { ok: true, usedFallback: true };
      } catch (err) {
        return { ok: false, message: err instanceof Error ? err.message : String(err) };
      }
    }
  });

  ipcMain.handle('kb:pipelineStatus', async (): Promise<PipelineStatus> => {
    const orch = activePipeline();
    return orch ? orch.status() : { queueDepth: 0, processing: null, lastArchived: null, updatedAt: null };
  });

  // SPEC-0030 OBS-5/6/7/11/15: the live Status view-model (read-only). Null when no KB is open.
  ipcMain.handle('kb:pipelineStatusView', async (): Promise<PipelineStatusView | null> => {
    return pipelineStatusForActive();
  });

  // SPEC-0030 OBS-18 (renderer): the renderer forwards its uncaught errors / unhandled rejections
  // here (the isolated renderer can't write the app-log); the telemetry glue logs them loudly.
  ipcMain.handle('kb:reportRendererError', async (_e, report: RendererErrorReport): Promise<void> => {
    noteRendererError(report);
  });

  // SPEC-0018 REVIEW-10/11 + SHELL-12: the "needs you" queue, served from the maintained projection —
  // INSTANT, never blocks on the backend (zero git/fs on the render path; a busy stage / held lock
  // can't stall the Reviews surface or the rail badge). The compute + summary mapping live in the
  // pipeline's `reviewStore` (background cadence); here we just hand back the last-known-good.
  ipcMain.handle('kb:listReviews', async (): Promise<ReviewSummary[]> => {
    return reviewProjectionForActive()?.data ?? [];
  });

  // SHELL-12: the review queue WITH its freshness envelope (`builtAt`/`stale`) for the "as of /
  // updating…" affordance — so a surface honors staleness visibly, never renders stale-as-live. The
  // plain `kb:listReviews` above stays the instant queue read; this is additive (also instant).
  ipcMain.handle('kb:reviewProjection', async (): Promise<Projection<ReviewSummary[]> | null> => {
    return reviewProjectionForActive();
  });

  ipcMain.handle('kb:answerReview', async (_e, req: AnswerReviewRequest): Promise<AnswerReviewResult> => {
    const { ok, message } = await answerActiveReview(req.id, { verdict: req.verdict, note: req.note });
    return { ok, message };
  });

  // SPEC-0030 OBS-17: retry / dismiss a set-aside (poison) item from the Status view (claims-only v1).
  // The one mutating action the Status surface offers; it delegates to the stage-owned recovery
  // primitives under the canonical-writer lock (no mutation logic here).
  ipcMain.handle('kb:pipelineControl', async (_e, req: PipelineControlRequest): Promise<PipelineControlResult> => {
    return pipelineControlForActive(req);
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

  // SPEC-0046 COMPOSE-9: backfill the vault — kick a bounded, coalesced recompose of the uncomposed
  // backlog (re-attempting any set-aside); the read-only status just reports coverage.
  ipcMain.handle('kb:composeBacklog', async (): Promise<ComposeBacklogResult> => {
    try {
      return await composeBacklog();
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : String(err) };
    }
  });
  ipcMain.handle('kb:composeBacklogStatus', async (): Promise<ComposeBacklogResult> => {
    try {
      return await composeBacklogStatus();
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
    // ASK-17: hand recall the Principal-configured work budget (from Instance Settings on `staging`)
    // so a real grounded multi-hop has room to finish past the SDK's tight 60s default. ASK-19: also
    // forward the optional retrieval tool-call override (`undefined` ⇒ recall's graph-size-scaled
    // default applies — see `recallBudget`; a set value wins as `opts.maxToolCalls`).
    const { recallBudgetMs, recallMaxToolCalls } = await getActiveInstanceSettings();
    // ORCH-16: pin the model recall's SDK session runs on, same as the enrich deciders — prod
    // otherwise passed no model and the SDK inherited `~/.copilot/settings.json` (model-pin gap).
    return recall(path.resolve(cfg.activeVaultPath), { question: req.question, history: req.history }, { cliPath, sessionBudgetMs: recallBudgetMs, maxToolCalls: recallMaxToolCalls ?? undefined, model: resolveCopilotModel(undefined, 'recall') });
  });

  // SPEC-0026 ASK-6: save a grounded recall answer as an inert KB Output (outputs/recall/<id>.md,
  // promoted to main, conforming `output` audit). The renderer passes the AskResult it rendered.
  ipcMain.handle('kb:saveRecallOutput', async (_e, result: AskResult): Promise<SaveRecallOutputResult> => {
    try {
      return await saveRecallOutput(result);
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : String(err) };
    }
  });

  // SPEC-0026 ASK-14: open a citation's canonical target in Obsidian. The renderer hands us the
  // citation's vault-relative `ref`; we resolve it to an ABSOLUTE path under the active vault — with
  // containment (#30: `resolveContainedRel` rejects any `..`/symlink escape; null → no open) so a
  // crafted ref can't deep-link outside the vault — then hand the percent-encoded `obsidian://open`
  // URI to the OS. We never build the URI in the renderer, so the `obsidian:` scheme never touches
  // the DOM (DOMPurify's default allowlist stays intact, ASK-15/#93).
  ipcMain.handle('kb:openCitation', async (_e, ref: unknown): Promise<OpenCitationResult> => {
    if (typeof ref !== 'string' || ref.trim().length === 0) return { ok: false, reason: 'invalid-ref' };
    const cfg = await readAppConfig();
    if (!cfg.activeVaultPath) return { ok: false, reason: 'no-vault' };
    const abs = await resolveContainedRel(path.resolve(cfg.activeVaultPath), ref);
    if (abs === null) return { ok: false, reason: 'invalid-ref' }; // escaped containment or missing
    try {
      await shell.openExternal(obsidianOpenUri(abs));
      return { ok: true };
    } catch {
      return { ok: false, reason: 'open-failed' };
    }
  });

  // SPEC-0018 REVIEW-17 / PRIN-24: working-zone-aware open of a review candidate's source. A review
  // can be raised MID-PIPELINE, so its source may be staging-only — not yet promoted to `main` (the
  // user's Obsidian vault, where `obsidian://open` resolves). Firing the deep link anyway is "file not
  // found". So resolve WHERE the `source.md` lives right now (`locateSourceRef`): open in Obsidian only
  // when it's on `main`; otherwise hand the view a `staging`/`missing` status so it shows the in-app /
  // "still processing" fallback — never a dead link. Like ASK-14 we never build the URI in the renderer.
  ipcMain.handle('kb:openSourceRef', async (_e, ref: unknown): Promise<OpenSourceRefResult> => {
    if (typeof ref !== 'string' || ref.trim().length === 0) return { status: 'invalid-ref' };
    const cfg = await readAppConfig();
    if (!cfg.activeVaultPath) return { status: 'no-vault' };
    const located = await locateSourceRef(path.resolve(cfg.activeVaultPath), activeStagingRoot(), ref);
    switch (located.location) {
      case 'main':
        try {
          await shell.openExternal(obsidianOpenUri(located.mainAbs!));
          return { status: 'opened' };
        } catch {
          return { status: 'open-failed' };
        }
      case 'staging':
        return { status: 'staging' };
      case 'invalid':
        return { status: 'invalid-ref' };
      default:
        return { status: 'missing' };
    }
  });

  // SPEC-0039 EXPLORE: the read-only entity-neighborhood view. Reads the EVERGREEN graph at the active
  // vault root (like recall/ask, NOT the staging worktree — EXPLORE-3: canonical state only), via the
  // read-only recall tools — so it's read-only by construction (EXPLORE-1: no write path here).
  ipcMain.handle('kb:exploreEntities', async (): Promise<ExploreEntityRef[]> => {
    const cfg = await readAppConfig();
    if (!cfg.activeVaultPath) return [];
    return listExploreEntities(makeReadOnlyTools(path.resolve(cfg.activeVaultPath)));
  });

  ipcMain.handle('kb:exploreNeighborhood', async (_e, focus?: unknown): Promise<ExploreNeighborhood> => {
    const cfg = await readAppConfig();
    if (!cfg.activeVaultPath) return { found: false, claims: [], neighbors: [], shown: 0, total: 0 };
    const f = typeof focus === 'string' && focus.length > 0 ? focus : undefined;
    return buildNeighborhood(makeReadOnlyTools(path.resolve(cfg.activeVaultPath)), f);
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
  // SCALE-7/8: live scale runtime for the Scale card's throttled indicator (effective vs reference ceiling).
  ipcMain.handle('kb:getScaleRuntime', async (): Promise<ScaleRuntime> => copilotScaleRuntime());

  ipcMain.handle('kb:setInstanceSettings', async (_e, s: InstanceSettings): Promise<InstanceSettings> => setActiveInstanceSettings(s));

  ipcMain.handle('kb:listAgents', async (): Promise<AgentView[]> => listAgentsForActive());

  // SPEC-0048: the model picker — the live accepted catalog + resolved model, and a validated set.
  ipcMain.handle('kb:getModelCatalog', async (): Promise<ModelCatalogView> => getModelCatalogForActive());
  ipcMain.handle('kb:setModel', async (_e, id: string | null): Promise<SetModelResult> => setActiveModel(id));
  ipcMain.handle('kb:setAgentModel', async (_e, agentKey: string, id: string | null): Promise<SetModelResult> => setActiveAgentModel(agentKey, id));

  // SPEC-0028 RESEARCH-15: the Control Panel's Researchers view — list/configure researchers,
  // on-demand "Run now" (test pass), and recent-run history. The renderer gates risky changes
  // (enable / → autonomous / widen egress) behind a confirm; the main process owns the registry +
  // emits the conforming `panel` audit. Run-now uses the deterministic stub in 1a (no egress).
  ipcMain.handle('kb:listResearchers', async (): Promise<ResearcherView[]> => listResearchersForActive());

  ipcMain.handle('kb:setResearcherConfig', async (_e, patch: ResearcherConfigPatch): Promise<ResearcherView[]> => setActiveResearcherConfig(patch));

  // PANEL-11 lifecycle delete: purge a (user-added) researcher's config; sources + audit retained.
  ipcMain.handle('kb:removeResearcher', async (_e, id: string): Promise<ResearcherView[]> => removeActiveResearcher(id));

  ipcMain.handle('kb:runResearcherNow', async (_e, id: string): Promise<RunResearcherResult> => {
    try {
      return await runActiveResearcherNow(id);
    } catch {
      return { ran: false, reason: 'not-found' };
    }
  });

  ipcMain.handle('kb:listResearcherRuns', async (_e, id: string): Promise<ResearcherLastRun[]> => listResearcherRunsForActive(id));

  // WORKIQ-FIX (SPEC-0028 Slice 3): the WorkIQ/M365 researcher CLI setup card. `kb:workIqStatus` reports
  // whether the `workiq` CLI is on PATH (the researcher fails loud until it is); `kb:installWorkIq` runs
  // the "simple workiq via CLI" install and re-detects. Pure status read needs no active vault.
  ipcMain.handle('kb:workIqStatus', async (): Promise<WorkIqStatus> => workIqStatus());
  ipcMain.handle('kb:installWorkIq', async (): Promise<InstallWorkIqResult> => installWorkIq());

  // SPEC-0037 WATCH-9: the unified Sources view's watched-folder rows. One list read folds config +
  // live `watching` + `lastEvent`; set/remove validate + loop-guard at this boundary (in the pipeline fn).
  ipcMain.handle('kb:listWatchFolders', async (): Promise<WatchFolderView[]> => listWatchFoldersForActive());
  ipcMain.handle('kb:setWatchFolder', async (_e, patch: WatchFolderPatch): Promise<WatchFolderView[]> => setActiveWatchFolder(patch));
  ipcMain.handle('kb:removeWatchFolder', async (_e, id: string): Promise<WatchFolderView[]> => removeActiveWatchFolder(id));

  // SPEC-0027 PANEL-4 · Sources (INTAKE-14): manage intake feed connectors + on-demand run.
  ipcMain.handle('kb:listIntakeConnectors', async (): Promise<IntakeConnectorView[]> => listIntakeConnectorsForActive());

  ipcMain.handle('kb:setIntakeConnectorConfig', async (_e, patch: IntakeConnectorConfigPatch): Promise<IntakeConnectorView[]> => setActiveIntakeConnectorConfig(patch));

  // PANEL-11 lifecycle delete: purge a (user-added) intake feed's config; sources + audit retained.
  ipcMain.handle('kb:removeIntakeConnector', async (_e, id: string): Promise<IntakeConnectorView[]> => removeActiveIntakeConnector(id));

  ipcMain.handle('kb:runIntakeConnectorNow', async (_e, id: string): Promise<RunIntakeConnectorResult> => {
    try {
      return await runActiveIntakeConnectorNow(id);
    } catch {
      return { ran: false, reason: 'not-found' };
    }
  });

  // SPEC-0043 SENSE-7: Principal override of a source's sensitivity (audited + Replay-sticky).
  ipcMain.handle('kb:setSourceSensitivity', async (_e, sourceId: string, label: string): Promise<{ ok: boolean; reason?: string; sensitivity?: string }> => {
    try {
      return await setActiveSourceSensitivity(sourceId, label);
    } catch {
      return { ok: false, reason: 'error' };
    }
  });

  // SPEC-0043 SENSE-10: read sources' current sensitivity (+ provenance) for the Control-Panel display.
  ipcMain.handle('kb:getSourceSensitivities', async (_e, sourceIds: string[]) => {
    try {
      return await getActiveSourceSensitivities(sourceIds);
    } catch {
      return {};
    }
  });

  // SPEC-0045 QUIESCE — graceful "Prepare for shutdown": pause new work + drain / resume / poll status.
  ipcMain.handle('kb:quiesce', async (): Promise<QuiesceStatus> => quiesceActive());
  ipcMain.handle('kb:resume', async (): Promise<QuiesceStatus> => resumeActive());
  ipcMain.handle('kb:quiesceStatus', async (): Promise<QuiesceStatus | null> => quiesceStatusForActive());
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
