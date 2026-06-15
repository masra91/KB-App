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

// SPEC-0026 ASK-17/19 — the recall budget constants/clamps live in the PURE `recallConstants` module
// (no node import) so the renderer's "Recall & Ask" Settings card can consume the bounds without
// pulling this node-only file into the Vite bundle (the renderer→node-builtin boundary). Imported for
// local use + re-exported so existing main-process import sites (recall.ts, pipeline.ts) stay unchanged.
import {
  DEFAULT_RECALL_BUDGET_MS,
  RECALL_BUDGET_MS_MIN,
  RECALL_BUDGET_MS_MAX,
  clampRecallBudgetMs,
  clampRecallMaxToolCalls,
  resolveRecallMaxToolCallsWrite,
} from './recallConstants';
export { DEFAULT_RECALL_BUDGET_MS, RECALL_BUDGET_MS_MIN, RECALL_BUDGET_MS_MAX, clampRecallBudgetMs, clampRecallMaxToolCalls, resolveRecallMaxToolCallsWrite };

// SPEC-0048 SCALE — the stage-parallelism constants/clamps live in the PURE `scaleConstants` module
// (no node import) so the renderer's Settings UI can consume them without pulling this node-only file
// into the Vite bundle. Imported for local use + re-exported so existing main-process import sites
// (pipeline.ts) keep importing them from here unchanged.
import {
  SCALE_STAGES,
  DEFAULT_STAGE_CAPS,
  STAGE_CAP_MAX,
  COPILOT_CEILING_MIN,
  COPILOT_CEILING_MAX,
  clampStageCap,
  clampCopilotCeiling,
  resolveStageCaps,
  resolveCeilingWrite,
  type ScaleStage,
} from './scaleConstants';
export { SCALE_STAGES, DEFAULT_STAGE_CAPS, STAGE_CAP_MAX, COPILOT_CEILING_MIN, COPILOT_CEILING_MAX, clampStageCap, clampCopilotCeiling, resolveStageCaps, resolveCeilingWrite };
export type { ScaleStage };

/** Instance-wide settings (PANEL-5). v1 holds the autonomy default; grows as Settings does. */
export interface InstanceConfig {
  /** The Instance-wide default autonomy posture (AUTO-12). Jobs inherit it unless they override. */
  autonomyDefault: AutonomyPosture;
  /** SPEC-0048 SCALE-2: per-stage concurrency cap overrides (`{decompose: 3, claims: 2, …}`). Absent
   *  keys ⇒ today's default ({@link DEFAULT_STAGE_CAPS}). Read via {@link resolveStageCaps}. (SCALE-5:
   *  Connect is now cap-configurable too — its resolve drain migrated to per-item ephemeral worktrees.) */
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
  /** Recall's explicit retrieval tool-call override (ASK-19 / JOBS-17): a per-instance fixed hop/
   *  tool-call ceiling that wins over the graph-size-scaled {@link recallBudget} default. Omitted ⇒
   *  the scaled default ("scale to KB size"). Clamped to [{@link RECALL_BUDGET}.MIN, .MAX] on read. */
  recallMaxToolCalls?: number;
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
  /** SPEC-0048: per-agent model picks (AGENT_CATALOG key → model id) — an agent's pin wins over `model`
   *  for that agent only. Validated against the live catalog at set-time; an agent with no entry uses
   *  the global default. Omitted/empty ⇒ all agents use the global. */
  agentModels?: Record<string, string>;
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
  // ASK-19: the optional retrieval tool-call override — absent/garbled/out-of-range ⇒ undefined (the
  // graph-size-scaled default applies); a sane number is clamped to [RECALL_BUDGET.MIN, .MAX].
  const recallMaxToolCalls = clampRecallMaxToolCalls(o.recallMaxToolCalls);
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
  // SCALE-1/2: optional scale overrides — each stage cap clamped (SCALE-5: Connect clamps like the rest
  // now, no longer pinned); the global ceiling clamped or omitted (⇒ cores-derived default). Junk
  // keys/values are dropped, never throw — a hand-edited/old `instance.json` degrades to today's behaviour.
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
  // SPEC-0048: per-agent model picks — keep only string-keyed non-empty-string values (drop junk);
  // validation against the live catalog is at set-time (the picker IPC) / startup, not here.
  let agentModels: Record<string, string> | undefined;
  if (typeof o.agentModels === 'object' && o.agentModels !== null && !Array.isArray(o.agentModels)) {
    const raw = o.agentModels as Record<string, unknown>;
    const cleaned: Record<string, string> = {};
    for (const [k, v] of Object.entries(raw)) {
      if (typeof v === 'string' && v.trim().length > 0) cleaned[k] = v.trim();
    }
    if (Object.keys(cleaned).length > 0) agentModels = cleaned;
  }
  return {
    autonomyDefault,
    devLogLevel,
    quickCaptureAccelerator,
    recallBudgetMs,
    ...(recallMaxToolCalls !== undefined ? { recallMaxToolCalls } : {}),
    ...(modelPreferences ? { modelPreferences } : {}),
    ...(model ? { model } : {}),
    ...(agentModels ? { agentModels } : {}),
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
