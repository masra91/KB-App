// Job registry read/write/validate/patch (SPEC-0023 JOBS-1/2/14/15). Real FS, no git.
import { describe, it, expect } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { makeTempDir, rmTempDir } from '../../test/tempVault';
import { readJobRegistry, writeJobRegistry, upsertJob, patchJob, jobRegistryPath } from './jobRegistry';
import { isSafeJobId, type JobConfig } from './jobs';
import type { DevLog, Fields } from './devlog';

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

// #29 — job-id path-injection hardening. The job `id` is composed DIRECTLY into filesystem paths
// (journalRel `.kb/jobs/<id>/…`, the per-job worktree, the work branch), so an `id` with separators
// or `..` would escape `.kb/jobs` (same arbitrary-write class as JOBS-10's write-sink, via the
// registry.json-load vector the IPC layer can't cover). Defense-in-depth: reject at registry READ +
// WRITE here, and a final assert at the run sink (jobStage.test.ts). QA finder: KB-Quality-Driver-2.
const UNSAFE_IDS: { label: string; id: unknown }[] = [
  { label: 'separator (/)', id: 'a/b' },
  { label: 'parent traversal (..)', id: '..' },
  { label: 'embedded traversal (../x)', id: '../x' },
  { label: 'deep traversal', id: '../../../tmp/x' },
  { label: 'dotfile (.kb)', id: '.kb' },
  { label: 'leading dot', id: '.hidden' },
  { label: 'whitespace', id: 'a b' },
  { label: 'empty', id: '' },
  { label: 'backslash', id: 'a\\b' },
  { label: 'non-string', id: 123 },
];

/** A DevLog stub that records every emitted entry — to assert a rejected id is SURFACED, not silently dropped. */
function recordingDevLog(): { log: DevLog; entries: { level: string; event: string; fields?: Fields }[] } {
  const entries: { level: string; event: string; fields?: Fields }[] = [];
  const mk = (level: string): ((event: string, fields?: Fields) => void) => (event, fields) => entries.push({ level, event, fields });
  const log: DevLog = {
    debug: mk('debug'),
    info: mk('info'),
    warn: mk('warn'),
    error: mk('error'),
    child: () => log,
    flush: async () => {},
  };
  return { log, entries };
}

describe('jobRegistry — job-id path-injection guard (#29 / JOBS-10)', () => {
  it('isSafeJobId accepts bare slugs and rejects separators/traversal/dots/space/empty/non-string', () => {
    for (const ok of ['reflect', 'example', 'job-1', 'Job1', 'a', 'a1-b2']) expect(isSafeJobId(ok)).toBe(true);
    for (const { id } of UNSAFE_IDS) expect(isSafeJobId(id)).toBe(false);
    expect(isSafeJobId(undefined)).toBe(false);
    expect(isSafeJobId(null)).toBe(false);
    expect(isSafeJobId('-leading-hyphen')).toBe(false); // must start with a letter/digit
  });

  it('READ: a planted registry.json with an unsafe id is dropped (others load) + surfaced on devlog', async () => {
    await withTempRoot(async (root) => {
      const p = jobRegistryPath(root);
      await fs.mkdir(path.dirname(p), { recursive: true });
      await fs.writeFile(
        p,
        JSON.stringify([
          { id: 'reflect', type: 'reflect', schedule: 'daily', enabled: true, posture: 'guarded' }, // safe → loads
          { id: '../../../tmp/evil', type: 'reflect', schedule: 'daily', enabled: true, posture: 'guarded' }, // traversal → dropped
          { id: '.kb', type: 'reflect', schedule: 'off', enabled: false, posture: 'guarded' }, // dotfile → dropped
        ]),
        'utf8',
      );
      const { log, entries } = recordingDevLog();
      const jobs = await readJobRegistry(root, log);
      expect(jobs.map((j) => j.id)).toEqual(['reflect']); // only the safe job survives; others don't crash the read
      const rejected = entries.filter((e) => e.event === 'job-id-rejected');
      expect(rejected).toHaveLength(2); // NOT silently dropped — each surfaced
      expect(rejected.every((e) => e.level === 'warn')).toBe(true);
      expect(rejected.map((e) => e.fields?.jobId)).toEqual(['../../../tmp/evil', '.kb']);
    });
  });

  it('READ: default (noop) devlog never throws — a tampered registry still degrades gracefully', async () => {
    await withTempRoot(async (root) => {
      const p = jobRegistryPath(root);
      await fs.mkdir(path.dirname(p), { recursive: true });
      await fs.writeFile(p, JSON.stringify([{ id: '../x', type: 'reflect', schedule: 'off', enabled: false, posture: 'guarded' }]), 'utf8');
      await expect(readJobRegistry(root)).resolves.toEqual([]); // dropped, no devlog passed, no throw
    });
  });

  it('WRITE: upsertJob rejects every unsafe id and never persists', async () => {
    await withTempRoot(async (root) => {
      for (const { label, id } of UNSAFE_IDS) {
        await expect(upsertJob(root, job({ id: id as string, type: id as string })), label).rejects.toThrow(/unsafe id/);
      }
      // Nothing was written — the registry file never came into existence.
      await expect(fs.access(jobRegistryPath(root))).rejects.toThrow();
    });
  });

  it('WRITE: upsertJob refuses a NEW job whose id !== type (v1 one-instance-per-type)', async () => {
    await withTempRoot(async (root) => {
      await expect(upsertJob(root, job({ id: 'reflect', type: 'example' }))).rejects.toThrow(/id !== type/);
      // …but replacing an EXISTING (legitimately seeded) job is unaffected.
      await upsertJob(root, job({ id: 'reflect', type: 'reflect', schedule: 'off' }));
      await upsertJob(root, job({ id: 'reflect', type: 'reflect', schedule: 'hourly' }));
      expect((await readJobRegistry(root))[0].schedule).toBe('hourly');
    });
  });

  it('WRITE: patchJob rejects an unsafe id at the boundary', async () => {
    await withTempRoot(async (root) => {
      for (const { label, id } of UNSAFE_IDS.filter((u) => typeof u.id === 'string')) {
        await expect(patchJob(root, id as string, { enabled: false }), label).rejects.toThrow(/unsafe id/);
      }
    });
  });

  it('REGRESSION: legitimate catalog ids (reflect/example/job-1) round-trip unaffected', async () => {
    await withTempRoot(async (root) => {
      for (const id of ['reflect', 'example']) await upsertJob(root, job({ id, type: id }));
      const jobs = await readJobRegistry(root);
      expect(jobs.map((j) => j.id).sort()).toEqual(['example', 'reflect']);
      await patchJob(root, 'reflect', { posture: 'autonomous' });
      expect((await readJobRegistry(root)).find((j) => j.id === 'reflect')?.posture).toBe('autonomous');
    });
  });
});
