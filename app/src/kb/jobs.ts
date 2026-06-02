// Autonomous Jobs — shared types, journal, and disposition rules (SPEC-0023 JOBS).
//
// A "job" is a recurring, agent-driven pass the scheduler wakes on a cadence to do bounded,
// KB-wide work (Reflect is the first; SPEC-0024). This module holds the contract the engine
// (`jobRegistry` / `jobScheduler` / `jobStage`) and any job *behavior* share — it owns no I/O
// beyond the per-job journal. Behavior of a specific job lives in its own module + spec.

/** Named schedule presets (JOBS-2). Raw cron / event-driven are later extensions the registry
 *  must not preclude — `schedule` is an open string at the storage layer, validated to a preset. */
export const SCHEDULE_PRESETS = ['off', 'daily', 'hourly', 'several-daily'] as const;
export type SchedulePreset = (typeof SCHEDULE_PRESETS)[number];

/** Approximate cadence of each preset, in milliseconds (the scheduler's "is it due?" interval).
 *  `off` never fires. Deliberately coarse — finer/cron cadence is a later escape hatch (JOBS-2). */
export const PRESET_INTERVAL_MS: Record<Exclude<SchedulePreset, 'off'>, number> = {
  'several-daily': 6 * 60 * 60 * 1000, // ~4×/day
  hourly: 60 * 60 * 1000,
  daily: 24 * 60 * 60 * 1000,
};

/** Per-job autonomy posture (JOBS-15) with a safe default. Guarded: additive auto, destructive /
 *  low-confidence → Review. Autonomous: the agent's proposed disposition governs. */
export const AUTONOMY_POSTURES = ['guarded', 'autonomous'] as const;
export type AutonomyPosture = (typeof AUTONOMY_POSTURES)[number];
export const DEFAULT_POSTURE: AutonomyPosture = 'guarded';

/** One registered autonomous job (JOBS-1). `type` selects the behavior; `config` is behavior-specific. */
export interface JobConfig {
  id: string;
  type: string;
  schedule: SchedulePreset;
  enabled: boolean;
  posture: AutonomyPosture;
  config?: Record<string, unknown>;
}

/**
 * A job `id` MUST be a bare slug — a letter/digit then letters/digits/hyphens — because it is
 * consumed DIRECTLY into filesystem paths: the per-job journal `journalRel(id)` (`.kb/jobs/<id>/…`),
 * the disposable worktree (`.kb/cache/worktrees/job-<id>`), and the work branch (`kb/job-<id>-work`).
 * An `id` containing path separators or `..` (`../x`, `../../../tmp/x`) would escape `.kb/jobs` and
 * turn a hand-/foreign-edited `registry.json` into an arbitrary-write vector — same class as JOBS-10's
 * write-sink, different vector. Validate at EVERY boundary an id enters (registry read + write + the
 * run sink) so no single bypass reaches a path (SPEC-0023 JOBS-10 / #29).
 */
export function isSafeJobId(v: unknown): v is string {
  return typeof v === 'string' && /^[a-z0-9][a-z0-9-]*$/i.test(v);
}

/** Disposition of a single finding (JOBS-9): auto-apply on `staging`, or route to the Review queue. */
export type Disposition = 'auto' | 'review';

/**
 * One actionable thing a bounded pass found. The behavior proposes a `disposition` + `kind`; the
 * runner ENFORCES posture (guarded downgrades destructive / low-confidence to `review`). `writes`
 * are additive file effects applied on `staging` when auto; `review` raises an SPEC-0018 Review.
 */
export interface JobFinding {
  summary: string; // human/audit one-liner of what + why (AUTO-8)
  kind: 'additive' | 'destructive';
  confidence: number; // 0..1
  proposed: Disposition; // the behavior's proposed disposition (honored under `autonomous`)
  writes?: { rel: string; content: string }[]; // additive effects (relative to the worktree root)
  // raised when the finding routes to Review. A `consolidation` target carries the merge plan an
  // approved Review executes (SPEC-0024 REFLECT-7) — propagated into the Review's markerKey so the
  // dispatch can run it via the entity-merge core; absent for non-consolidation reviews.
  review?: { question: string; detail?: string; consolidation?: { canonicalRel: string; loserRels: string[] } };
}

/** What a bounded pass returns (JOBS-4/8): what it looked at, what it found, and a cursor for the
 *  next run's continuity (JOBS-7). A pass that finds nothing returns an empty `findings` — a normal
 *  outcome. MUST NOT take external side-effecting action (JOBS-10) — behaviors are pure cognition. */
export interface JobPassResult {
  inspected: string; // what the pass looked at this run (bounded; for audit + journal)
  findings: JobFinding[];
  cursor?: Record<string, unknown>; // opaque continuity state persisted to the journal
}

/** The context a bounded pass reads (JOBS-4/7): the synced worktree root + prior journal entries. */
export interface JobPassContext {
  root: string; // the job's worktree, synced to the canonical checkpoint
  posture: AutonomyPosture;
  config?: Record<string, unknown>;
  journal: JournalEntry[]; // prior run-state, newest last (continuity / awareness)
}

/** A job behavior: one bounded, read-only-w.r.t.-the-world pass. Pluggable by `JobConfig.type`. */
export type JobBehavior = (ctx: JobPassContext) => Promise<JobPassResult>;

/** A per-finding audit record (JOBS-8) carried in the journal line — the *what + why*. */
export interface AuditedFinding {
  summary: string;
  kind: 'additive' | 'destructive';
  confidence: number;
  disposition: Disposition; // the disposition the runner actually applied (post-posture)
  reviewId?: string; // set when routed to Review
  rejection?: string; // set when an auto write was rejected by the sink guard → forced to Review (JOBS-10)
}

/** A persisted run-state journal line (JOBS-7) — operational memory, NOT KB content. One line per
 *  run; doubles as the JOBS-8 rich audit event (it records what was inspected, applied, deferred,
 *  and per-finding reasoning). Read by the next run for continuity/awareness. */
export interface JournalEntry {
  ts: string; // ISO timestamp (run completion)
  runId: string;
  inspected: string;
  applied: number; // findings auto-applied this run
  deferred: number; // findings routed to Review this run
  findings?: AuditedFinding[]; // per-finding audit detail (JOBS-8)
  cursor?: Record<string, unknown>; // continuity state for the next run
  note?: string; // e.g. 'collision-exhausted' set-aside
}

/**
 * Enforce posture on a finding's disposition (JOBS-9/15). Guarded: only additive + high-confidence
 * auto-applies; everything else (destructive, or low-confidence) → Review, never guessed. Autonomous:
 * the behavior's proposed disposition governs. The single source of truth for "auto vs Review".
 */
export const HIGH_CONFIDENCE = 0.8;
export function effectiveDisposition(finding: JobFinding, posture: AutonomyPosture): Disposition {
  if (posture === 'autonomous') return finding.proposed;
  // Guarded (the safe default): additive + high-confidence may auto-apply; else route to Review.
  return finding.kind === 'additive' && finding.confidence >= HIGH_CONFIDENCE ? 'auto' : 'review';
}
