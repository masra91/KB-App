// Scheduler: due-detection, tick selection, run-now, single-flight (SPEC-0023 JOBS-2/6/11).
// Real FS + git (runs go through the runtime); behaviors injected via the resolver.
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { makeTempDir, rmTempDir } from '../../test/tempVault';
import { createKb } from './vault';
import { Mutex } from './stageLock';
import { ensureStagingWorktree } from './stagingWorktree';
import { writeJobRegistry } from './jobRegistry';
import { JobScheduler, isJobDue } from './jobScheduler';
import { readJournal } from './jobStage';
import { PRESET_INTERVAL_MS, type JobConfig, type JobBehavior } from './jobs';

function gitInstalledSync(): boolean {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}
const gitAvailable = gitInstalledSync();

const noop: JobBehavior = async () => ({ inspected: 'noop', findings: [] });

async function withVault(fn: (root: string, stagingWt: string, lock: Mutex) => Promise<void>): Promise<void> {
  const dir = await makeTempDir();
  try {
    const root = path.join(dir, 'vault');
    await createKb({ path: root, initGitIfNeeded: true });
    const stagingWt = await ensureStagingWorktree(root);
    await fn(root, stagingWt, new Mutex());
  } finally {
    await rmTempDir(dir);
  }
}

const job = (over: Partial<JobConfig> = {}): JobConfig => ({ id: 'j', type: 'noop', schedule: 'daily', enabled: true, posture: 'guarded', ...over });

describe.skipIf(!gitAvailable)('isJobDue (JOBS-2)', () => {
  it('never-run enabled job is due; disabled / off are not', async () => {
    await withVault(async (_root, stagingWt) => {
      expect(await isJobDue(stagingWt, job(), Date.now())).toBe(true);
      expect(await isJobDue(stagingWt, job({ enabled: false }), Date.now())).toBe(false);
      expect(await isJobDue(stagingWt, job({ schedule: 'off' }), Date.now())).toBe(false);
    });
  });
});

describe.skipIf(!gitAvailable)('JobScheduler.tick — selection + single-flight (JOBS-6)', () => {
  it('runs enabled+due jobs whose type resolves; skips disabled, off, and unknown types', async () => {
    await withVault(async (_root, stagingWt, lock) => {
      await writeJobRegistry(stagingWt, [
        job({ id: 'runs', type: 'noop' }),
        job({ id: 'disabled', type: 'noop', enabled: false }),
        job({ id: 'off', type: 'noop', schedule: 'off' }),
        job({ id: 'mystery', type: 'not-built' }), // unknown type → skipped, no error
      ]);
      const resolve = (type: string): JobBehavior | null => (type === 'noop' ? noop : null);
      const sched = new JobScheduler(stagingWt, resolve, lock);

      const fired = await sched.tick(Date.now());
      expect(fired).toEqual(['runs']); // only the enabled, due, resolvable job
      expect(await readJournal(stagingWt, 'runs')).toHaveLength(1); // it actually ran
      expect(await readJournal(stagingWt, 'disabled')).toHaveLength(0);
      expect(await readJournal(stagingWt, 'mystery')).toHaveLength(0);
    });
  });

  it('a second tick before the cadence elapses does not re-run a just-run job', async () => {
    await withVault(async (_root, stagingWt, lock) => {
      await writeJobRegistry(stagingWt, [job({ id: 'runs', type: 'noop', schedule: 'daily' })]);
      const sched = new JobScheduler(stagingWt, () => noop, lock);
      const now = Date.now();
      expect(await sched.tick(now)).toEqual(['runs']);
      // a tick a minute later: still within the daily cadence → not due.
      expect(await sched.tick(now + 60_000)).toEqual([]);
      // a tick past the daily interval → due again.
      expect(await sched.tick(now + PRESET_INTERVAL_MS.daily + 1000)).toEqual(['runs']);
      expect(await readJournal(stagingWt, 'runs')).toHaveLength(2);
    });
  });
});

describe.skipIf(!gitAvailable)('JobScheduler.runNow (JOBS-11)', () => {
  it('runs a job on demand; reports not-found / unknown-type', async () => {
    await withVault(async (_root, stagingWt, lock) => {
      await writeJobRegistry(stagingWt, [job({ id: 'j', type: 'noop' }), job({ id: 'x', type: 'not-built' })]);
      const sched = new JobScheduler(stagingWt, (t) => (t === 'noop' ? noop : null), lock);
      const res = await sched.runNow('j');
      expect(res).not.toBe('skipped');
      expect(typeof res === 'object' && res.outcome).toBe('advanced');
      expect(await sched.runNow('nope')).toBe('not-found');
      expect(await sched.runNow('x')).toBe('unknown-type');
    });
  });
});
