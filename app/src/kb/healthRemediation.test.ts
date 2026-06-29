// SPEC-0060 VUX-16 slice-1 — Health remediation backend, the end-to-end DISMISS loop (real FS + git).
// Proves the whole path the unit tests can't: a dismiss commits to the staging worktree, PROMOTES to
// `main`'s evergreen `directives/`, and the next Health scan over `main` (the read layer the live IPC
// uses) filters the finding out. The remediate actions (relink/find-homes) delegate to the
// independently-tested `linkOne`/`linkOrphansOnce` under the same lock+promote glue this exercises.
import { describe, it, expect } from 'vitest';
import { promises as fs } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import simpleGit from 'simple-git';
import { makeTempDir, rmTempDir } from '../../test/tempVault';
import { createKb } from './vault';
import { Mutex } from './stageLock';
import { ensureStagingWorktree } from './stagingWorktree';
import { makeReadOnlyTools } from './recallTools';
import { buildHealthReport, healthFindingKey } from './healthPanel';
import { readHealthDismissals, isHealthFindingDismissed } from './directives';
import { dismissHealthFindingInVault, remediateHealthFindingInVault } from './healthRemediation';

function gitInstalledSync(): boolean {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}
const gitAvailable = gitInstalledSync();

const ORPHAN_REL = 'entities/concept/loose-idea.md';
const PROSE = 'A standalone note with real, substantial prose but no links in or out, so it reads as an orphan only — well clear of the thin-page stub floor. '.repeat(3);

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

describe.skipIf(!gitAvailable)('healthRemediation — dismiss loop (VUX-16 slice-1)', () => {
  it('dismiss → promoted to main directives/ → the next scan filters the finding; restore re-surfaces it', async () => {
    await withVault(async (root, stagingWt, lock) => {
      // Seed an orphan on staging + promote so `main` has it.
      await fs.mkdir(path.join(stagingWt, 'entities', 'concept'), { recursive: true });
      await fs.writeFile(path.join(stagingWt, ORPHAN_REL), `---\nid: loose\nkind: concept\nname: Loose Idea\n---\n# Loose Idea\n\n${PROSE}\n`, 'utf8');
      await simpleGit(stagingWt).add('-A');
      await simpleGit(stagingWt).commit('seed orphan');
      const { promote } = await import('./staging');
      await promote(root);

      // Fails-before: the orphan shows on a main scan with no dismissals.
      const before = await buildHealthReport(makeReadOnlyTools(root), await readHealthDismissals(root));
      expect(before.orphans.map((o) => o.name)).toContain('Loose Idea');

      const key = healthFindingKey('orphan', { rel: ORPHAN_REL, id: 'loose', name: 'Loose Idea', kind: 'concept' });
      const res = await dismissHealthFindingInVault(stagingWt, root, lock, { findingKey: key, kind: 'orphan' }, '2026-06-29T00:00:00.000Z');
      expect(res.ok).toBe(true);

      // The dismissal PROMOTED to main (evergreen directives/) — readable at the scan root.
      expect(isHealthFindingDismissed(await readHealthDismissals(root), key)).toBe(true);
      // Passes-after: the same main scan no longer surfaces the orphan.
      const after = await buildHealthReport(makeReadOnlyTools(root), await readHealthDismissals(root));
      expect(after.orphans.map((o) => o.name)).not.toContain('Loose Idea');

      // Restore (dismissed:false) → re-surfaces, also promoted.
      const restore = await dismissHealthFindingInVault(stagingWt, root, lock, { findingKey: key, kind: 'orphan', dismissed: false }, '2026-06-29T01:00:00.000Z');
      expect(restore.ok).toBe(true);
      const restored = await buildHealthReport(makeReadOnlyTools(root), await readHealthDismissals(root));
      expect(restored.orphans.map((o) => o.name)).toContain('Loose Idea');
    });
  });

  it('a dismiss with an empty findingKey is refused (ok:false), nothing written', async () => {
    await withVault(async (root, stagingWt, lock) => {
      const res = await dismissHealthFindingInVault(stagingWt, root, lock, { findingKey: '', kind: 'orphan' }, '2026-06-29T00:00:00.000Z');
      expect(res.ok).toBe(false);
      expect((await readHealthDismissals(root)).size).toBe(0);
    });
  });

  it('remediate relink without a node is refused (ok:false) — guarded input', async () => {
    await withVault(async (root, stagingWt, lock) => {
      const res = await remediateHealthFindingInVault(stagingWt, root, lock, { action: 'relink', nodeRel: '' });
      expect(res.ok).toBe(false);
    });
  });
});
