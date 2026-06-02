// Integration: Full Replay (SPEC-0022 REPLAY) on the evergreen staging pipeline. Proves the
// destructive-but-safe contract: derived knowledge is purged + epoch-reset on `staging`, every
// Source (and the inbox) survives, `main` is republished clean, and the pipeline re-derives.
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import simpleGit from 'simple-git';
import { makeTempDir, rmTempDir, pathExists } from '../../test/tempVault';
import { createKb } from './vault';
import { Orchestrator } from './orchestrator';
import { deterministicDecider } from './archivist';
import { Mutex } from './stageLock';
import { ensureStagingWorktree } from './stagingWorktree';
import { promote } from './staging';
import { decomposeOne, findSourceDirs, readDecomposeQueue } from './decomposeStage';
import { findEntityFiles } from './claimsStage';
import { runFullReplay } from './replay';
import { REPLAY_RESET_EVENT } from './replayEpoch';
import type { DecomposeDecider } from './decomposeAgent';

function gitInstalledSync(): boolean {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}
const gitAvailable = gitInstalledSync();

const decompDecider: DecomposeDecider = async (i) => ({
  sourceId: i.sourceId,
  entities: [{ kind: 'person', name: 'Steve', confidence: 0.8, mentions: ['Steve'] }],
  agent: { via: 'copilot', model: 'test' },
});

/** Drive a fresh vault to: one archived source on main+staging, decomposed into one entity on staging. */
async function seedDecomposed(root: string): Promise<string> {
  await createKb({ path: root, initGitIfNeeded: true });
  const stagingWt = await ensureStagingWorktree(root);
  const lock = new Mutex();
  const orch = new Orchestrator(stagingWt, deterministicDecider, lock, async () => {
    await promote(root);
  });
  await orch.capture('test', [{ kind: 'text', text: 'evergreen ground truth about Steve' }]);
  await orch.poke();
  const srcRel = (await readDecomposeQueue(stagingWt))[0];
  await decomposeOne(stagingWt, srcRel, decompDecider);
  return stagingWt;
}

