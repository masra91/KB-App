// Integration: the evergreen staging pipeline (SPEC-0021). The working pipeline runs on the
// `staging` worktree; the archivist's afterDrain promotes sources → main; Decompose's entities
// stay on `staging` only. Proves `main` = evergreen (sources), working state hidden on staging.
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

describe.skipIf(!gitAvailable)('staging pipeline — main is evergreen, working state on staging (SPEC-0021)', () => {
  it('capture+archive promote sources to main; entities (decompose) stay on staging only', async () => {
    const dir = await makeTempDir();
    try {
      const root = path.join(dir, 'vault');
      await createKb({ path: root, initGitIfNeeded: true });
      const stagingWt = await ensureStagingWorktree(root);
      const lock = new Mutex();
      const orch = new Orchestrator(stagingWt, deterministicDecider, lock, async () => {
        await promote(root);
      });

      // Capture runs on the staging worktree (orch.root === stagingWt); archive + promote follow.
      await orch.capture('test', [{ kind: 'text', text: 'evergreen ground truth' }]);
      await orch.poke();

      // main (vault root) received the source via promotion…
      expect((await findSourceDirs(root)).length).toBe(1);
      // …never the working inbox (it lived on staging, then was moved into sources there)…
      expect(await pathExists(path.join(root, 'inbox'))).toBe(false);
      // …and main is clean (ORCH-3 / CANON-1).
      expect((await simpleGit(root).status()).isClean()).toBe(true);
      // staging also has the source (it's where the work happened).
      const srcRel = (await readDecomposeQueue(stagingWt))[0]; // repo-relative, un-decomposed
      expect(srcRel).toBeTruthy();

      // Decompose on staging → an entity node lands on STAGING, and is NOT evergreen.
      await decomposeOne(stagingWt, srcRel, decompDecider);
      expect((await findEntityFiles(stagingWt)).length).toBe(1); // on staging
      expect((await findEntityFiles(root)).length).toBe(0); // NEVER on main (CANON-4)
      // Even an explicit promotion brings no entities — they're not in the evergreen set.
      await promote(root);
      expect((await findEntityFiles(root)).length).toBe(0);
      expect((await simpleGit(root).status()).isClean()).toBe(true);
    } finally {
      await rmTempDir(dir);
    }
  });
});
