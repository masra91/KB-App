// Reflect job behavior (SPEC-0024): bounded working-set selection + finding→disposition mapping,
// plus one e2e through the JOBS engine. Working-set unit tests need no git (just entity files);
// the e2e uses real git + the runtime.
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
import { runJobOnce, readJournal } from './jobStage';
import { makeReflectJobBehavior, REFLECT_WORKING_SET_SIZE, REFLECT_JOB_TYPE } from './reflectJob';
import type { ReflectContext, ReflectDecider, ReflectFinding } from './reflectAgent';
import type { JobConfig, JobPassContext, JournalEntry } from './jobs';

function gitInstalledSync(): boolean {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}
const gitAvailable = gitInstalledSync();

/** Write `n` entity nodes under root/entities/person (no git needed for the behavior unit tests). */
async function seedEntities(root: string, n: number): Promise<void> {
  for (let i = 0; i < n; i++) {
    const rel = path.join('entities', 'person', `e${String(i).padStart(3, '0')}.md`);
    const dest = path.join(root, rel);
    await fs.mkdir(path.dirname(dest), { recursive: true });
    await fs.writeFile(dest, `---\nid: 01E${i}\nkind: person\nname: E${i}\ntags: ["type/person"]\n---\n\n# E${i}\n\nbody ${i}\n`, 'utf8');
  }
}

const ctxWith = (root: string, journal: JournalEntry[] = []): JobPassContext => ({ root, posture: 'guarded', journal });

/** A decider that records the context it saw and returns configurable findings. */
function captureDecider(out: ReflectContext[], findings: ReflectFinding[] = []): ReflectDecider {
  return async (ctx) => {
    out.push(ctx);
    return { inspected: 'ran', findings };
  };
}

describe('makeReflectJobBehavior — bounded working-set selection (REFLECT-2)', () => {
  it('empty KB → a graceful no-op pass (REFLECT-6)', async () => {
    const dir = await makeTempDir();
    try {
      const root = path.join(dir, 'vault');
      await fs.mkdir(root, { recursive: true });
      const seen: ReflectContext[] = [];
      const res = await makeReflectJobBehavior(captureDecider(seen))(ctxWith(root));
      expect(res.findings).toEqual([]);
      expect(res.cursor).toEqual({ offset: 0, count: 0 });
      expect(res.inspected).toContain('empty KB');
    } finally {
      await rmTempDir(dir);
    }
  });

  it('feeds the decider a BOUNDED slice (≤ size) and advances the cursor', async () => {
    const dir = await makeTempDir();
    try {
      const root = path.join(dir, 'vault');
      await seedEntities(root, REFLECT_WORKING_SET_SIZE + 5); // 20 nodes
      const seen: ReflectContext[] = [];
      const res = await makeReflectJobBehavior(captureDecider(seen))(ctxWith(root));
      expect(seen[0].workingSet.length).toBe(REFLECT_WORKING_SET_SIZE); // never the whole KB
      expect(res.cursor).toEqual({ offset: REFLECT_WORKING_SET_SIZE, count: 20 });
    } finally {
      await rmTempDir(dir);
    }
  });

  it('round-robins coverage via the journal cursor (wraps the end)', async () => {
    const dir = await makeTempDir();
    try {
      const root = path.join(dir, 'vault');
      await seedEntities(root, 20);
      const seen: ReflectContext[] = [];
      const journal: JournalEntry[] = [{ ts: '2026-06-01T00:00:00Z', runId: 'r', inspected: 'prev', applied: 0, deferred: 0, cursor: { offset: 15, count: 20 } }];
      const res = await makeReflectJobBehavior(captureDecider(seen))(ctxWith(root, journal));
      expect(seen[0].workingSet.length).toBe(REFLECT_WORKING_SET_SIZE); // 5 from tail + 10 wrapped from head
      expect(res.cursor).toEqual({ offset: 10, count: 20 }); // (15 + 15) % 20
    } finally {
      await rmTempDir(dir);
    }
  });

  it('passes a churn hint when the KB grew since the last run (REFLECT-2)', async () => {
    const dir = await makeTempDir();
    try {
      const root = path.join(dir, 'vault');
      await seedEntities(root, 8);
      const seen: ReflectContext[] = [];
      const journal: JournalEntry[] = [{ ts: '2026-06-01T00:00:00Z', runId: 'r', inspected: 'prev', applied: 0, deferred: 0, cursor: { offset: 0, count: 3 } }];
      await makeReflectJobBehavior(captureDecider(seen))(ctxWith(root, journal));
      expect(seen[0].journalNotes.some((n) => n.includes('churn'))).toBe(true);
    } finally {
      await rmTempDir(dir);
    }
  });

  it('maps additive→auto and destructive→review proposals (REFLECT-4/5)', async () => {
    const dir = await makeTempDir();
    try {
      const root = path.join(dir, 'vault');
      await seedEntities(root, 2);
      const decider: ReflectDecider = async () => ({
        inspected: 'two findings',
        findings: [
          { summary: 'add claim', kind: 'additive', confidence: 0.9, writes: [{ rel: 'claims/x.md', content: 'c' }] },
          { summary: 'merge dupes', kind: 'destructive', confidence: 0.6, review: { question: 'Merge?' } },
        ],
      });
      const res = await makeReflectJobBehavior(decider)(ctxWith(root));
      expect(res.findings[0]).toMatchObject({ kind: 'additive', proposed: 'auto', writes: [{ rel: 'claims/x.md', content: 'c' }] });
      expect(res.findings[1]).toMatchObject({ kind: 'destructive', proposed: 'review', review: { question: 'Merge?' } });
    } finally {
      await rmTempDir(dir);
    }
  });
});

