// Per-Instance config (SPEC-0027 PANEL-5 / AUTO-12) — Instance-wide settings the Control Panel's
// Settings view owns. Stored at `.kb/instance.json` (per-vault, like the job registry — NOT the
// app-global appConfig; an Instance default is a property of a KB). It lives under `.kb/` (tracked
// on `staging`, never promoted, hidden from Obsidian on `main`), so it's git-auditable but invisible
// to the vault. Deliberately kept OUT of the core VaultConfig / SPEC-0007 data model.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { AUTONOMY_POSTURES, DEFAULT_POSTURE, type AutonomyPosture } from './jobs';

const INSTANCE_REL = path.join('.kb', 'instance.json');

/** Dev-log verbosity the Settings view exposes (SPEC-0030 OBS-10): `info` by default, `debug` to
 *  troubleshoot (at `debug`, redaction-protected `sensitive` fields are included verbatim — devlog.ts). */
export const DEV_LOG_LEVELS = ['info', 'debug'] as const;
export type DevLogLevel = (typeof DEV_LOG_LEVELS)[number];
export const DEFAULT_DEV_LOG_LEVEL: DevLogLevel = 'info';

/** Shipped default Quick Capture global hotkey (SPEC-0038 QCAP fork #1 — ⌥Space). Configurable
 *  (QCAP-6) via Settings; the agent owns full accelerator-grammar validation + conflict-detection
 *  at registration, so persistence only needs a non-empty string here. */
export const DEFAULT_QUICK_CAPTURE_ACCELERATOR = 'Alt+Space';

/** Recall's interactive work budget (ASK-17): the wall-clock the SDK `session.idle` wait is given
 *  before recall stops and returns its best grounded partial. The interactive instance of the
 *  JOBS-17 work-depth knob. The shipped 60s default was too tight for a real grounded multi-hop over
 *  a large KB (1007 entities) — raised to 4min. Principal-configurable (Settings) within sane bounds:
 *  a query the human is actively waiting on should finish, but never hang unboundedly. */
export const DEFAULT_RECALL_BUDGET_MS = 240_000;
export const RECALL_BUDGET_MS_MIN = 60_000; // never below the old hard 60s
export const RECALL_BUDGET_MS_MAX = 600_000; // 10min ceiling — an interactive op must stay bounded

// ── SPEC-0048 SCALE: user-configurable stage parallelism (per-stage caps + global ceiling) ──────────
//
// The engine already HAS these knobs (per-stage cap ORCH-20, global copilot ceiling ORCH-23) — they
// were hardcoded/auto-derived. SCALE-1/2 persist them here so the Principal can tune throughput. The
// stored values are OPTIONAL overrides: omitted ⇒ today's behaviour (the cores-derived ceiling + the
// per-stage cap defaults below), so an absent/old `instance.json` is byte-for-byte today's pipeline.

/** The copilot-using pipeline stages whose concurrency cap is configurable (SCALE-2). */
export const SCALE_STAGES = ['archive', 'decompose', 'connect', 'claims', 'compose'] as const;
export type ScaleStage = (typeof SCALE_STAGES)[number];

/** Today's per-stage caps (SCALE-2 default = current behaviour). Decompose/Claims/Compose ran the
 *  hardcoded `STAGE_CAP=3`; Connect & Archive ran serial (1). */
export const DEFAULT_STAGE_CAPS: Record<ScaleStage, number> = {
  archive: 1,
  decompose: 3,
  connect: 1,
  claims: 3,
  compose: 3,
};

/** Sane per-stage cap bound — a stage running more than this many cognitions at once thrashes more
 *  than it helps, and the global ceiling bounds the real total anyway. */
export const STAGE_CAP_MAX = 8;
/** Sane global-ceiling bounds (SCALE-1) — even a huge box shouldn't fan out unbounded copilot procs. */
export const COPILOT_CEILING_MIN = 1;
export const COPILOT_CEILING_MAX = 32;

/** SCALE-5: Connect's resolver races on shared `entities/` until its ephemeral-worktree migration
 *  (Phase 2). Until then its cap is PINNED to 1 — enforced here (defense-in-depth) so a hand-edited
 *  `instance.json` can't set Connect>1 and corrupt dedup; the UI also pins it with a note. */
export const CONNECT_CAP_PINNED = 1;

/** Clamp one stage's configured cap into [1, {@link STAGE_CAP_MAX}]; Connect is pinned to 1 (SCALE-5).
 *  A non-finite value falls back to that stage's default (today's behaviour). */
export function clampStageCap(stage: ScaleStage, v: unknown): number {
  if (stage === 'connect') return CONNECT_CAP_PINNED;
  const n = typeof v === 'number' && Number.isFinite(v) ? Math.floor(v) : DEFAULT_STAGE_CAPS[stage];
  return Math.max(1, Math.min(STAGE_CAP_MAX, n));
}

