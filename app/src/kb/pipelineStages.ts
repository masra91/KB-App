// The canonical pipeline stage order (SPEC-0014 ORCH / SPEC-0032 VIZ §9). The single shared
// source of truth for "what are the stages, in what order" — imported by the backend (the Status
// view-model + OBS-17 recovery dispatch) AND the VIZ frontend (the carriage stepper fill: stages
// before the item's current one are done, the current one is lit, the rest pending). Keeping it
// here, in one place both sides import, means the two can't drift.
//
// Capture → Archive → Decompose → Connect → Claims → Promote. `capture` (the user's quick-add) and
// `promote` (the gate that publishes staging → main) bracket the four item-processing drains
// (archive/decompose/connect/claims) where an in-flight item actually sits.

/** The canonical, ordered pipeline stages. */
export const STAGE_ORDER = ['capture', 'archive', 'decompose', 'connect', 'claims', 'promote'] as const;

/** A canonical pipeline stage id. */
export type StageId = (typeof STAGE_ORDER)[number];

/** True iff `s` is a canonical stage id (narrows `string` → {@link StageId}). */
export function isStageId(s: string): s is StageId {
  return (STAGE_ORDER as readonly string[]).includes(s);
}

/** The stage's position in the pipeline (0-based), or -1 if not a canonical stage. Drives the
 *  stepper fill: a stage with `stageIndex < current` is done, `=== current` is active, `>` pending. */
export function stageIndex(s: string): number {
  return (STAGE_ORDER as readonly string[]).indexOf(s);
}