describe.skipIf(!gitAvailable)('Reflect job e2e through the JOBS engine (SPEC-0024 / SPEC-0023)', () => {
  it('runs a rumination pass: additive finding auto-applies + promotes; destructive → Review', async () => {
    const dir = await makeTempDir();
    try {
      const root = path.join(dir, 'vault');
      await createKb({ path: root, initGitIfNeeded: true });
      const stagingWt = await ensureStagingWorktree(root);
      const lock = new Mutex();
      // Seed an entity on staging so the working set is non-empty.
      await fs.mkdir(path.join(stagingWt, 'entities', 'person'), { recursive: true });
      await fs.writeFile(path.join(stagingWt, 'entities/person/steve.md'), '---\nid: 01E\nkind: person\nname: Steve\ntags: ["type/person"]\n---\n# Steve\n', 'utf8');
      await simpleGit(stagingWt).add('-A').then(() => simpleGit(stagingWt).commit('seed'));

      const decider: ReflectDecider = async () => ({
        inspected: 'rumination',
        findings: [
          { summary: 'emergent topic note', kind: 'additive', confidence: 1, writes: [{ rel: 'outputs/reflect/topics.md', content: '# Topics\n' }] },
          { summary: 'retire stale node', kind: 'destructive', confidence: 0.7, review: { question: 'Retire X?' } },
        ],
      });
      const job: JobConfig = { id: 'reflect', type: REFLECT_JOB_TYPE, schedule: 'several-daily', enabled: true, posture: 'guarded' };
      const res = await runJobOnce(stagingWt, job, makeReflectJobBehavior(decider), lock);
      expect(res.applied).toBe(1); // additive
      expect(res.deferred).toBe(1); // destructive → Review (guarded)

      await promote(root);
      expect(await pathExists(path.join(root, 'outputs/reflect/topics.md'))).toBe(true); // additive on main (REFLECT-7)
      expect(await pathExists(path.join(stagingWt, 'reviews'))).toBe(true); // destructive raised a Review
      const journal = await readJournal(stagingWt, 'reflect');
      expect(journal[0].cursor?.count).toBe(1); // working-set cursor journaled (REFLECT-8)
    } finally {
      await rmTempDir(dir);
    }
  });
});