/** Clamp a configured global ceiling into [{@link COPILOT_CEILING_MIN}, {@link COPILOT_CEILING_MAX}],
 *  or `undefined` (⇒ the engine's cores-derived default) when absent/non-finite. */
export function clampCopilotCeiling(v: unknown): number | undefined {
  if (typeof v !== 'number' || !Number.isFinite(v)) return undefined;
  return Math.max(COPILOT_CEILING_MIN, Math.min(COPILOT_CEILING_MAX, Math.floor(v)));
}

/** The effective per-stage caps: today's defaults overlaid with any configured overrides (Connect
 *  pinned). The pipeline reads THIS to size each stage; the Settings UI renders it. */
export function resolveStageCaps(cfg: Pick<InstanceConfig, 'stageCaps'>): Record<ScaleStage, number> {
  const out = { ...DEFAULT_STAGE_CAPS };
  for (const stage of SCALE_STAGES) {
    const configured = cfg.stageCaps?.[stage];
    out[stage] = configured === undefined ? DEFAULT_STAGE_CAPS[stage] : clampStageCap(stage, configured);
  }
  out.connect = CONNECT_CAP_PINNED; // SCALE-5 always
  return out;
}

/** Instance-wide settings (PANEL-5). v1 holds the autonomy default; grows as Settings does. */
export interface InstanceConfig {
  /** The Instance-wide default autonomy posture (AUTO-12). Jobs inherit it unless they override. */
  autonomyDefault: AutonomyPosture;
  /** SPEC-0048 SCALE-2: per-stage concurrency cap overrides (`{decompose: 3, claims: 2, …}`). Absent
   *  keys ⇒ today's default ({@link DEFAULT_STAGE_CAPS}); Connect is always pinned to 1 (SCALE-5).
   *  Read via {@link resolveStageCaps}. */
  stageCaps?: Partial<Record<ScaleStage, number>>;
  /** SPEC-0048 SCALE-1: the global Copilot concurrency ceiling override (ORCH-23). Omitted ⇒ the
   *  engine's cores-derived default; env `KB_COPILOT_MAX_CONCURRENCY` still wins over both. */
  copilotCeiling?: number;
  /** Dev-log verbosity (OBS-10): `info` (default) or `debug` to troubleshoot. */
  devLogLevel: DevLogLevel;
  /** Quick Capture global hotkey accelerator (SPEC-0038 QCAP-6), e.g. `Alt+Space`. */
  quickCaptureAccelerator: string;
  /** Recall interactive work budget in ms (ASK-17 / JOBS-17): the `session.idle` wall-clock before
   *  recall returns its best grounded partial. Default {@link DEFAULT_RECALL_BUDGET_MS}; clamped to
   *  [{@link RECALL_BUDGET_MS_MIN}, {@link RECALL_BUDGET_MS_MAX}]. */
  recallBudgetMs: number;
  /** ORCH-28 model-resilience: an ordered launch-model preference list overriding the in-app default
   *  (the catalog moves faster than our releases, so re-pinning must not need a code release). Omitted
   *  ⇒ the code default (`copilotModelProbe.DEFAULT_MODEL_PREFERENCES`). The startup probe resolves the
   *  first entry the live CLI accepts; `auto` is the implicit last resort. */
  modelPreferences?: string[];
  /** SPEC-0048: the Principal's explicit global model choice (Agents-view picker). When set AND accepted
   *  by the live CLI it wins over `modelPreferences`; an unaccepted value is rejected at startup (WARN)
   *  and the preference-list resolution is used instead — a stale pick can never hard-break the pipeline.
   *  Omitted ⇒ no override (the preference-list probe drives). */
  model?: string;
}

/** Absolute path to a vault's instance-config file. */
export function instanceConfigPath(root: string): string {
  return path.join(path.resolve(root), INSTANCE_REL);
}

/** The safe default Instance config (Guarded autonomy + `info` dev-log verbosity + ⌥Space hotkey). */
export function defaultInstanceConfig(): InstanceConfig {
  return {
    autonomyDefault: DEFAULT_POSTURE,
    devLogLevel: DEFAULT_DEV_LOG_LEVEL,
    quickCaptureAccelerator: DEFAULT_QUICK_CAPTURE_ACCELERATOR,
    recallBudgetMs: DEFAULT_RECALL_BUDGET_MS,
  };
}