describe.skipIf(!gitAvailable)('Full Replay — purge + epoch reset on staging, republish main (SPEC-0022)', () => {
  it('purges derived entities, preserves the Source, epoch-resets it, and re-queues for decompose', async () => {
    const dir = await makeTempDir();
    try {
      const root = path.join(dir, 'vault');
      const stagingWt = await seedDecomposed(root);
      const lock = new Mutex();

      // Precondition: one source + one entity on staging; source queue is now empty (decomposed).
      const srcDirs = await findSourceDirs(stagingWt);
      expect(srcDirs.length).toBe(1);
      expect((await findEntityFiles(stagingWt)).length).toBe(1);
      expect((await readDecomposeQueue(stagingWt)).length).toBe(0); // terminal: decomposed

      const sourceDir = srcDirs[0];
      const auditBefore = await fs.readFile(path.join(sourceDir, 'audit.jsonl'), 'utf8');
      const rawBefore = await fs.readFile(path.join(sourceDir, 'source.md'), 'utf8');

      const counts = await runFullReplay(root, stagingWt, lock, { replayId: 'TESTEPOCH1' });

      // REPLAY-4: derived entities purged on staging (but the scaffold dir + .gitkeep survive).
      expect((await findEntityFiles(stagingWt)).length).toBe(0);
      expect(await pathExists(path.join(stagingWt, 'entities', '.gitkeep'))).toBe(true);
      // REPLAY-3: the Source is untouched — source.md identical, audit only GREW (append-only).
      expect(await fs.readFile(path.join(sourceDir, 'source.md'), 'utf8')).toBe(rawBefore);
      const auditAfter = await fs.readFile(path.join(sourceDir, 'audit.jsonl'), 'utf8');
      expect(auditAfter.startsWith(auditBefore)).toBe(true);
      expect(auditAfter).toContain(REPLAY_RESET_EVENT);
      // REPLAY-5/6: the source re-enters the decompose queue despite its old `decomposed` marker.
      expect((await readDecomposeQueue(stagingWt)).map((r) => path.basename(r))).toEqual([
        path.basename(sourceDir),
      ]);
      // REPLAY-11: the replay action was recorded with counts.
      expect(counts).toEqual({ replayId: 'TESTEPOCH1', sourcesReset: 1, purgedTrees: expect.arrayContaining(['entities']) });
      const replayAudit = await fs.readFile(path.join(stagingWt, 'replay', 'audit.jsonl'), 'utf8');
      expect(replayAudit).toContain('"replayId":"TESTEPOCH1"');
      // REPLAY-8: main is evergreen + clean (the gate republished; entities never on main anyway).
      expect((await simpleGit(root).status()).isClean()).toBe(true);
      expect((await findSourceDirs(root)).length).toBe(1); // source preserved on main
      // staging committed cleanly (REPLAY-8/13: never half-purged/dirty).
      expect((await simpleGit(stagingWt).status()).isClean()).toBe(true);
    } finally {
      await rmTempDir(dir);
    }
  });

  it('re-derives after replay: decomposing the re-queued source yields a fresh entity (REPLAY-9)', async () => {
    const dir = await makeTempDir();
    try {
      const root = path.join(dir, 'vault');
      const stagingWt = await seedDecomposed(root);
      const lock = new Mutex();
      await runFullReplay(root, stagingWt, lock, { replayId: 'TESTEPOCH2' });

      const srcRel = (await readDecomposeQueue(stagingWt))[0];
      expect(srcRel).toBeTruthy();
      await decomposeOne(stagingWt, srcRel, decompDecider); // the auto-resume sweep would do exactly this
      expect((await findEntityFiles(stagingWt)).length).toBe(1); // rebuilt from the preserved Source
      expect((await readDecomposeQueue(stagingWt)).length).toBe(0); // terminal again under the new epoch
      expect((await simpleGit(stagingWt).status()).isClean()).toBe(true);
    } finally {
      await rmTempDir(dir);
    }
  });

  it('preserves the inbox across replay (REPLAY-7)', async () => {
    const dir = await makeTempDir();
    try {
      const root = path.join(dir, 'vault');
      const stagingWt = await seedDecomposed(root);
      const lock = new Mutex();
      // Simulate an un-archived capture sitting in the inbox (committed on staging).
      const inboxUnit = path.join(stagingWt, 'inbox', 'pending-unit');
      await fs.mkdir(inboxUnit, { recursive: true });
      await fs.writeFile(path.join(inboxUnit, 'raw.md'), 'not yet archived');
      const g = simpleGit(stagingWt);
      await g.raw('add', '-A');
      await g.commit('test: leave an item in the inbox');

      await runFullReplay(root, stagingWt, lock, { replayId: 'TESTEPOCH3' });

      expect(await pathExists(path.join(inboxUnit, 'raw.md'))).toBe(true); // inbox untouched
      expect(await fs.readFile(path.join(inboxUnit, 'raw.md'), 'utf8')).toBe('not yet archived');
    } finally {
      await rmTempDir(dir);
    }
  });

  it('is a safe no-op on an empty KB (no Sources to purge; STAGING-4 idempotent promotion)', async () => {
    const dir = await makeTempDir();
    try {
      const root = path.join(dir, 'vault');
      await createKb({ path: root, initGitIfNeeded: true });
      const stagingWt = await ensureStagingWorktree(root);
      const lock = new Mutex();

      const counts = await runFullReplay(root, stagingWt, lock, { replayId: 'TESTEPOCH4' });
      expect(counts.sourcesReset).toBe(0);
      expect((await simpleGit(root).status()).isClean()).toBe(true);
      expect((await simpleGit(stagingWt).status()).isClean()).toBe(true);
    } finally {
      await rmTempDir(dir);
    }
  });

  it('is restartable: a second replay re-resets cleanly and appends a new epoch (REPLAY-13)', async () => {
    const dir = await makeTempDir();
    try {
      const root = path.join(dir, 'vault');
      const stagingWt = await seedDecomposed(root);
      const lock = new Mutex();
      await runFullReplay(root, stagingWt, lock, { replayId: 'EPOCH_A' });
      // Re-derive, then replay again — the second epoch supersedes the first.
      const srcRel = (await readDecomposeQueue(stagingWt))[0];
      await decomposeOne(stagingWt, srcRel, decompDecider);
      await runFullReplay(root, stagingWt, lock, { replayId: 'EPOCH_B' });

      const sourceDir = (await findSourceDirs(stagingWt))[0];
      const audit = await fs.readFile(path.join(sourceDir, 'audit.jsonl'), 'utf8');
      expect(audit).toContain('EPOCH_A');
      expect(audit).toContain('EPOCH_B');
      // Under the latest epoch the source is unprocessed again.
      expect((await readDecomposeQueue(stagingWt)).length).toBe(1);
      const replayAudit = await fs.readFile(path.join(stagingWt, 'replay', 'audit.jsonl'), 'utf8');
      expect(replayAudit.split('\n').filter((l) => l.trim()).length).toBe(2); // two recorded replays
      expect((await simpleGit(stagingWt).status()).isClean()).toBe(true);
    } finally {
      await rmTempDir(dir);
    }
  });
});
