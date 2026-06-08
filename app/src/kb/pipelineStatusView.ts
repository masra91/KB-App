// The Pipeline Status view-model (SPEC-0030 OBS-5/6/7/11/15) — a read-only snapshot the renderer
// polls to answer "what's the pipeline doing, and why is it stuck?". This module is the PURE
// assembler + derivations (unit-testable); the main process (pipeline.ts) gathers the live/on-disk
// inputs — per-stage queue depths + busy flags, the canonical-writer lock state, recent dev-log
// errors, the perf index, worktrees — and calls `assemblePipelineStatus`. Read-only (OBS-9): it
// reports, it never mutates.
import type { LockState } from './stageLock';
import type { PerfIndex } from './perfIndex';
import type { StageId } from './pipelineStages';
// Type-only imports (erased at compile) so the renderer never pulls the main-only sampler/crash
// modules — and thus never `node:v8`/`node:fs` — into its bundle (the #248 renderer boundary).
import type { MemorySample, MemTrend } from './memorySampler';
import type { CrashBreadcrumb } from './crashCapture';

/**
 * OBS-22 — the Status view's memory/health readout: the current RSS/heap sample, the leak/long-run
 * trend (OBS-21), and the last crash breadcrumb (OBS-18: when/where/last item), so "is memory
 * climbing / did we recently crash + on what" is answerable at a glance. All fields nullable: a
 * fresh boot has no trend yet and (ideally) no crash.
 */
export interface HealthReadout {
  memory: MemorySample | null;
  trend: MemTrend | null;
  lastCrash: CrashBreadcrumb | null;
}

/**
 * One set-aside (poison) item as the Status view renders it (OBS-17) — a thin PRESENTATION shape,
 * distinct from the claims-path domain type (`claimsStage.SetAsideItem`, which carries the full
 * entity ref). `stage` is carried so the panel is stage-parameterized (claims-only v1, but
 * decompose/connect are additive — PM ruling); `reason` is the human cause derived from the
 * domain item's failure/round counts via {@link setAsideReason}.
 */
export interface SetAsideView {
  stage: string;
  itemId: string;
  name?: string;
  reason?: string;
}

/** The fields {@link toSetAsideViews} needs from any stage's set-aside item. `itemId` is the
 *  renderer-facing id the stage surfaces (entityId for claims, blockKey for connect). Kept local +
 *  generic so this view-model stays free of any stage dependency. */
export interface SetAsideSource {
  itemId: string;
  name: string;
  failures: number;
  rounds: number;
}

/** Derive the human "why was this set aside" line (OBS-17). Set-aside happens either after K failed
 *  attempts (ORCH-12) or on the review-cascade round cap (REVIEW-8); prefer the failure count when
 *  present, else the round count, else a generic fallback. */
export function setAsideReason(failures: number, rounds: number): string {
  if (failures > 0) return `set aside after ${failures} failed attempt${failures === 1 ? '' : 's'}`;
  if (rounds > 0) return `set aside after ${rounds} review round${rounds === 1 ? '' : 's'} (cascade cap)`;
  return 'set aside after repeated failures';
}

/** Map a stage's set-aside items to the Status-view presentation shape (OBS-17), tagging the `stage`
 *  and deriving the reason. Stage-agnostic — claims + connect (+ future stages) each map their list
 *  through this; the assembler unions the results. */
export function toSetAsideViews(items: SetAsideSource[], stage: string): SetAsideView[] {
  return items.map((it) => ({
    stage,
    itemId: it.itemId,
    name: it.name,
    reason: setAsideReason(it.failures, it.rounds),
  }));
}

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

/** Cumulative funnel conversion counts (SPEC-0032 VIZ §9 / VIZ-3) — current-state tallies, raw; the
 *  VIZ frontend computes the between-bucket deltas + dedup/fan-out ratios. Each is a conversion point,
 *  not 1:1 with the 6 stations. */
export interface ConversionCounts {
  captured: number;
  candidates: number;
  entities: number;
  claims: number;
  promoted: number;
}

/** One in-flight item (SPEC-0032 VIZ-2) — a "carriage" on the Line: a live source/block at its
 *  current `stage`. `active` marks the one(s) the stage is currently draining (only those ember-
 *  breathe, VIZ-6); the rest are queued behind. `sinceTs` is the drain-start dwell, precise for
 *  active carriages, omitted for queued (DEV-4: dwell is only rendered on the active one). */
