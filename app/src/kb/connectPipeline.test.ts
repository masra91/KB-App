// Integration: the evergreen pipeline through CONNECT (SPEC-0020 + SPEC-0021 slice 4). The
// working pipeline runs on the `staging` worktree; Decompose emits CANDIDATES (STAGING-5),
// CONNECT resolves + DEDUPS them into evergreen `entities/`, and Connect's promotion hook
// publishes the resolved nodes → `main`.
//
// Proves the headline of the "Visible Enrich" milestone: TWO sources naming the same thing →
// ONE canonical node (dedup, CONNECT-1), VISIBLE ON `main` — promoted by Connect's own
// afterDrain hook, not a manual promote() call. Working state (`candidates/`) never reaches
// `main`. (Claims-after-Connect + `[[wikilink]]` link-promotion are later slices — claims need
// the Connect→Claims provenance fix; links are the deferred CONNECT-12/13 re-pass.) Deciders are
// injected so nothing shells out to copilot (TEST-2).
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
import { promises as fs } from 'node:fs';
import { decomposeOne, findSourceDirs, readDecomposeQueue } from './decomposeStage';
import { ClaimsStage, findEntityFiles } from './claimsStage';
import { ConnectStage, readCandidates } from './connectStage';
import type { DecomposeDecider } from './decomposeAgent';
import type { ConnectDecider } from './connectAgent';
import type { ClaimsDecider } from './claimsAgent';

function gitInstalledSync(): boolean {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}
const gitAvailable = gitInstalledSync();

// Decompose finds one mention of the same person in each source → one candidate per source.
const decompDecider: DecomposeDecider = async (i) => ({
  sourceId: i.sourceId,
  entities: [{ kind: 'person', name: 'Steve', confidence: 0.8, mentions: ['Steve'] }],
  agent: { via: 'copilot', model: 'test' },
});

// Connect judges every candidate in a block to be the SAME real thing → ONE deduped cluster.
const connectDecider: ConnectDecider = async (set) => ({
  blockKey: set.blockKey,
  clusters: [{ canonicalName: 'Steve', memberCandidateIds: set.candidates.map((c) => c.id), confidence: 0.95 }],
  agent: { via: 'copilot', model: 'test' },
});

// Claims attaches one grounded assertion to the resolved node.
const claimsDecider: ClaimsDecider = async (input) => ({
  entityId: input.entityId,
  claims: [{ statement: 'Steve owns the Q3 budget.', status: 'fact', confidence: 0.9, mentions: ['Q3 budget'] }],
  agent: { via: 'copilot', model: 'test' },
});

/** Walk `root/claims` and return repo-relative `.md` claim files. */
async function findClaimFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(d: string): Promise<void> {
    let entries: import('node:fs').Dirent[];
    try {
      entries = await fs.readdir(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) await walk(p);
      else if (e.name.endsWith('.md')) out.push(path.relative(root, p));
    }
  }
  await walk(path.join(root, 'claims'));
  return out;
}

