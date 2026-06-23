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
import { readCandidates, connectOne, readConnectQueue } from './connectStage';
import { runFullReplay } from './replay';
import { recordDisambiguationDirective, readDisambiguationDirectives, directiveForIdentity, recordConsolidationDirective, readConsolidationDirectives, consolidationDirectiveForPair } from './directives';
import { REPLAY_RESET_EVENT } from './replayEpoch';
import type { DecomposeDecider } from './decomposeAgent';
import type { ConnectDecider, CandidateSet } from './connectAgent';

/** Resolve every candidate in a block into one canonical node (mirrors connectStage.test.ts). */
const oneClusterDecider = (canonicalName: string): ConnectDecider => async (set: CandidateSet) => ({
  blockKey: set.blockKey,
  clusters: [{ canonicalName, memberCandidateIds: set.candidates.map((c) => c.id), confidence: 0.95 }],
  agent: { via: 'copilot', model: 'test' },
});

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

/** Drive a fresh vault to: one archived source on main+staging, decomposed into one candidate on
 *  staging (post-#28, Decompose emits candidates; entities stay empty until Connect resolves). */
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
  it('purges derived candidates, preserves the Source, epoch-resets it, and re-queues for decompose', async () => {
    const dir = await makeTempDir();
    try {
      const root = path.join(dir, 'vault');
      const stagingWt = await seedDecomposed(root);
      const lock = new Mutex();

      // Precondition: one source + one candidate on staging; source queue is now empty (decomposed).
      const srcDirs = await findSourceDirs(stagingWt);
      expect(srcDirs.length).toBe(1);
      expect((await readCandidates(stagingWt)).length).toBe(1); // Decompose emitted a candidate (#28)
      expect((await findEntityFiles(stagingWt)).length).toBe(0); // entities empty until Connect (CANON-4/10)
      expect((await readDecomposeQueue(stagingWt)).length).toBe(0); // terminal: decomposed

      const sourceDir = srcDirs[0];
      const auditBefore = await fs.readFile(path.join(sourceDir, 'audit.jsonl'), 'utf8');
      const rawBefore = await fs.readFile(path.join(sourceDir, 'source.md'), 'utf8');

      const counts = await runFullReplay(root, stagingWt, lock, { replayId: 'TESTEPOCH1' });

      // REPLAY-4: derived candidates purged on staging; the scaffold entities/ dir + .gitkeep survive.
      expect((await readCandidates(stagingWt)).length).toBe(0);
      expect(await pathExists(path.join(stagingWt, 'candidates'))).toBe(false); // working dir removed
      expect(await pathExists(path.join(stagingWt, 'entities', '.gitkeep'))).toBe(true); // scaffold kept
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
      expect(counts).toEqual({ replayId: 'TESTEPOCH1', sourcesReset: 1, purgedTrees: expect.arrayContaining(['candidates']) });
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

  it('re-derives after replay: decomposing the re-queued source yields a fresh candidate (REPLAY-9)', async () => {
    const dir = await makeTempDir();
    try {
      const root = path.join(dir, 'vault');
      const stagingWt = await seedDecomposed(root);
      const lock = new Mutex();
      await runFullReplay(root, stagingWt, lock, { replayId: 'TESTEPOCH2' });

      const srcRel = (await readDecomposeQueue(stagingWt))[0];
      expect(srcRel).toBeTruthy();
      await decomposeOne(stagingWt, srcRel, decompDecider); // the auto-resume sweep would do exactly this
      expect((await readCandidates(stagingWt)).length).toBe(1); // rebuilt from the preserved Source
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

  it('epoch-marks the stage-wide connect audit so resolved blocks re-derive (REPLAY-6)', async () => {
    const dir = await makeTempDir();
    try {
      const root = path.join(dir, 'vault');
      const stagingWt = await seedDecomposed(root);
      const lock = new Mutex();
      // Simulate Connect having run: a stage-wide connect/audit.jsonl with a resolved block.
      const connectAudit = path.join(stagingWt, 'connect', 'audit.jsonl');
      await fs.mkdir(path.dirname(connectAudit), { recursive: true });
      await fs.writeFile(connectAudit, JSON.stringify({ stage: 'connect', blockKey: 'person|steve', event: 'connected' }) + '\n');
      const g = simpleGit(stagingWt);
      await g.raw('add', '-A');
      await g.commit('test: seed a connect audit');

      await runFullReplay(root, stagingWt, lock, { replayId: 'TESTEPOCH_CONNECT' });

      const after = await fs.readFile(connectAudit, 'utf8');
      expect(after).toContain('connected'); // history preserved (append-only)
      expect(after).toContain(REPLAY_RESET_EVENT); // …with the epoch marker appended
      expect((await simpleGit(stagingWt).status()).isClean()).toBe(true);
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

  // ── REPLAY-14: the rebuild runs the unmodified production pipeline in capture (ULID) order ──

  it('re-queues every Source for the unmodified pipeline in chronological capture (ULID) order (REPLAY-14)', async () => {
    const dir = await makeTempDir();
    try {
      const root = path.join(dir, 'vault');
      await createKb({ path: root, initGitIfNeeded: true });
      const stagingWt = await ensureStagingWorktree(root);
      const lock = new Mutex();
      const orch = new Orchestrator(stagingWt, deterministicDecider, lock, async () => {
        await promote(root);
      });
      // Capture three Sources in sequence → three ULIDs in ascending capture-time order.
      await orch.capture('test', [{ kind: 'text', text: 'first about Ada' }]);
      await orch.capture('test', [{ kind: 'text', text: 'second about Ada' }]);
      await orch.capture('test', [{ kind: 'text', text: 'third about Ada' }]);
      await orch.poke();
      // Decompose all three (queue is capture-ordered); they leave the queue.
      for (const rel of await readDecomposeQueue(stagingWt)) await decomposeOne(stagingWt, rel, decompDecider);
      expect((await readDecomposeQueue(stagingWt)).length).toBe(0);

      await runFullReplay(root, stagingWt, lock, { replayId: 'EPOCH_ORDER' });

      // After replay the SAME production reader re-queues all three, sorted by ULID = capture order.
      const queued = (await readDecomposeQueue(stagingWt)).map((r) => path.basename(r));
      expect(queued.length).toBe(3);
      expect([...queued].sort()).toEqual(queued); // already ascending — no replay-specific reordering
    } finally {
      await rmTempDir(dir);
    }
  });

  it('clears resolved entities from `main` via deletion-aware promote, then re-derives (REPLAY-4/8/14)', async () => {
    const dir = await makeTempDir();
    try {
      const root = path.join(dir, 'vault');
      const stagingWt = await seedDecomposed(root); // archived source + one candidate on staging
      const lock = new Mutex();

      // Run the real Connect stage so an entity is resolved on staging, then promote it to main
      // (entities is evergreen post-#30: EVERGREEN_PATHS=['sources','entities','claims']).
      const block = (await readConnectQueue(stagingWt))[0];
      await connectOne(stagingWt, block.blockKey, oneClusterDecider('Ada'));
      await promote(root);
      expect((await findEntityFiles(stagingWt)).length).toBe(1); // resolved on staging
      expect((await findEntityFiles(root)).length).toBe(1); // …and published to main

      await runFullReplay(root, stagingWt, lock, { replayId: 'EPOCH_MAIN' });

      // REPLAY-4/8: entities purged on staging AND cleared from main (deletion-aware promote, #29/#30).
      expect((await findEntityFiles(stagingWt)).length).toBe(0);
      expect((await findEntityFiles(root)).length).toBe(0);
      expect((await simpleGit(root).status()).isClean()).toBe(true);
      // Sources survive on main (REPLAY-3); the block re-derives through the unmodified pipeline.
      expect((await findSourceDirs(root)).length).toBe(1);
      expect((await readDecomposeQueue(stagingWt)).length).toBe(1); // re-queued from the start (REPLAY-14)
    } finally {
      await rmTempDir(dir);
    }
  });
});

// SPEC-0049 HEAL-9 — a reset must not carry the GRAVEYARD forward. Set-aside/park markers are already
// voided by the replay epoch (REPLAY-6, covered above); this pins the non-epoch-scoped half — the
// vault-root error + telemetry state (perf spans + the dev-log error trail) that REPLAY did NOT clear,
// so a clean & rebuild starts with a clean Status surface (no stale "recent errors" / pre-reset perf).
describe.skipIf(!gitAvailable)('Full Replay — HEAL-9 reset hygiene (SPEC-0049): clears the error + telemetry graveyard', () => {
  it('clears vault-root spans (+ rotations) and the dev-log on reset — the graveyard is not carried forward', async () => {
    const dir = await makeTempDir();
    try {
      const root = path.join(dir, 'vault');
      await createKb({ path: root, initGitIfNeeded: true });
      const stagingWt = await ensureStagingWorktree(root);

      // Seed the graveyard at the VAULT ROOT (where the tracer + dev-log are rooted): perf spans +
      // a rotation + a dev-log error trail — gitignored working-zone state a reset must scrub.
      const cache = path.join(root, '.kb', 'cache');
      await fs.mkdir(path.join(cache, 'logs'), { recursive: true });
      await fs.writeFile(path.join(cache, 'spans.jsonl'), '{"span":"stale-perf"}\n');
      await fs.writeFile(path.join(cache, 'spans.jsonl.1'), '{"span":"older-perf"}\n');
      await fs.writeFile(path.join(cache, 'logs', 'pipeline.log'), '{"level":"error","event":"decompose.failed"}\n');

      await runFullReplay(root, stagingWt, new Mutex());

      // HEAL-9 (fails-before/passes-after): pre-fix REPLAY left these, surfacing a stale graveyard.
      expect(await pathExists(path.join(cache, 'spans.jsonl'))).toBe(false);
      expect(await pathExists(path.join(cache, 'spans.jsonl.1'))).toBe(false); // rotations too
      expect(await pathExists(path.join(cache, 'logs'))).toBe(false); // dev-log error trail gone
    } finally {
      await rmTempDir(dir);
    }
  });
});

describe.skipIf(!gitAvailable)('Full Replay — SPEC-0050 directives survive reset/replay (DIR-4)', () => {
  it('keeps a disambiguation directive on staging AND republished on main across a Full Replay', async () => {
    const dir = await makeTempDir();
    try {
      const root = path.join(dir, 'vault');
      await createKb({ path: root, initGitIfNeeded: true });
      const stagingWt = await ensureStagingWorktree(root);

      // A settled directive (as the review-answer path would record it), committed on `staging`.
      await recordDisambiguationDirective(stagingWt, {
        identityKey: 'organization|disney',
        verdict: 'same',
        reviewId: 'rev-disney',
        decidedAt: '2026-06-14T00:00:00Z',
        entities: ['01OLD_A', '01OLD_B'],
      });
      const sg = simpleGit(stagingWt);
      await sg.raw('add', '-A');
      await sg.commit('seed: durable disambiguation directive');

      // Full Replay purges derived knowledge — directives/ is NOT in PURGE_DIRS, so it must survive…
      await runFullReplay(root, stagingWt, new Mutex());

      // …on staging (the durable memory the rebuild consults)…
      const onStaging = await readDisambiguationDirectives(stagingWt);
      expect(directiveForIdentity(onStaging, 'organization|disney')?.verdict).toBe('same');
      // …and republished to `main` (directives/ is evergreen → promoted), so it is the published truth.
      const onMain = await readDisambiguationDirectives(root);
      expect(directiveForIdentity(onMain, 'organization|disney')?.verdict).toBe('same');
    } finally {
      await rmTempDir(dir);
    }
  });

  it('keeps a consolidation (merge/distinct) directive on staging AND republished on main across a Full Replay', async () => {
    const dir = await makeTempDir();
    try {
      const root = path.join(dir, 'vault');
      await createKb({ path: root, initGitIfNeeded: true });
      const stagingWt = await ensureStagingWorktree(root);

      // A settled cross-entity consolidation verdict (as answerReview records it), committed on `staging`.
      await recordConsolidationDirective(stagingWt, {
        identityA: 'organization|walt disney company',
        identityB: 'organization|disney',
        verdict: 'distinct',
        reviewId: 'rev-consolidation',
        decidedAt: '2026-06-14T00:00:00Z',
      });
      const sg = simpleGit(stagingWt);
      await sg.raw('add', '-A');
      await sg.commit('seed: durable consolidation directive');

      await runFullReplay(root, stagingWt, new Mutex());

      // Survives on staging (the rebuild consults it) AND republished to main (evergreen → promoted).
      const onStaging = await readConsolidationDirectives(stagingWt);
      expect(consolidationDirectiveForPair(onStaging, 'organization|disney', 'organization|walt disney company')?.verdict).toBe('distinct');
      const onMain = await readConsolidationDirectives(root);
      expect(consolidationDirectiveForPair(onMain, 'organization|disney', 'organization|walt disney company')?.verdict).toBe('distinct');
    } finally {
      await rmTempDir(dir);
    }
  });
});
