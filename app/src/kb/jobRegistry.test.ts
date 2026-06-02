// Job registry read/write/validate/patch (SPEC-0023 JOBS-1/2/14/15). Real FS, no git.
import { describe, it, expect } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { makeTempDir, rmTempDir } from '../../test/tempVault';
import { readJobRegistry, writeJobRegistry, upsertJob, patchJob, jobRegistryPath } from './jobRegistry';
import type { JobConfig } from './jobs';

async function withTempRoot(fn: (root: string) => Promise<void>): Promise<void> {
  const dir = await makeTempDir();
  try {
    await fn(path.join(dir, 'vault'));
  } finally {
    await rmTempDir(dir);
  }
}

const job = (over: Partial<JobConfig> = {}): JobConfig => ({
  id: 'reflect',
  type: 'reflect',
  schedule: 'daily',
  enabled: true,
  posture: 'guarded',
  ...over,
});

describe('jobRegistry (JOBS-1)', () => {
  it('round-trips jobs under .kb/jobs/registry.json', async () => {
    await withTempRoot(async (root) => {
      await writeJobRegistry(root, [job()]);
      expect(jobRegistryPath(root)).toContain(path.join('.kb', 'jobs', 'registry.json'));
      expect(await readJobRegistry(root)).toEqual([job()]);
    });
  });

  it('missing file → empty registry (no jobs)', async () => {
    await withTempRoot(async (root) => {
      expect(await readJobRegistry(root)).toEqual([]);
    });
  });

  it('skips malformed rows and falls back unknown schedule/posture to safe defaults', async () => {
    await withTempRoot(async (root) => {
      const p = jobRegistryPath(root);
      await fs.mkdir(path.dirname(p), { recursive: true });
      await fs.writeFile(
        p,
        JSON.stringify([
          { id: 'ok', type: 't', schedule: 'weird', enabled: 'yes', posture: 'reckless' }, // coerced
          { type: 'no-id' }, // dropped (no id)
          'garbage', // dropped
        ]),
        'utf8',
      );
      const jobs = await readJobRegistry(root);
      expect(jobs).toHaveLength(1);
      expect(jobs[0]).toMatchObject({ id: 'ok', schedule: 'off', enabled: false, posture: 'guarded' });
    });
  });

  it('upsertJob inserts then replaces by id (JOBS-14)', async () => {
    await withTempRoot(async (root) => {
      await upsertJob(root, job());
      await upsertJob(root, job({ schedule: 'hourly' }));
      const jobs = await readJobRegistry(root);
      expect(jobs).toHaveLength(1);
      expect(jobs[0].schedule).toBe('hourly');
    });
  });

  it('patchJob edits enable/schedule/posture in place (JOBS-14/15)', async () => {
    await withTempRoot(async (root) => {
      await writeJobRegistry(root, [job({ enabled: true, schedule: 'daily', posture: 'guarded' })]);
      await patchJob(root, 'reflect', { enabled: false, schedule: 'off', posture: 'autonomous' });
      expect(await readJobRegistry(root)).toEqual([job({ enabled: false, schedule: 'off', posture: 'autonomous' })]);
    });
  });
});