describe.skipIf(!gitAvailable)('Visible Enrich — deduped entities promote to main (SPEC-0020 / STAGING slice 4)', () => {
  it('two sources naming the same person → ONE node, visible on main via Connect’s promote-hook', async () => {
    const dir = await makeTempDir();
    try {
      const root = path.join(dir, 'vault');
      await createKb({ path: root, initGitIfNeeded: true });
      const stagingWt = await ensureStagingWorktree(root);
      const lock = new Mutex(); // the one shared canonical-writer lock (§5)
      const promoteEvergreen = async (): Promise<void> => {
        await promote(root);
      };
      // Stages carry the promotion gate as their afterDrain — exactly as pipeline.ts wires it.
      const orch = new Orchestrator(stagingWt, deterministicDecider, lock, promoteEvergreen);

      // Two distinct sources that both name the same person.
      await orch.capture('s1', [{ kind: 'text', text: 'call Steve re: Q3 budget' }]);
      await orch.capture('s2', [{ kind: 'text', text: 'Steve approved the Q3 plan' }]);
      await orch.poke(); // archive both → afterDrain promotes sources → main
      expect((await findSourceDirs(root)).length).toBe(2);

      // Decompose both sources → 2 candidates (same name, distinct provenance) on staging.
      for (const srcRel of await readDecomposeQueue(stagingWt)) {
        await decomposeOne(stagingWt, srcRel, decompDecider);
      }
      expect((await readCandidates(stagingWt)).length).toBe(2);
      expect((await findEntityFiles(stagingWt)).length).toBe(0); // entities empty until Connect

      // Connect DEDUPS the two same-name candidates into ONE node and (afterDrain) promotes it.
      const connect = new ConnectStage(stagingWt, connectDecider, lock, undefined, promoteEvergreen);
      await connect.poke();
      const stagedNodes = await findEntityFiles(stagingWt);
      expect(stagedNodes).toHaveLength(1); // CONNECT-1 dedup: two candidates → ONE canonical node
      expect((await readCandidates(stagingWt)).length).toBe(0); // candidates consumed

      // …and the resolved node is already VISIBLE ON MAIN — promoted by Connect's hook, no manual
      // promote() call. The node carries both sources' provenance (dedup across sources).
      const nodeRel = stagedNodes[0];
      expect((await findEntityFiles(root)).length).toBe(1);
      expect(await pathExists(path.join(root, nodeRel))).toBe(true);

      // Working state never reaches main; main stays clean (CANON-1 / STAGING-6).
      expect((await readCandidates(root)).length).toBe(0);
      expect(await pathExists(path.join(root, 'candidates'))).toBe(false);
      expect((await simpleGit(root).status()).isClean()).toBe(true);
    } finally {
      await rmTempDir(dir);
    }
  });

  it('claims-after-Connect: the deduped node gets a claim, visible on main (provenance fix; CLAIMS-5/9)', async () => {
    const dir = await makeTempDir();
    try {
      const root = path.join(dir, 'vault');
      await createKb({ path: root, initGitIfNeeded: true });
      const stagingWt = await ensureStagingWorktree(root);
      const lock = new Mutex();
      const promoteEvergreen = async (): Promise<void> => {
        await promote(root);
      };
      const orch = new Orchestrator(stagingWt, deterministicDecider, lock, promoteEvergreen);

      // Two sources naming the same person → archive (promote sources) → decompose → connect.
      await orch.capture('s1', [{ kind: 'text', text: 'call Steve re: Q3 budget' }]);
      await orch.capture('s2', [{ kind: 'text', text: 'Steve approved the Q3 plan' }]);
      await orch.poke();
      for (const srcRel of await readDecomposeQueue(stagingWt)) {
        await decomposeOne(stagingWt, srcRel, decompDecider);
      }
      const connect = new ConnectStage(stagingWt, connectDecider, lock, undefined, promoteEvergreen);
      await connect.poke();
      const nodeRel = (await findEntityFiles(stagingWt))[0];
      expect(nodeRel).toBeTruthy();

      // The resolved node's derivedFrom now holds a source-DIR path (the provenance fix), so Claims
      // can read the source and attach a claim. Claims' afterDrain promotes it to main.
      const claims = new ClaimsStage(stagingWt, claimsDecider, lock, undefined, promoteEvergreen);
      await claims.poke();

      // The claim file + the node's regenerated claims block are VISIBLE ON MAIN — auto-promoted.
      expect((await findClaimFiles(root)).length).toBeGreaterThanOrEqual(1);
      const nodeOnMain = await fs.readFile(path.join(root, nodeRel), 'utf8');
      expect(nodeOnMain).toContain('Steve owns the Q3 budget.'); // claim visible in the node
      expect(nodeOnMain).toContain('kb:claims:start'); // regenerated claims block (CLAIMS-9)

      // Working state never on main; main clean.
      expect(await pathExists(path.join(root, 'candidates'))).toBe(false);
      expect((await simpleGit(root).status()).isClean()).toBe(true);
    } finally {
      await rmTempDir(dir);
    }
  });
});
