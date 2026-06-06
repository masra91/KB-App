// Intake scheduler tests (SPEC-0041 INTAKE-1/11). Real FS + git (the tick runs runIntakeConnector,
// which commits). Asserts restart-safe "due" derived from the last `intake` audit event, single-flight
// per connector, the type→fetch selection, and that a not-yet-shipped type surfaces (not silent).
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { createKb } from './vault';
import { readEvents } from './activityIndex';
import { writeIntakeRegistry } from './intakeRegistry';
import { isIntakeDue, selectIntakeFn, IntakeScheduler } from './intakeScheduler';
import { runIntakeConnector } from './intakeRun';
import { PRESET_INTERVAL_MS } from './jobs';
import type { IntakeConnectorConfig, IntakeFetchFn, IntakeItem } from './intakeConnectors';

function gitInstalledSync(): boolean {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}
const gitAvailable = gitInstalledSync();

const conn = (over: Partial<IntakeConnectorConfig> = {}): IntakeConnectorConfig => ({
  id: 'news', type: 'rss', schedule: 'hourly', enabled: true, scope: 'global', sensitivity: 'internal', ...over,
});
const items: IntakeItem[] = [{ externalId: 'a', title: 'A', contentMd: 'body a' }];
const fetchOf = (its: IntakeItem[]): IntakeFetchFn => async () => its;

describe.skipIf(!gitAvailable)('IntakeScheduler (SPEC-0041)', () => {
  let dir: string;
  let vault: string;
  beforeEach(async () => {
    const { makeTempDir } = await import('../../test/tempVault');
    dir = await makeTempDir();
    vault = path.join(dir, 'vault');
    await createKb({ path: vault, initGitIfNeeded: true });
  });
  afterEach(async () => {
    const { rmTempDir } = await import('../../test/tempVault');
    await rmTempDir(dir);
  });

  it('isIntakeDue: off/disabled never due; enabled+scheduled+never-run is due', async () => {
    expect(await isIntakeDue(vault, conn({ schedule: 'off' }), Date.now())).toBe(false);
    expect(await isIntakeDue(vault, conn({ enabled: false }), Date.now())).toBe(false);
    expect(await isIntakeDue(vault, conn(), Date.now())).toBe(true); // never run → due
  });

  it('isIntakeDue: not due right after a pass; due once the interval elapses', async () => {
    const t0 = Date.parse('2025-06-03T12:00:00.000Z');
    await runIntakeConnector(vault, conn(), { fetch: fetchOf(items), now: () => new Date(t0).toISOString() });
    expect(await isIntakeDue(vault, conn(), t0 + 1000)).toBe(false); // just ran
    expect(await isIntakeDue(vault, conn(), t0 + PRESET_INTERVAL_MS.hourly + 1)).toBe(true); // interval elapsed
  });

  it('tick fires every enabled+due connector once, then not again until due', async () => {
    await writeIntakeRegistry(vault, [conn()]);
    const sched = new IntakeScheduler(vault, { fetchOverride: fetchOf(items) });
    const now = Date.parse('2025-06-03T12:00:00.000Z');
    expect(await sched.tick(now)).toEqual(['news']);
    expect((await readEvents(vault, { actors: ['intake'] }))[0].eventType).toBe('intook');
    expect(await sched.tick(now + 1000)).toEqual([]); // just ran → not due
  });

  it('selectIntakeFn: rss is supported; m365-mail surfaces as a thrown error (Slice 2, not silent)', async () => {
    expect(typeof selectIntakeFn(conn())).toBe('function');
    const m365 = selectIntakeFn(conn({ type: 'm365-mail' }));
    await expect(m365(conn({ type: 'm365-mail' }), { maxItems: 25 })).rejects.toThrow(/Slice 2/);
  });
});
