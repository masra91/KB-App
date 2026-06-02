// The Pipeline Status view-model (SPEC-0030 OBS-5/6/7/11/15) — a read-only snapshot the renderer
// polls to answer "what's the pipeline doing, and why is it stuck?". This module is the PURE
// assembler + derivations (unit-testable); the main process (pipeline.ts) gathers the live/on-disk
// inputs — per-stage queue depths + busy flags, the canonical-writer lock state, recent dev-log
// errors, the perf index, worktrees — and calls `assemblePipelineStatus`. Read-only (OBS-9): it
// reports, it never mutates.
import type { LockState } from './stageLock';
import type { PerfIndex } from './perfIndex';

/** Per-stage liveness (OBS-5). */
export type StageState = 'idle' | 'running' | 'blocked' | 'error';

/** Overall pipeline state (OBS-5/11). `stalled` = work queued but no progress past the threshold. */
export type OverallState = 'idle' | 'running' | 'stalled';

/** One stage row in the Status view (OBS-5). */
export interface StageStatus {
  stage: string;
  state: StageState;
  /** Items waiting in this stage's derived queue. */
  queueDepth: number;
  /** Items this stage gave up on after K attempts (OBS-6 / ORCH-12). */
  setAside: number;
  /** The item being processed right now, when the stage exposes one (e.g. archive). */
  currentItem?: string;
}

/** A recent error/warning surfaced from the dev log (OBS-6), carrying the audit cross-link. */
export interface RecentError {
  ts: string;
  level: string;
  event: string;
  stage?: string;
  itemId?: string;
  runId?: string;
  message?: string;
}

/** A live worktree (OBS-7) — which checkout exists + the branch it's on. */
export interface WorktreeInfo {
  path: string;
  branch?: string;
}

/** The assembled Status view-model (OBS-5/6/7/11/15). */
export interface PipelineStatusView {
  /** Overall state (OBS-5/11). */
  overall: OverallState;
  /** True iff `overall === 'stalled'` (work queued, no progress past the threshold) — OBS-11. */
  stalled: boolean;
  /** The most recent pipeline activity (ISO), or undefined if never. */
  lastActivity?: string;
  /** Per-stage rows (OBS-5). */
  stages: StageStatus[];
  /** Canonical-writer lock holder/waiters (OBS-7). */
  lock: LockState;
  /** Recent errors + warnings (OBS-6), newest-first. */
  recentErrors: RecentError[];
  /** Live worktrees (OBS-7). */
  worktrees: WorktreeInfo[];
  /** Latency/throughput aggregation (OBS-15). */
  perf: PerfIndex;
  /** When this snapshot was assembled (ISO). */
  builtAt: string;
}

/** No progress for this long with a non-empty queue ⇒ stalled (OBS-11). */
export const DEFAULT_STALL_MS = 5 * 60_000; // 5 minutes

/** The raw per-stage signals the assembler derives a {@link StageState} from. */
export interface StageInput {
  stage: string;
  queueDepth: number;
  setAside: number;
  /** The stage is actively draining right now (its in-memory busy flag). */
  busy: boolean;
  /** A recent error/warn is attributed to this stage's scope. */
  hasError: boolean;
  currentItem?: string;
}

/**
 * Derive a stage's state from observable signals (OBS-5). Precedence: a recent error wins (so a
 * failing stage reads `error` even between sweeps); else actively draining ⇒ `running`; else an
 * empty queue ⇒ `idle`; else work is waiting but the stage isn't draining ⇒ `blocked` (waiting on
 * the lock / between sweeps — the visible "queued but not moving" state).
 */
export function deriveStageState(input: Pick<StageInput, 'queueDepth' | 'busy' | 'hasError'>): StageState {
  if (input.hasError) return 'error';
  if (input.busy) return 'running';
  if (input.queueDepth === 0) return 'idle';
  return 'blocked';
}

export interface AssembleParts {
  stages: StageInput[];
  lock: LockState;
  recentErrors: RecentError[];
  worktrees: WorktreeInfo[];
  perf: PerfIndex;
  /** Most-recent activity timestamp (ISO) from any source (status, spans, dev log). */
  lastActivity?: string;
}

export interface AssembleOptions {
  now?: () => string;
  /** Stall threshold in ms (OBS-11). Default {@link DEFAULT_STALL_MS}. */
  stallMs?: number;
}

/**
 * Assemble the Status view-model from gathered parts (pure). Computes per-stage states + the
 * overall state with stall detection (OBS-11): if any stage is draining or the lock is held →
 * `running`; else if every queue is empty → `idle`; else work is queued — `stalled` when the last
 * activity is older than the threshold (the silent "N in queue, nothing happening" turned visible),
 * otherwise `running` (recently active, just between sweeps).
 */
export function assemblePipelineStatus(parts: AssembleParts, opts: AssembleOptions = {}): PipelineStatusView {
  const now = opts.now ?? ((): string => new Date().toISOString());
  const stallMs = opts.stallMs ?? DEFAULT_STALL_MS;
  const builtAt = now();

  const stages: StageStatus[] = parts.stages.map((s) => ({
    stage: s.stage,
    state: deriveStageState(s),
    queueDepth: s.queueDepth,
    setAside: s.setAside,
    ...(s.currentItem !== undefined ? { currentItem: s.currentItem } : {}),
  }));

  const anyRunning = parts.stages.some((s) => s.busy) || parts.lock.held;
  const totalQueue = parts.stages.reduce((n, s) => n + s.queueDepth, 0);

  let overall: OverallState;
  if (anyRunning) {
    overall = 'running';
  } else if (totalQueue === 0) {
    overall = 'idle';
  } else {
    // Work is queued but nothing is running — stalled iff we've made no progress for a while.
    const lastMs = parts.lastActivity ? Date.parse(parts.lastActivity) : NaN;
    const ageMs = Number.isFinite(lastMs) ? Date.parse(builtAt) - lastMs : Infinity;
    overall = ageMs > stallMs ? 'stalled' : 'running';
  }

  return {
    overall,
    stalled: overall === 'stalled',
    ...(parts.lastActivity !== undefined ? { lastActivity: parts.lastActivity } : {}),
    stages,
    lock: parts.lock,
    recentErrors: parts.recentErrors,
    worktrees: parts.worktrees,
    perf: parts.perf,
    builtAt,
  };
}
