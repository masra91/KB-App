// Pipeline recovery-action planning (SPEC-0030 OBS-17) — the PURE decision layer behind the
// `kb:pipelineControl` IPC: given the live set-aside list + a {action, stage, itemId} request,
// decide which entity node to act on (resolving the surfaced itemId → its repo-relative path) or
// why the action can't proceed. The main process (pipeline.ts) is thin glue that runs this plan
// against the stage-owned primitives (`retryClaimsItem`/`dismissClaimsItem`) under the lock — so
// the branchy logic stays here, unit-testable without electron. Claims-only in v1 (PM ruling); the
// stage guard is the seam where decompose/connect become additive.
import type { PipelineControlRequest } from './types';
import type { SetAsideItem } from './claimsStage';

/** The resolved action to run, or a human reason it can't proceed. */
export type SetAsideActionPlan = { entityRel: string; label: string } | { error: string };

/** Plan a set-aside recovery action (OBS-17): validate the stage + action, then resolve the request's
 *  `itemId` (the surfaced entity id) to the entity's node path against the *current* set-aside list —
 *  if it's not there, it was already recovered/dismissed (or re-derived), which is a no-op, not an
 *  error to throw. `label` is the friendly name (falls back to the id) for the outcome message. */
export function planSetAsideAction(items: SetAsideItem[], req: PipelineControlRequest): SetAsideActionPlan {
  if (req.stage !== 'claims') {
    return { error: `Recovery for the “${req.stage}” stage isn’t supported yet (claims-only for now).` };
  }
  if (req.action !== 'retry' && req.action !== 'dismiss') {
    return { error: `Unknown action “${String(req.action)}”.` };
  }
  const item = items.find((i) => i.entityId === req.itemId);
  if (!item) {
    return { error: `“${req.itemId}” is no longer set aside (already recovered or dismissed).` };
  }
  return { entityRel: item.entityRel, label: item.name || item.entityId };
}
