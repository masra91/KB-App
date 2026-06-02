// Shell-agnostic KB types: the data shapes + the IPC contract between main & renderer.
// No electron/obsidian imports here — this module must stay reusable (STACK-6).
//
// The Audit & Activity DTOs (SPEC-0029) live in their domain modules; we re-export them via
// TYPE-ONLY imports so the renderer/preload get one import surface (`../../kb/types`) without
// pulling those modules' runtime deps (node:fs / simple-git) into the renderer bundle — `import
// type` is erased at build time.
import type { SchedulePreset, AutonomyPosture } from './jobs';
import type { EgressTier, ResearcherTemplate } from './researchers';
import type { AuditEvent, AuditActor, AuditSubjects } from './audit';
import type { ActivityFilter } from './activityIndex';
import type { ActivityFeedEntry } from './activityDigest';
import type { Lineage } from './lineage';
import type { PipelineStatusView, StageStatus, RecentError, WorktreeInfo } from './pipelineStatusView';
import type { DevLogLevel } from './instanceConfig';

export type { AuditEvent, AuditActor, AuditSubjects, ActivityFilter, ActivityFeedEntry, Lineage };
export type { PipelineStatusView, StageStatus, RecentError, WorktreeInfo };

export const KB_CONFIG_VERSION = 1;

/** Vault-level config, persisted at `<vault>/.kb/config.json`. */
export interface VaultConfig {
  schemaVersion: number;
  id: string; // stable unique id for this KB / Instance
  name: string;
  createdAt: string; // ISO timestamp
}

export interface CopilotStatus {
  available: boolean;
  detail: string; // human-readable: which binary, or why not found
}

/** Result of inspecting a candidate vault folder during setup. */
export interface PathInspection {
  path: string;
  exists: boolean;
  isDirectory: boolean;
  gitInstalled: boolean; // system git on PATH (STACK-4)
  isGitRepo: boolean; // the folder is already a git repo
  alreadyKb: boolean; // already has a .kb/config.json
  copilot: CopilotStatus; // SETUP-4 (detect-only)
  /** Non-null when the path is inside a macOS TCC-protected location (Documents/Desktop/Downloads/
   *  iCloud Drive): the dir's friendly name. A vault here silently breaks the pipeline — git/copilot
   *  subprocess writes fail with `Operation not permitted` until the app is signed+entitled (STACK-10,
   *  BUG #56). Setup warns and steers the user to an unprotected location. Null elsewhere. */
  tccProtectedDir: string | null;
}

export interface CreateKbOptions {
  path: string;
  name?: string;
  initGitIfNeeded: boolean;
}

export interface CreateKbResult {
  ok: boolean;
  vaultConfig?: VaultConfig;
  committed?: boolean;
  message: string;
}

/** What the renderer asks for on launch to decide Setup vs. loaded (SETUP-6). */
export interface AppState {
  activeVaultPath: string | null;
  vaultConfig: VaultConfig | null;
}

// --- Capture / ingestion (SPEC-0013 CAPTURE) ---

export interface CaptureTextInput {
  kind: 'text';
  text: string;
}
export interface CaptureFileInput {
  kind: 'file';
  name: string; // original filename
  data: Uint8Array; // raw bytes (read in the renderer from the dropped File)
}
export type CaptureInput = CaptureTextInput | CaptureFileInput;

export interface CaptureRequest {
  inputs: CaptureInput[];
}
export interface CaptureResult {
  ok: boolean;
  ids: string[];
  captureBatch: string | null;
  committed: boolean;
  message: string;
}

/** Minimal pipeline status for the capture panel (SPEC-0014 ORCH-10). */
export interface PipelineStatus {
  queueDepth: number;
  processing: string | null;
  lastArchived: string | null;
  updatedAt: string | null;
}

// --- Review / "needs you" queue (SPEC-0018 REVIEW) ---

/** One open review as the Reviews view needs it (REVIEW-10). */
export interface ReviewSummary {
  id: string;
  question: string; // the yes/no question
  detail: string; // expandable context (REVIEW-3)
  stage: string; // which stage raised it
  refs: string[]; // subject entity names / mentions
  createdAt: string;
}

export interface AnswerReviewRequest {
  id: string;
  verdict: 'confirm' | 'reject';
  note?: string; // optional; captured as a primary source (REVIEW-7)
}
export interface AnswerReviewResult {
  ok: boolean;
  message: string;
}

// --- Replay & Reprocessing (SPEC-0022 REPLAY) ---

/** Result of a Principal-initiated full replay (clean & rebuild). */
export interface FullReplayResult {
  ok: boolean;
  replayId?: string; // the epoch minted for this replay (REPLAY-6)
  sourcesReset?: number; // how many Sources were epoch-reset for reprocessing
  purgedTrees?: string[]; // which derived trees were cleared (REPLAY-4)
  message: string;
}

