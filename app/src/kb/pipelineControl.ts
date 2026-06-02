// Pipeline recovery-action planning (SPEC-0030 OBS-17) — the PURE, STAGE-AGNOSTIC decision layer
// behind the `kb:pipelineControl` IPC. Given a stage's *pre-resolved* set-aside list (each item
// carrying the renderer-facing `id`, the server-derived `handle` the primitive acts on, and a
// friendly `label`) plus the request, it validates the action and resolves `id → handle`, or returns
// why it can't proceed. The main process (pipeline.ts) is thin glue: it picks the stage's list
// (claims/connect/…), runs this plan, and calls the stage-owned primitives under the lock. Keeping
// this stage-agnostic is the OBS-17 seam — a new stage is "build its list + register a dispatch
// branch", never a reshape here. Unit-testable without electron.
import type { PipelineControlRequest } from './types';

/** One recoverable set-aside item, resolved to what the action layer needs. `id` is what the renderer
 *  sends as `itemId` (entityId for claims, blockKey for connect — a *lookup key only*); `handle` is the
 *  server-derived value the stage primitive acts on (never renderer-supplied — the #153/#157 trust
 *  boundary); `label` is the friendly name for the outcome message. */
export interface SetAsideTarget {
  id: string;
  handle: string;
  label: string;
}

/** The resolved action to run (an opaque `handle` for the stage primitive), or a human reason it
 *  can't proceed. */
export type SetAsideActionPlan = { handle: string; label: string } | { error: string };

/**
 * Plan a set-aside recovery action (OBS-17), stage-agnostic. Validates the action, then resolves the
 * request's `itemId` to its item in the *current* list — if it's not there, it was already
 * recovered/dismissed (or re-derived): a no-op, not a throw (the read-outside-lock / act-under-lock
 * TOCTOU is benign because re-appending `reopened`/`dismissed` is idempotent — KB-QD's #153/#157
 * constraint). The caller (pipeline.ts) has already chosen the stage's list, so this needs no stage
 * knowledge; an unsupported stage is rejected there before a list is built.
 */
export function planSetAsideAction(items: SetAsideTarget[], req: PipelineControlRequest): SetAsideActionPlan {
  if (req.action !== 'retry' && req.action !== 'dismiss') {
    return { error: `Unknown action “${String(req.action)}”.` };
  }
  const item = items.find((i) => i.id === req.itemId);
  if (!item) {
    return { error: `“${req.itemId}” is no longer set aside (already recovered or dismissed).` };
  }
  return { handle: item.handle, label: item.label };
}
