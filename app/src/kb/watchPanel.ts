// Folder-watch view-model (SPEC-0037 WATCH-9) — maps the registry into the unified Sources view's rows,
// overlaying each folder's live `watching` flag (from the scheduler) and its `lastEvent` (folded from the
// `watch` audit, mirroring how researchers/intake fold `lastRun`). Pure — the pipeline supplies the
// watching set + the per-folder newest audit event. DEV-2's unified view does one `kb:listWatchFolders`
// read per render and renders these rows; there is no separate status read.
import type { AuditEvent } from './audit';
import { effectiveWatchDepth, watchDrains, type WatchFolderConfig } from './watchConnectors';
import type { WatchFolderView, WatchFolderLastEvent } from './types';

/** Derive a watched folder's last-event summary from its newest `watch` audit event (or null). */
export function watchLastEventFromEvent(event: AuditEvent | undefined): WatchFolderLastEvent | null {
  if (!event) return null;
  const files = Array.isArray(event.payload.files) ? event.payload.files : [];
  const path = typeof files[0] === 'string' ? files[0] : undefined;
  return { ts: event.ts, kind: event.eventType, ...(path ? { path } : {}) };
}

/**
 * Map the watch registry into display rows (WATCH-9), overlaying the live `watching` set (the scheduler's
 * currently-active watchers) and each folder's newest `watch` audit event. Rows in registry order.
 */
export function buildWatchFolderViews(
  registry: WatchFolderConfig[],
  watchingIds: Set<string>,
  lastEventByWatchId: Record<string, AuditEvent | undefined>,
): WatchFolderView[] {
  return registry.map((f) => ({
    id: f.id,
    folderPath: f.folderPath,
    label: f.label ?? f.id,
    enabled: f.enabled,
    scope: f.scope,
    sensitivity: f.sensitivity,
    ignoreGlobs: f.ignoreGlobs ?? [],
    recursive: f.recursive === true,
    maxDepth: effectiveWatchDepth(f), // clamped effective cap (0 when non-recursive) — WATCH-12
    leaveOriginals: !watchDrains(f), // WATCH-16: drains by default; the toggle is the copy opt-out
    watching: watchingIds.has(f.id),
    lastEvent: watchLastEventFromEvent(lastEventByWatchId[f.id]),
  }));
}
