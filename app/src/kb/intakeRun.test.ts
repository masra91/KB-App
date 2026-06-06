// Intake run-pass tests (SPEC-0041 INTAKE-3/7/8/9/10/12). Real FS + real git against a throwaway
// vault (TEST-18), like ingest.test.ts. Skips if git is absent. Exercises the load-bearing posture:
// dedup idempotency (never re-archive), origin:'external' primary sources, connector-default
// classification recorded, and failure≠empty (a fetch error is a DISTINCT audited event).
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { createKb } from './vault';
import { readCapturedMeta } from './ingest';
import { readEvents } from './activityIndex';
import { runIntakeConnector } from './intakeRun';
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

const item = (id: string, body = `body ${id}`): IntakeItem => ({ externalId: id, title: `Title ${id}`, link: `https://x/${id}`, contentMd: body });

/** A fetch fn that returns a fixed list (the IO seam — INTAKE-7: read-only, no mutation hook). */
const fetchOf = (items: IntakeItem[]): IntakeFetchFn => async () => items;

async function inboxUnits(vault: string): Promise<string[]> {
  try {
    return (await fs.readdir(path.join(vault, 'inbox'))).filter((n) => !n.startsWith('.')).sort();
  } catch {
    return [];
  }
}
const T = () => '2025-06-03T12:00:00.000Z';

describe.skipIf(!gitAvailable)('runIntakeConnector (SPEC-0041)', () => {
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

  it('INTAKE-3/10: writes each new item as a PRIMARY source (origin:external, surface intake:<id>)', async () => {
    const res = await runIntakeConnector(vault, conn(), { fetch: fetchOf([item('a'), item('b')]), now: T });
    expect(res.sourceIds).toHaveLength(2);
    expect(res.failed).toBeUndefined();
    const units = await inboxUnits(vault);
    expect(units).toHaveLength(2);
    const meta = await readCapturedMeta(path.join(vault, 'inbox', units[0]));
    expect(meta.origin).toBe('external'); // PRIMARY, externally-authored (not 'secondary' like research)
    expect(meta.surface).toBe('intake:news');
  });

  it('INTAKE-8: a second pass over the SAME items archives nothing (idempotent dedup)', async () => {
    await runIntakeConnector(vault, conn(), { fetch: fetchOf([item('a'), item('b')]), now: T });
    const before = await inboxUnits(vault);
    const res2 = await runIntakeConnector(vault, conn(), { fetch: fetchOf([item('a'), item('b')]), now: T });
    expect(res2.sourceIds).toEqual([]);
    expect(res2.note).toMatch(/no new items/);
    expect(await inboxUnits(vault)).toEqual(before); // NOT re-archived
    const events = await readEvents(vault, { actors: ['intake'] });
    expect(events[0].eventType).toBe('no-new-items');
  });

  it('INTAKE-8: only genuinely-new items are ingested on a later pass', async () => {
    await runIntakeConnector(vault, conn(), { fetch: fetchOf([item('a')]), now: T });
    const res2 = await runIntakeConnector(vault, conn(), { fetch: fetchOf([item('a'), item('b')]), now: T });
    expect(res2.sourceIds).toHaveLength(1); // only 'b' is new
    expect(await inboxUnits(vault)).toHaveLength(2);
  });

  it('INTAKE-8: content-hash fallback dedups items with no external id', async () => {
    const noId = (): IntakeItem => ({ externalId: '', title: 'Same', link: 'https://x/same', contentMd: 'identical body' });
    await runIntakeConnector(vault, conn(), { fetch: fetchOf([noId()]), now: T });
    const res2 = await runIntakeConnector(vault, conn(), { fetch: fetchOf([noId()]), now: T });
    expect(res2.sourceIds).toEqual([]); // identical content → same hash key → deduped
  });

  it('INTAKE-12: a fetch failure is a DISTINCT audited event, not a silent empty', async () => {
    const boom: IntakeFetchFn = async () => {
      throw new Error('feed unreachable');
    };
    const res = await runIntakeConnector(vault, conn(), { fetch: boom, now: T });
    expect(res.failed).toBe(true);
    expect(res.error).toMatch(/unreachable/);
    expect(res.sourceIds).toEqual([]);
    expect(await inboxUnits(vault)).toEqual([]); // nothing archived
    const events = await readEvents(vault, { actors: ['intake'] });
    expect(events[0].eventType).toBe('intake-failed');
    expect(events[0].payload.error).toMatch(/unreachable/);
  });

  it('INTAKE-12: a failed pass leaves a prior pass’s archived items preserved', async () => {
    await runIntakeConnector(vault, conn(), { fetch: fetchOf([item('a')]), now: T });
    const before = await inboxUnits(vault);
    await runIntakeConnector(vault, conn(), { fetch: async () => { throw new Error('down'); }, now: T });
    expect(await inboxUnits(vault)).toEqual(before); // earlier primary source untouched
  });

  it('INTAKE-9: the connector-default scope + sensitivity are recorded on the intook event', async () => {
    await runIntakeConnector(vault, conn({ scope: 'work', sensitivity: 'confidential' }), { fetch: fetchOf([item('a')]), now: T });
    const events = await readEvents(vault, { actors: ['intake'] });
    const intook = events.find((e) => e.eventType === 'intook');
    expect(intook?.payload).toMatchObject({ scope: 'work', sensitivity: 'confidential', count: 1 });
  });

  it('refuses an unsafe connector id before touching any path', async () => {
    await expect(runIntakeConnector(vault, conn({ id: '../escape' }), { fetch: fetchOf([item('a')]), now: T })).rejects.toThrow(/unsafe connector id/);
  });
});
