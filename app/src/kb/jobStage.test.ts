// Job runtime integration (SPEC-0023 JOBS). Real FS + git + worktrees against a throwaway temp
// vault (TEST-18); behaviors are injected (pure cognition, no copilot). Exercises the harness:
// bounded pass → disposition routing → per-job journal on `staging` (never `main`) → promotion of
// evergreen findings → single-flight.
import { describe, it, expect } from 'vitest';
import { promises as fs } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import simpleGit from 'simple-git';
import { makeTempDir, rmTempDir, pathExists } from '../../test/tempVault';
import { createKb } from './vault';
import { Mutex } from './stageLock';
import { ensureStagingWorktree } from './stagingWorktree';
import { promote } from './staging';
import { runJobOnce, JobRunner, readJournal } from './jobStage';
import { exampleJobBehavior, EXAMPLE_CENSUS_REL, EXAMPLE_JOB_TYPE } from './exampleJob';
import type { JobConfig, JobBehavior } from './jobs';

function gitInstalledSync(): boolean {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}
const gitAvailable = gitInstalledSync();

const exampleJob: JobConfig = { id: 'example', type: EXAMPLE_JOB_TYPE, schedule: 'daily', enabled: true, posture: 'guarded' };

/** Commit files onto `staging` via the staging worktree (which is checked out on `staging`). */
async function commitOnStaging(stagingWt: string, files: Record<string, string>): Promise<void> {
  for (const [rel, content] of Object.entries(files)) {
    const dest = path.join(stagingWt, rel);
    await fs.mkdir(path.dirname(dest), { recursive: true });
    await fs.writeFile(dest, content, 'utf8');
  }
  const git = simpleGit(stagingWt);
  await git.add('-A');
  await git.commit('seed on staging');
}

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

describe.skipIf(!gitAvailable)('runJobOnce — bounded pass, journal, promotion (SPEC-0023)', () => {
  it('runs the example job: census applied on staging, promoted to main; journal stays on staging only', async () => {
    await withVault(async (root, stagingWt, lock) => {
      // Seed one entity on staging so the census has something to count.
      await commitOnStaging(stagingWt, { 'entities/person/steve.md': '---\nid: 01E\nname: Steve\n---\n# Steve\n' });

      const res = await runJobOnce(stagingWt, exampleJob, exampleJobBehavior, lock);
      expect(res.outcome).toBe('advanced');
      expect(res.applied).toBe(1); // census changed n/a → 1
      expect(res.deferred).toBe(0);

      // Journal written on staging (JOBS-7), audit-rich (applied count + cursor).
      const journal = await readJournal(stagingWt, 'example');
      expect(journal).toHaveLength(1);
      expect(journal[0].applied).toBe(1);
      expect(journal[0].cursor?.entityCount).toBe(1);
      // Census artifact on staging.
      expect(await pathExists(path.join(stagingWt, EXAMPLE_CENSUS_REL))).toBe(true);

      // Promote: the evergreen census reaches main (JOBS-12); the journal NEVER does (JOBS-7).
      await promote(root);
      expect(await pathExists(path.join(root, EXAMPLE_CENSUS_REL))).toBe(true);
      expect(await pathExists(path.join(root, '.kb', 'jobs', 'example', 'journal.jsonl'))).toBe(false);
      expect((await simpleGit(root).status()).isClean()).toBe(true);
    });
  });

  it('a no-find run still journals (continuity); a re-run with unchanged census applies nothing', async () => {
    await withVault(async (root, stagingWt, lock) => {
      await commitOnStaging(stagingWt, { 'entities/person/steve.md': '---\nid: 01E\nname: Steve\n---\n# Steve\n' });
      await runJobOnce(stagingWt, exampleJob, exampleJobBehavior, lock); // census n/a → 1 (applied)
      const res2 = await runJobOnce(stagingWt, exampleJob, exampleJobBehavior, lock); // unchanged → no-op
      expect(res2.applied).toBe(0);
      const journal = await readJournal(stagingWt, 'example');
      expect(journal).toHaveLength(2); // both runs recorded (JOBS-7/8), even the no-find one
      expect(journal[1].applied).toBe(0);
    });
  });

  it('disposition routing (JOBS-9): guarded sends destructive → Review (no effect), additive → auto', async () => {
    await withVault(async (root, stagingWt, lock) => {
      const behavior: JobBehavior = async () => ({
        inspected: 'two findings',
        findings: [
          { summary: 'retire stale node', kind: 'destructive', confidence: 0.95, proposed: 'auto', review: { question: 'Retire X?' } },
          { summary: 'add census', kind: 'additive', confidence: 1, proposed: 'auto', writes: [{ rel: 'outputs/example/note.md', content: 'hi\n' }] },
        ],
      });
      const job: JobConfig = { id: 'mixed', type: 'mixed', schedule: 'daily', enabled: true, posture: 'guarded' };
      const res = await runJobOnce(stagingWt, job, behavior, lock);
      expect(res.applied).toBe(1); // the additive
      expect(res.deferred).toBe(1); // the destructive → Review
      // additive auto-applied on staging…
      expect(await pathExists(path.join(stagingWt, 'outputs/example/note.md'))).toBe(true);
      // …destructive raised a Review (SPEC-0018), applied no effect.
      expect(await pathExists(path.join(stagingWt, 'reviews'))).toBe(true);
      const journal = await readJournal(stagingWt, 'mixed');
      const deferred = journal[0].findings?.find((f) => f.disposition === 'review');
      expect(deferred?.reviewId).toBeTruthy();
    });
  });
});

describe.skipIf(!gitAvailable)('JobRunner — single-flight (JOBS-6/11)', () => {
  it('a runNow while a run is in flight is skipped, not stacked', async () => {
    await withVault(async (root, stagingWt, lock) => {
      let release: () => void = () => {};
      const gate = new Promise<void>((r) => (release = r));
      let runs = 0;
      const slow: JobBehavior = async () => {
        runs += 1;
        await gate; // hold the run open
        return { inspected: 'slow', findings: [] };
      };
      const job: JobConfig = { id: 'slow', type: 'slow', schedule: 'daily', enabled: true, posture: 'guarded' };
      const runner = new JobRunner(stagingWt, job, slow, lock);
      const first = runner.runNow(); // starts, parks on the gate
      await Promise.resolve();
      const second = await runner.runNow(); // in flight → skipped
      expect(second).toBe('skipped');
      release();
      await first;
      expect(runs).toBe(1); // the second never started
    });
  });
});