/** Clamp a configured recall budget into the sane bounds (ASK-17); a non-finite value → default. */
export function clampRecallBudgetMs(v: unknown): number {
  const n = typeof v === 'number' ? v : Number.NaN;
  if (!Number.isFinite(n)) return DEFAULT_RECALL_BUDGET_MS;
  return Math.max(RECALL_BUDGET_MS_MIN, Math.min(RECALL_BUDGET_MS_MAX, n));
}

/** Read the Instance config (PANEL-5). Missing/malformed file or unknown posture → safe defaults. */
export async function readInstanceConfig(root: string): Promise<InstanceConfig> {
  let raw: string;
  try {
    raw = await fs.readFile(instanceConfigPath(root), 'utf8');
  } catch {
    return defaultInstanceConfig();
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return defaultInstanceConfig();
  }
  const o = (typeof parsed === 'object' && parsed !== null ? parsed : {}) as Record<string, unknown>;
  const autonomyDefault = (AUTONOMY_POSTURES as readonly string[]).includes(o.autonomyDefault as string)
    ? (o.autonomyDefault as AutonomyPosture)
    : DEFAULT_POSTURE;
  const devLogLevel = (DEV_LOG_LEVELS as readonly string[]).includes(o.devLogLevel as string)
    ? (o.devLogLevel as DevLogLevel)
    : DEFAULT_DEV_LOG_LEVEL;
  // QCAP-6: a non-empty string persists; full accelerator-grammar validation + conflict-handling
  // happen at hotkey registration (the agent), which degrades to the menubar on a bad/clashing value.
  const quickCaptureAccelerator =
    typeof o.quickCaptureAccelerator === 'string' && o.quickCaptureAccelerator.trim().length > 0
      ? o.quickCaptureAccelerator
      : DEFAULT_QUICK_CAPTURE_ACCELERATOR;
  const recallBudgetMs = clampRecallBudgetMs(o.recallBudgetMs); // ASK-17: absent/garbled/out-of-range → safe
  // ORCH-28: a configured preference list must be a non-empty array of non-empty strings, else omit
  // (→ the code default). Trimmed; junk entries dropped; an all-junk/empty result is treated as absent.
  let modelPreferences: string[] | undefined;
  if (Array.isArray(o.modelPreferences)) {
    const cleaned = o.modelPreferences.filter((m): m is string => typeof m === 'string' && m.trim().length > 0).map((m) => m.trim());
    if (cleaned.length > 0) modelPreferences = cleaned;
  }
  // SPEC-0048 MODEL: the global model override — a non-empty string persists; validation against the
  // live CLI catalog happens at startup (initLaunchModel) / at set-time (the picker IPC), not here.
  const model = typeof o.model === 'string' && o.model.trim().length > 0 ? o.model.trim() : undefined;
  // SCALE-1/2: optional scale overrides — each stage cap clamped (Connect pinned to 1, SCALE-5); the
  // global ceiling clamped or omitted (⇒ cores-derived default). Junk keys/values are dropped, never
  // throw — a hand-edited/old `instance.json` degrades to today's behaviour.
  let stageCaps: Partial<Record<ScaleStage, number>> | undefined;
  if (typeof o.stageCaps === 'object' && o.stageCaps !== null) {
    const raw = o.stageCaps as Record<string, unknown>;
    const cleaned: Partial<Record<ScaleStage, number>> = {};
    for (const stage of SCALE_STAGES) {
      if (raw[stage] !== undefined) cleaned[stage] = clampStageCap(stage, raw[stage]);
    }
    if (Object.keys(cleaned).length > 0) stageCaps = cleaned;
  }
  const copilotCeiling = clampCopilotCeiling(o.copilotCeiling);
  return {
    autonomyDefault,
    devLogLevel,
    quickCaptureAccelerator,
    recallBudgetMs,
    ...(modelPreferences ? { modelPreferences } : {}),
    ...(model ? { model } : {}),
    ...(stageCaps ? { stageCaps } : {}),
    ...(copilotCeiling !== undefined ? { copilotCeiling } : {}),
  };
}

/** Write the Instance config (Settings edit, PANEL-5/6) — deterministic, stable key order. */
export async function writeInstanceConfig(root: string, cfg: InstanceConfig): Promise<void> {
  const p = instanceConfigPath(root);
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, JSON.stringify(cfg, null, 2) + '\n', 'utf8');
}

/**
 * Resolve a job's effective autonomy posture (AUTO-12 cascade) — **the single swap point** if the
 * Principal's per-Instance-posture ruling lands differently (only this function changes; the
 * `.kb/instance.json` storage + the Settings UI stay). Working cascade: an **explicit per-job
 * posture wins**; otherwise the job **inherits the Instance default**.
 */
export function resolveJobPosture(instanceDefault: AutonomyPosture, jobPosture: AutonomyPosture | undefined): AutonomyPosture {
  return jobPosture ?? instanceDefault;
}
