// Integration: the FULL evergreen pipeline through CONNECT (SPEC-0020 + SPEC-0021 slice 4).
// The working pipeline runs on the `staging` worktree; Decompose emits CANDIDATES on staging
// (STAGING-5), CONNECT resolves them into evergreen `entities/` on staging, and the promotion
// gate publishes the resolved entities → `main`. Proves the seam this mission wires up:
//   capture+archive → (promote sources) → decompose (candidates, staging-only) →
//   connect (entities, staging) → promote → entities now on `main`, working state never on main.
// Companion to stagingPipeline.test.ts (which stops at Decompose); this one lights up `main`'s
// graph via Connect. Deciders are injected so nothing shells out to copilot (TEST-2).
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
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
import { ConnectStage, readCandidates, readConnectQueue } from './connectStage';
import type { DecomposeDecider } from './decomposeAgent';
import type { ConnectDecider } from './connectAgent';

function gitInstalledSync(): boolean {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}
const gitAvailable = gitInstalledSync();

// Decompose finds one mention → one candidate (kind=person, name=Steve).
const decompDecider: DecomposeDecider = async (i) => ({
  sourceId: i.sourceId,
  entities: [{ kind: 'person', name: 'Steve', confidence: 0.8, mentions: ['Steve'] }],
  agent: { via: 'copilot', model: 'test' },
});

// Connect resolves every candidate in a block into ONE born-resolved node (no ambiguity here).
const connectDecider: ConnectDecider = async (set) => ({
  blockKey: set.blockKey,
  clusters: [{ canonicalName: 'Steve', memberCandidateIds: set.candidates.map((c) => c.id), confidence: 0.95 }],
  agent: { via: 'copilot', model: 'test' },
});

describe.skipIf(!gitAvailable)('connect pipeline — resolved entities promote to main (SPEC-0020 / STAGING slice 4)', () => {
  it('decompose→candidates→connect→entities, then promotion publishes entities to main; working state never on main', async () => {
    const dir = await makeTempDir();
    try {
      const root = path.join(dir, 'vault');
      await createKb({ path: root, initGitIfNeeded: true });
      const stagingWt = await ensureStagingWorktree(root);
      const lock = new Mutex(); // the one shared canonical-writer lock (§5)
      const orch = new Orchestrator(stagingWt, deterministicDecider, lock, async () => {
        await promote(root);
      });

      // Capture + archive on staging; the afterDrain promotes the source → main.
      await orch.capture('test', [{ kind: 'text', text: 'call Steve re: Q3 budget' }]);
      await orch.poke();
      expect((await findSourceDirs(root)).length).toBe(1); // source promoted to main
      const srcRel = (await readDecomposeQueue(stagingWt))[0]; // un-decomposed, repo-relative
      expect(srcRel).toBeTruthy();

      // Decompose on staging → a CANDIDATE lands on staging; NO entity yet (CANON-4/STAGING-5).
      await decomposeOne(stagingWt, srcRel, decompDecider);
      expect((await readCandidates(stagingWt)).length).toBe(1); // candidate on staging
      expect((await findEntityFiles(stagingWt)).length).toBe(0); // entities empty until Connect

      // Connect on staging resolves the candidate block into an evergreen entity node, and
      // consumes the candidate (CONNECT-3/7/8/17). Runs under the shared lock, like the pipeline.
      expect((await readConnectQueue(stagingWt)).length).toBe(1); // one block queued
      const connect = new ConnectStage(stagingWt, connectDecider, lock);
      await connect.poke();
      expect((await findEntityFiles(stagingWt)).length).toBe(1); // resolved entity on staging
      expect((await readCandidates(stagingWt)).length).toBe(0); // candidate consumed

      // Before promotion `main` has no entities; the entity lives only on staging.
      expect((await findEntityFiles(root)).length).toBe(0);

      // The promotion gate publishes the resolved entity → main (entities is now evergreen).
      const changed = await promote(root);
      expect(changed).toBe(true);
      expect((await findEntityFiles(root)).length).toBe(1); // main's graph lit up

      // Working state is NEVER on main, and main is clean (CANON-1/STAGING-6).
      expect((await readCandidates(root)).length).toBe(0);
      expect(await pathExists(path.join(root, 'candidates'))).toBe(false);
      expect((await simpleGit(root).status()).isClean()).toBe(true);

      // Idempotent: a second promotion with nothing new is a no-op (STAGING-4/8).
      expect(await promote(root)).toBe(false);
    } finally {
      await rmTempDir(dir);
    }
  });
});
