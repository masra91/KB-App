// SPEC-0048 SCALE — the PURE stage-parallelism constants + clamps (per-stage caps + global ceiling).
// Deliberately free of any node import (no `node:fs`/`node:path`), so the RENDERER (Settings UI) can
// import these values without pulling the node-only `instanceConfig`/pipeline into the Vite bundle
// (the renderer→node-builtin boundary). `instanceConfig.ts` re-exports them, so existing main-process
// importers (pipeline.ts) keep their import site unchanged.

/** The copilot-using pipeline stages whose concurrency cap is configurable (SCALE-2). */
export const SCALE_STAGES = ['archive', 'decompose', 'connect', 'claims', 'compose'] as const;
export type ScaleStage = (typeof SCALE_STAGES)[number];

/** Per-stage caps. Decompose/Claims/Compose ran the hardcoded `STAGE_CAP=3`; Connect & Archive ran
 *  serial (1). INGEST-PERF item 3 un-serialized Archive (1→3); SCALE adaptive-default (SPEC-0048 batch-2)
 *  raises the conservative baselines again — 3 was too low now that the adaptive ceiling (ON by default)
 *  climbs into the teens on real machines, so a per-stage cap of 3 became the bottleneck. Bump
 *  Archive/Decompose/Claims/Compose to 4 (each runs in its own ephemeral worktree with per-source files,
 *  so cap>1 is collision-safe; the global ceiling still bounds the real total). Connect stays at 1 by
 *  default — it's the heaviest cross-KB cognition (dedup/entity-resolution/linking) and a concurrent
 *  default warrants an explicit policy call; it remains Settings-overridable (SCALE-5). */
export const DEFAULT_STAGE_CAPS: Record<ScaleStage, number> = {
  archive: 4,
  decompose: 4,
  connect: 1,
  claims: 4,
  compose: 4,
};

/** Sane per-stage cap bound — a stage running more than this many cognitions at once thrashes more
 *  than it helps, and the global ceiling bounds the real total anyway. */
export const STAGE_CAP_MAX = 8;
/** Sane global-ceiling bounds (SCALE-1) — even a huge box shouldn't fan out unbounded copilot procs. */
export const COPILOT_CEILING_MIN = 1;
export const COPILOT_CEILING_MAX = 32;

/** Clamp one stage's configured cap into [1, {@link STAGE_CAP_MAX}]. A non-finite value falls back to
 *  that stage's default (today's behaviour). (SCALE-5: Connect is no longer pinned — its resolve drain
 *  migrated to per-item ephemeral worktrees, so it clamps like any other stage.) */
export function clampStageCap(stage: ScaleStage, v: unknown): number {
  const n = typeof v === 'number' && Number.isFinite(v) ? Math.floor(v) : DEFAULT_STAGE_CAPS[stage];
  return Math.max(1, Math.min(STAGE_CAP_MAX, n));
}

/** Clamp a configured global ceiling into [{@link COPILOT_CEILING_MIN}, {@link COPILOT_CEILING_MAX}],
 *  or `undefined` (⇒ the engine's cores-derived default) when absent/non-finite. */
export function clampCopilotCeiling(v: unknown): number | undefined {
  if (typeof v !== 'number' || !Number.isFinite(v)) return undefined;
  return Math.max(COPILOT_CEILING_MIN, Math.min(COPILOT_CEILING_MAX, Math.floor(v)));
}

/** Resolve the global ceiling to PERSIST on a settings write (SCALE-1 edit contract). The Auto/Manual
 *  Settings toggle needs three distinct intents over one field — so the renderer encodes them as:
 *    • `undefined` (field omitted) ⇒ PRESERVE the prior value (the #102 preserve-on-omission rule —
 *      a caller editing another field must never clobber this one);
 *    • `null` ⇒ the "let the app decide" CLEAR — drop the override (⇒ the cores-derived default);
 *    • a number ⇒ the manual override, clamped to the sane bounds.
 *  Returns the value to write (`undefined` ⇒ omit the key ⇒ cores-derived). */
export function resolveCeilingWrite(prior: number | undefined, incoming: number | null | undefined): number | undefined {
  if (incoming === undefined) return prior;
  if (incoming === null) return undefined;
  return clampCopilotCeiling(incoming);
}

/** The effective per-stage caps: today's defaults overlaid with any configured overrides. The pipeline
 *  reads THIS to size each stage; the Settings UI renders it. Structural input (just `{ stageCaps? }`)
 *  so this module stays decoupled from the node-only `InstanceConfig`. (SCALE-5: Connect is no longer
 *  force-pinned — it takes its configured/default cap like every other stage.) */
export function resolveStageCaps(cfg: { stageCaps?: Partial<Record<ScaleStage, number>> }): Record<ScaleStage, number> {
  const out = { ...DEFAULT_STAGE_CAPS };
  for (const stage of SCALE_STAGES) {
    const configured = cfg.stageCaps?.[stage];
    out[stage] = configured === undefined ? DEFAULT_STAGE_CAPS[stage] : clampStageCap(stage, configured);
  }
  return out;
}
