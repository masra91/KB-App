// Folder-watch view-model (SPEC-0037 WATCH-9). Pure — folds the live `watching` flag + the newest
// `watch` audit event into each row, mirroring the researcher/intake lastRun fold.
import { describe, it, expect } from 'vitest';
import { buildWatchFolderViews, watchLastEventFromEvent } from './watchPanel';
import type { WatchFolderConfig } from './watchConnectors';
import type { AuditEvent } from './audit';

const folder = (over: Partial<WatchFolderConfig> = {}): WatchFolderConfig => ({ id: 'drop', folderPath: '/abs/inbox', enabled: true, scope: 'global', sensitivity: 'internal', ...over });
const ev = (over: Partial<AuditEvent> = {}): AuditEvent => ({ ts: '2026-01-02T00:00:00.000Z', actor: 'watch', eventType: 'watch-ingested', subjects: { watchId: 'drop' }, payload: { files: ['report.md'] }, provenance: { file: 'x', line: 0 }, ...over });

describe('watchLastEventFromEvent', () => {
  it('returns null when there is no event', () => {
    expect(watchLastEventFromEvent(undefined)).toBeNull();
  });
  it('folds ts + kind + a representative file path (ingested)', () => {
    expect(watchLastEventFromEvent(ev())).toEqual({ ts: '2026-01-02T00:00:00.000Z', kind: 'watch-ingested', path: 'report.md' });
  });
  it('omits path for an event with no files (no-new / refused)', () => {
    expect(watchLastEventFromEvent(ev({ eventType: 'watch-no-new', payload: {} }))).toEqual({ ts: '2026-01-02T00:00:00.000Z', kind: 'watch-no-new' });
  });
});

describe('buildWatchFolderViews', () => {
  it('maps config + overlays the live watching flag + the folded lastEvent (one read, WATCH-9)', () => {
    const views = buildWatchFolderViews(
      [folder({ id: 'drop', label: 'Inbox', ignoreGlobs: ['*.tmp'] }), folder({ id: 'photos', enabled: false })],
      new Set(['drop']), // only `drop` has a live watcher
      { drop: ev(), photos: undefined },
    );
    expect(views[0]).toMatchObject({ id: 'drop', label: 'Inbox', watching: true, ignoreGlobs: ['*.tmp'] });
    expect(views[0].lastEvent).toEqual({ ts: '2026-01-02T00:00:00.000Z', kind: 'watch-ingested', path: 'report.md' });
    // `photos` is disabled → no live watcher, no events.
    expect(views[1]).toMatchObject({ id: 'photos', label: 'photos', watching: false, lastEvent: null });
  });
});