export interface InFlightItem {
  itemId: string;
  name: string;
  stage: StageId;
  sinceTs?: string;
  active?: boolean;
}

/** One stage's contribution to the roster: its queue `items` in drain order (head drained first),
 *  whether it's `busy`, its `cap` (the first `cap` items are the active batch while busy), and the
 *  active batch's start time (`since`). */
export interface StageRoster {
  stage: StageId;
  items: { id: string; name?: string }[];
  busy: boolean;
  cap: number;
  since: string | null;
}

/** Build the in-flight carriage roster (SPEC-0032 VIZ-2, pure). Each stage's queue items become
 *  carriages; `active = busy && index < cap` (the drain processes `queue[0..cap)`), and `sinceTs` is
 *  the drain start for active carriages only. `name` falls back to the id. */
export function buildInFlightRoster(stages: StageRoster[]): InFlightItem[] {
  const out: InFlightItem[] = [];
  for (const s of stages) {
    s.items.forEach((it, i) => {
      const active = s.busy && i < s.cap;
      out.push({
        itemId: it.id,
        name: it.name ?? it.id,
        stage: s.stage,
        ...(active ? { active: true } : {}),
        ...(active && s.since ? { sinceTs: s.since } : {}),
      });
    });
  }
  return out;
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
  /** Set-aside / poison items with reason (OBS-17) — the actionable recovery list (claims-only v1). */
  setAsideItems: SetAsideView[];
  /** Cumulative funnel conversion counts (SPEC-0032 VIZ-3). */
  conversion: ConversionCounts;
  /** In-flight items (carriages) with their current stage (SPEC-0032 VIZ-2). */
  inFlight: InFlightItem[];
  /** Memory/health readout — RSS/heap + leak trend + last crash breadcrumb (OBS-22). Optional: a
   *  build without the telemetry wired (or no sample yet) simply omits it. */
  health?: HealthReadout;
  /** When this snapshot was assembled (ISO). */
  builtAt: string;
}

/** No progress for this long with a non-empty queue ⇒ stalled (OBS-11). */
export const DEFAULT_STALL_MS = 5 * 60_000; // 5 minutes

/** A stage's error badge clears this long after its last error (#163): a stage that errored once and
 *  recovered should not stay red forever. A genuinely-broken stage re-errors on each attempt, staying
 *  inside the window → stays red; a recovered one ages out → clears (then `deriveStageState` shows
 *  running/idle). The dev log only carries warn+error here, so there are no info-level "progress"
 *  entries to supersede an error with — freshness is the right (and only available) clearing signal. */
export const DEFAULT_ERROR_FRESH_MS = 2 * 60_000; // 2 minutes

/**
 * Whether a stage should show as **errored** right now (#163): true iff it has an `error`-level entry
 * within `freshMs` of `nowMs`. This bounds the old unbounded "any error in the last-N log lines" check
 * that left recovered stages stuck red. Pure + time-injected so it's testable without a clock.
 */
export function deriveStageError(errors: RecentError[], stage: string, nowMs: number, freshMs: number = DEFAULT_ERROR_FRESH_MS): boolean {
  return errors.some((e) => {
    if (e.stage !== stage || e.level !== 'error') return false;
    const ts = Date.parse(e.ts);
    return Number.isFinite(ts) && nowMs - ts <= freshMs;
  });
}

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
  setAsideItems: SetAsideView[];
  conversion: ConversionCounts;
  inFlight: InFlightItem[];
  /** Memory/health readout (OBS-22), gathered by the main process from the sampler + last-crash file. */
  health?: HealthReadout;
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
  if (parts.lock.stuck) {
    // #163: a stuck-held canonical-writer lock IS a stall — the pipeline is wedged on that section
    // and can't progress. Without this it would read `running` (anyRunning includes `lock.held`),
    // masking the exact silent-deadlock SPEC-0030 exists to surface (OBS-11). The watchdog set `stuck`.
    overall = 'stalled';
  } else if (anyRunning) {
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
    setAsideItems: parts.setAsideItems,
    conversion: parts.conversion,
    inFlight: parts.inFlight,
    ...(parts.health !== undefined ? { health: parts.health } : {}),
    builtAt,
  };
}
