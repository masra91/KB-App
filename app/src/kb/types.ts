// Shell-agnostic KB types: the data shapes + the IPC contract between main & renderer.
// No electron/obsidian imports here — this module must stay reusable (STACK-6).
import type { SchedulePreset, AutonomyPosture } from './jobs';

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

/** The API surface exposed to the renderer via contextBridge (preload). */
export interface KbApi {
  getState(): Promise<AppState>;
  pickFolder(): Promise<string | null>;
  inspect(path: string): Promise<PathInspection>;
  create(opts: CreateKbOptions): Promise<CreateKbResult>;
  capture(req: CaptureRequest): Promise<CaptureResult>;
  pipelineStatus(): Promise<PipelineStatus>;
  listReviews(): Promise<ReviewSummary[]>;
  answerReview(req: AnswerReviewRequest): Promise<AnswerReviewResult>;
  fullReplay(): Promise<FullReplayResult>;
  ask(req: AskRequest): Promise<AskResult>;
  // Control Panel · Jobs (SPEC-0027 PANEL-2)
  listJobs(): Promise<JobView[]>;
  setJobConfig(patch: JobConfigPatch): Promise<JobView[]>;
  runJobNow(id: string): Promise<RunJobResult>;
}
