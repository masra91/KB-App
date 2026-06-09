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

/** Instance-wide settings (PANEL-5). v1 holds the autonomy default; grows as Settings does. */
export interface InstanceConfig {
  /** The Instance-wide default autonomy posture (AUTO-12). Jobs inherit it unless they override. */
  autonomyDefault: AutonomyPosture;
  /** Dev-log verbosity (OBS-10): `info` (default) or `debug` to troubleshoot. */
  devLogLevel: DevLogLevel;
  /** Quick Capture global hotkey accelerator (SPEC-0038 QCAP-6), e.g. `Alt+Space`. */
  quickCaptureAccelerator: string;
  /** Recall interactive work budget in ms (ASK-17 / JOBS-17): the `session.idle` wall-clock before
   *  recall returns its best grounded partial. Default {@link DEFAULT_RECALL_BUDGET_MS}; clamped to
   *  [{@link RECALL_BUDGET_MS_MIN}, {@link RECALL_BUDGET_MS_MAX}]. */
  recallBudgetMs: number;
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
  return { autonomyDefault, devLogLevel, quickCaptureAccelerator, recallBudgetMs };
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
