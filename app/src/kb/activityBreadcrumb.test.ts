// SPEC-0030 OBS-18 — the activity breadcrumb that names the last pipeline {stage,item,run} for a crash.
import { describe, it, expect, beforeEach } from 'vitest';
import { noteActivity, currentBreadcrumb, resetBreadcrumb, breadcrumbObserver } from './activityBreadcrumb';
import { createDevLog } from './devlog';
import { makeTempDir, rmTempDir } from '../../test/tempVault';

describe('activityBreadcrumb (OBS-18)', () => {
  beforeEach(() => resetBreadcrumb());

  it('starts empty', () => {
    expect(currentBreadcrumb()).toEqual({});
  });

  it('records the latest stage/item/run/event/ts', () => {
    noteActivity({ ts: 'T1', event: 'claims.start', scope: 'claims', runId: 'R1', itemId: 'E1' });
    expect(currentBreadcrumb()).toEqual({ ts: 'T1', event: 'claims.start', stage: 'claims', runId: 'R1', itemId: 'E1' });
  });

  it('persists the last item/run across an id-less line (a lock heartbeat must not erase the item)', () => {
    noteActivity({ ts: 'T1', event: 'claims.start', scope: 'claims', runId: 'R1', itemId: 'E1' });
    noteActivity({ ts: 'T2', event: 'lock.acquired', scope: 'lock' }); // no item/run
    expect(currentBreadcrumb()).toEqual({ ts: 'T2', event: 'lock.acquired', stage: 'lock', runId: 'R1', itemId: 'E1' });
  });

  it('advances item/run when a newer line carries them', () => {
    noteActivity({ ts: 'T1', scope: 'claims', itemId: 'E1', runId: 'R1' });
    noteActivity({ ts: 'T2', scope: 'decompose', itemId: 'E2' });
    expect(currentBreadcrumb()).toMatchObject({ stage: 'decompose', itemId: 'E2', runId: 'R1' });
  });

  it('returns a copy (callers cannot mutate internal state)', () => {
    noteActivity({ itemId: 'E1' });
    const snap = currentBreadcrumb();
    snap.itemId = 'MUT';
    expect(currentBreadcrumb().itemId).toBe('E1');
  });

  it('breadcrumbObserver wired into a dev-log onEmit records real pipeline activity end-to-end', async () => {
    const dir = await makeTempDir('kb-crumb-');
    try {
      const log = createDevLog({ dir, now: () => '2026-06-08T00:00:00.000Z', onEmit: breadcrumbObserver }).child({ scope: 'decompose', runId: 'R9' });
      log.info('decompose.start', { itemId: 'SRC7' });
      await log.flush();
      expect(currentBreadcrumb()).toMatchObject({ stage: 'decompose', runId: 'R9', itemId: 'SRC7', event: 'decompose.start' });
    } finally {
      await rmTempDir(dir);
    }
  });
});