// --- Ask & Recall (SPEC-0026 ASK) ---

// The recall engine owns these shapes; re-exported here so the renderer/IPC contract has one
// import surface. (types.ts stays electron/obsidian-free, STACK-6 — recall.ts is pure kb domain.)
export type { AskResult, Citation, RecallTurn } from './recall';
import type { AskResult, RecallTurn } from './recall';

/** A recall request from the Ask view: an NL question + the in-session history (ASK-8). */
export interface AskRequest {
  question: string;
  history?: RecallTurn[];
}

/** Result of saving a recall answer as a KB Output (ASK-6). `rel` is the Output's repo path on success. */
export interface SaveRecallOutputResult {
  ok: boolean;
  rel?: string;
  message: string;
}

/** Result of opening a citation in Obsidian (ASK-14). `ok:false` carries a `reason` for inline surfacing
 *  (no active vault, the ref escaped containment, or the OS had no handler for the `obsidian://` scheme). */
export interface OpenCitationResult {
  ok: boolean;
  reason?: 'no-vault' | 'invalid-ref' | 'open-failed';
}

// --- Control Panel · Jobs (SPEC-0027 PANEL-2; over the SPEC-0023 registry) ---

/** Last-run summary for a job, derived from its run-state journal (JOBS-7/8) for display. */
export interface JobLastRun {
  ts: string; // ISO timestamp of the last run
  inspected: string; // what the pass looked at
  applied: number; // findings auto-applied
  deferred: number; // findings routed to Review
  note?: string; // e.g. 'collision-exhausted' (a set-aside run)
}

/** One manageable job as the Jobs view needs it (PANEL-2): catalog metadata + current config + last run. */
export interface JobView {
  id: string;
  type: string;
  label: string; // catalog label (or the type, for a registered job with no catalog entry)
  description: string;
  production: boolean; // false → a reference/non-production job (flagged in the UI)
  registered: boolean; // true once persisted in the registry (false = catalog-only, defaults shown)
  enabled: boolean;
  schedule: SchedulePreset;
  posture: AutonomyPosture;
  lastRun: JobLastRun | null; // null = never run
}

/** A config change from the Jobs view (PANEL-2/6). `type` lets the main process seed a catalog-only
 *  job into the registry on first edit. Omitted fields are left unchanged. */
export interface JobConfigPatch {
  id: string;
  type: string;
  enabled?: boolean;
  schedule?: SchedulePreset;
  posture?: AutonomyPosture;
}

/** Outcome of a manual "Run now" (PANEL-2; JOBS-11). `ran:false` carries why it didn't run. */
export type RunJobResult =
  | { ran: true; outcome: 'advanced' | 'noop' | 'setaside'; applied: number; deferred: number }
  | { ran: false; reason: 'skipped' | 'not-found' | 'unknown-type' | 'no-kb' };

// --- Control Panel · Researchers (SPEC-0028 RESEARCH-15; over the researcher registry) ---

/** Last-run summary for a researcher, derived from its newest `researcher` audit event, for display. */
export interface ResearcherLastRun {
  ts: string; // ISO timestamp of the last pass
  eventType: string; // 'researched' | 'no-finding'
  what: string; // the request term it answered
  sourceId?: string; // the secondary source produced (when it found something)
  citations: number; // external citations on the finding
}

/** One manageable researcher as the Researchers view needs it (RESEARCH-15): config + last run. */
export interface ResearcherView {
  id: string;
  template: ResearcherTemplate;
  label: string;
  /** The researcher's standing instructions / prompt (RESEARCH-17) — editable in the Manage view. */
  prompt: string;
  /** Code-template config: the local repository path the researcher reads (`config.repoPath`); empty
   *  when unset (the Code researcher is inert until set). Shown only for `code` researchers. */
  repoPath: string;
  /** M365-template config: the tenant id the researcher reads (`config.tenantId`); empty when unset
   *  (the M365 researcher is inert until set). Shown only for `m365` researchers (SPEC-0028 Slice 3). */
  tenantId: string;
  /** Code-template config: the GitHub PR repo (`config.prRepo`, `owner/name`) the researcher scans;
   *  empty when unset (PR reads are inert until set). Shown only for `code` researchers (Slice 2b). */
  prRepo: string;
  egressTier: EgressTier;
  scope: string;
  enabled: boolean;
  schedule: SchedulePreset;
  posture: AutonomyPosture;
  topics: string[];
  lastRun: ResearcherLastRun | null; // null = never run
}

/** A config change from the Researchers view (RESEARCH-15). Omitted fields are left unchanged. New
 *  researcher = include template + prompt + egressTier. `id` must be a bare slug (registry-guarded). */
