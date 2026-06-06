// Intake connector registry tests (SPEC-0041 INTAKE-4). Plain FS against a temp dir — no git.
// Asserts round-trip, conservative defaults, unknown-type drop, and the #29 path-injection guard
// (an unsafe id is dropped on read + rejected on write/patch) shared with jobs/researchers.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { makeTempDir, rmTempDir } from '../../test/tempVault';
import {
  readIntakeRegistry,
  upsertIntakeConnector,
  patchIntakeConnector,
  intakeRegistryPath,
} from './intakeRegistry';
import type { IntakeConnectorConfig } from './intakeConnectors';

const rss = (over: Partial<IntakeConnectorConfig> = {}): IntakeConnectorConfig => ({
  id: 'news', type: 'rss', schedule: 'hourly', enabled: true, scope: 'global', sensitivity: 'internal',
  config: { feedUrl: 'https://example.com/feed.xml' }, ...over,
});

describe('intakeRegistry (INTAKE-4)', () => {
  let root: string;
  beforeEach(async () => {
    root = await makeTempDir();
  });
  afterEach(async () => {
    await rmTempDir(root);
  });

  it('round-trips a connector', async () => {
    await upsertIntakeConnector(root, rss());
    const got = await readIntakeRegistry(root);
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({ id: 'news', type: 'rss', schedule: 'hourly', enabled: true });
  });

  it('applies conservative defaults + drops unknown type / malformed rows', async () => {
    const p = intakeRegistryPath(root);
    await fs.mkdir(path.dirname(p), { recursive: true });
    await fs.writeFile(
      p,
      JSON.stringify([
        { id: 'ok', type: 'rss' }, // missing scope/sensitivity/schedule → defaults
        { id: 'bad-type', type: 'imap' }, // unknown type → dropped
        { id: 'no-type' }, // missing type → dropped
        'not-an-object',
      ]),
      'utf8',
    );
    const got = await readIntakeRegistry(root);
    expect(got.map((c) => c.id)).toEqual(['ok']);
    expect(got[0]).toMatchObject({ scope: 'global', sensitivity: 'internal', schedule: 'off', enabled: false });
  });

  it('drops an unsafe id on read (path-injection guard, #29)', async () => {
    const p = intakeRegistryPath(root);
    await fs.mkdir(path.dirname(p), { recursive: true });
    await fs.writeFile(p, JSON.stringify([{ id: '../escape', type: 'rss' }, rss()]), 'utf8');
    const got = await readIntakeRegistry(root);
    expect(got.map((c) => c.id)).toEqual(['news']); // traversal id dropped, valid row kept
  });

  it('rejects an unsafe id on upsert + patch (never persists a traversal id)', async () => {
    await expect(upsertIntakeConnector(root, rss({ id: '../x' }))).rejects.toThrow(/unsafe id/);
    await expect(patchIntakeConnector(root, '../x', { enabled: false })).rejects.toThrow(/unsafe id/);
  });

  it('patches mutable fields; no-op for an absent id', async () => {
    await upsertIntakeConnector(root, rss());
    await patchIntakeConnector(root, 'news', { enabled: false, schedule: 'daily', sensitivity: 'confidential' });
    const got = await readIntakeRegistry(root);
    expect(got[0]).toMatchObject({ enabled: false, schedule: 'daily', sensitivity: 'confidential' });
    await patchIntakeConnector(root, 'ghost', { enabled: true }); // absent → no throw, no change
    expect((await readIntakeRegistry(root))).toHaveLength(1);
  });

  it('missing registry file → empty', async () => {
    expect(await readIntakeRegistry(root)).toEqual([]);
  });
});