export interface ResearcherConfigPatch {
  id: string;
  template?: ResearcherTemplate;
  label?: string;
  prompt?: string;
  /** Code-template config: the local repo path to read (merged into `config.repoPath`). */
  repoPath?: string;
  /** M365-template config: the tenant id to read (merged into `config.tenantId`). */
  tenantId?: string;
  /** Code-template config: the GitHub PR repo `owner/name` to scan (merged into `config.prRepo`). */
  prRepo?: string;
  egressTier?: EgressTier;
  scope?: string;
  enabled?: boolean;
  schedule?: SchedulePreset;
  posture?: AutonomyPosture;
  topics?: string[];
}

/** Outcome of a manual researcher "Run now" (RESEARCH-15). `ran:false` carries why it didn't run. */
export type RunResearcherResult =
  | { ran: true; sourceIds: string[]; note: string }
  | { ran: false; reason: 'not-found' | 'no-kb' };

// --- Control Panel · Settings + Agents (SPEC-0027 PANEL-3/5) ---

/** Editable per-Instance settings surfaced in Settings (PANEL-5 / AUTO-12). */
export interface InstanceSettings {
  autonomyDefault: AutonomyPosture;
  /** Dev-log verbosity (SPEC-0030 OBS-10): `info` (default) or `debug` to troubleshoot. */
  devLogLevel: DevLogLevel;
}

/** One librarian/stage agent as the Agents view needs it (PANEL-3) — observe + key config. */
export interface AgentView {
  key: string; // stable agent key (e.g. 'decompose')
  label: string; // Principal-facing name
  role: string; // one-line description of what it does
  model: string; // the model it runs (or 'deterministic' / '—' when not agent-backed)
  instructions: string; // pointer to its instruction source (file/built-in)
  status: 'running' | 'idle'; // live: running when the pipeline is active, else idle (PANEL-9)
}

/** The API surface exposed to the renderer via contextBridge (preload). */
export interface KbApi {
  getState(): Promise<AppState>;
  pickFolder(): Promise<string | null>;
  inspect(path: string): Promise<PathInspection>;
  create(opts: CreateKbOptions): Promise<CreateKbResult>;
  capture(req: CaptureRequest): Promise<CaptureResult>;
  pipelineStatus(): Promise<PipelineStatus>;
  // SPEC-0030 OBS-5/6/7/11/15: the live Pipeline Status view-model (null when no KB is open).
  pipelineStatusView(): Promise<PipelineStatusView | null>;
  listReviews(): Promise<ReviewSummary[]>;
  answerReview(req: AnswerReviewRequest): Promise<AnswerReviewResult>;
  fullReplay(): Promise<FullReplayResult>;
  ask(req: AskRequest): Promise<AskResult>;
  // SPEC-0026 ASK-6: save a grounded recall answer as a KB Output.
  saveRecallOutput(result: AskResult): Promise<SaveRecallOutputResult>;
  // SPEC-0026 ASK-14: open a citation's canonical target in Obsidian (obsidian:// deep-link). The
  // renderer passes the citation's vault-relative `ref`; main resolves + contains it, then opens it.
  openCitation(ref: string): Promise<OpenCitationResult>;
  // Control Panel · Jobs (SPEC-0027 PANEL-2)
  listJobs(): Promise<JobView[]>;
  setJobConfig(patch: JobConfigPatch): Promise<JobView[]>;
  runJobNow(id: string): Promise<RunJobResult>;
  // SPEC-0029 Audit & Activity (read-only): the curated feed, raw events (drill-down/search), lineage.
  activityFeed(filter?: ActivityFilter): Promise<ActivityFeedResult>;
  activityEvents(filter?: ActivityFilter): Promise<AuditEvent[]>;
  activityLineage(id: string): Promise<Lineage>;
  // Control Panel · Settings + Agents (SPEC-0027 PANEL-3/5)
  getInstanceSettings(): Promise<InstanceSettings>;
  setInstanceSettings(settings: InstanceSettings): Promise<InstanceSettings>;
  listAgents(): Promise<AgentView[]>;
  // SPEC-0028 Researchers (Control Panel · Manage): manage the registry + on-demand run.
  listResearchers(): Promise<ResearcherView[]>;
  setResearcherConfig(patch: ResearcherConfigPatch): Promise<ResearcherView[]>;
  runResearcherNow(id: string): Promise<RunResearcherResult>;
  listResearcherRuns(id: string): Promise<ResearcherLastRun[]>;
}

/** The curated Activity feed + its window-cap signal. Consumers key off `total`/`truncated`, NOT
 *  `entries.length` (the feed is capped to the recent window — SPEC-0029 AUDIT-4/5, QA carry-forward). */
export interface ActivityFeedResult {
  /** Curated, human-friendly entries (one per run), newest-first, within the recent window. */
  entries: ActivityFeedEntry[];
  /** Total conforming events seen across the audit before the window cap. */
  total: number;
  /** True when older events were dropped from this window (never silently — surface in the UI). */
  truncated: boolean;
}
