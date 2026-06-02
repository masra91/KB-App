// Cross-stage interleaving tests for optimistic concurrency (SPEC-0014 ORCH-17/18/19), at the STAGE
// level (the helper-level mechanics are in canonicalAdvance.test.ts). Now that the lock guards ONLY
// the ff-advance, two DIFFERENT stages prepare concurrently off a synced checkpoint and serialize
// only their advances (ORCH-17). We force the interleaving deterministically with a barrier in the
// injected deciders, so both stages capture the SAME base before either advances, then assert:
//   - disjoint cross-stage ops both land, canonical history LINEAR (no merge bubble; ORCH-3);
//   - same-path cross-stage ops (Connect rewrites a node ↔ Claims edits its block) collide, the
//     loser RE-SYNCS + retries against the fresh canonical, and both effects converge (ORCH-18/19).
// (K-exhaustion → set-aside is proven at the helper level in canonicalAdvance.test.ts.)
import { describe, it, expect } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import simpleGit from 'simple-git';
import { makeTempDir, rmTempDir } from '../../test/tempVault';
import { gitAvailable } from '../../test/gitEnv';
import { createKb } from './vault';
import { ensureStagingWorktree } from './stagingWorktree';
import { Mutex } from './stageLock';
import { captureToInbox } from './ingest';
import { archiveOne } from './orchestrator';
import { deterministicDecider } from './archivist';
import { decomposeOne, readDecomposeQueue, findSourceDirs, DecomposeStage } from './decomposeStage';
import { connectOne, readCandidates, readConnectQueue } from './connectStage';
import { claimsOne, readClaimsQueue, findEntityFiles } from './claimsStage';
import type { DecomposeDecider } from './decomposeAgent';
import type { ConnectDecider } from './connectAgent';
import type { ClaimsDecider } from './claimsAgent';

/** A barrier that resolves once `n` callers have arrived — forces concurrent stages to prepare off
 *  the SAME canonical checkpoint before any of them advances. */
function makeBarrier(n: number): () => Promise<void> {
  let arrived = 0;
  let release: () => void = () => {};
  const gate = new Promise<void>((r) => (release = r));
  return async () => {
    if (++arrived >= n) release();
    await gate;
  };
}

const mergeCommitCount = async (root: string): Promise<number> => {
  const out = (await simpleGit(root).raw('rev-list', '--merges', '--count', 'HEAD')).trim();
  return Number(out);
};
const isClean = async (root: string): Promise<boolean> => (await simpleGit(root).status()).isClean();

const decompSteve: DecomposeDecider = async (i) => ({
  sourceId: i.sourceId,
  entities: [{ kind: 'person', name: 'Steve', confidence: 0.8, mentions: ['Steve'] }],
  agent: { via: 'copilot', model: 'test' },
});
const connectSteve: ConnectDecider = async (set) => ({
  blockKey: set.blockKey,
  clusters: [{ canonicalName: 'Steve', memberCandidateIds: set.candidates.map((c) => c.id), confidence: 0.95 }],
  agent: { via: 'copilot', model: 'test' },
});
// Re-resolve that FOLDS new candidates into the already-existing node (so a re-run rewrites that
// node rather than minting a second one) — the same-path case Claims can collide with.
const connectFold: ConnectDecider = async (set) => ({
  blockKey: set.blockKey,
  clusters: [
    {
      canonicalName: 'Steve',
      memberCandidateIds: set.candidates.map((c) => c.id),
      confidence: 0.95,
      ...(set.existingNodes[0] ? { existingNodeId: set.existingNodes[0].id } : {}),
    },
  ],
  agent: { via: 'copilot', model: 'test' },
});
const claimsSteve: ClaimsDecider = async (input) => ({
  entityId: input.entityId,
  claims: [{ statement: 'Steve owns the Q3 budget.', status: 'fact', confidence: 0.9, mentions: ['Q3'] }],
  agent: { via: 'copilot', model: 'test' },
});

describe.skipIf(!gitAvailable)('cross-stage optimistic concurrency (SPEC-0014 ORCH-17/18/19)', () => {
  it('disjoint cross-stage ops prepared off the same base both land, history stays LINEAR (ORCH-3)', async () => {
    const dir = await makeTempDir();
    try {
      const root = path.join(dir, 'vault');
      await createKb({ path: root, initGitIfNeeded: true });
      const stagingWt = await ensureStagingWorktree(root);
      const lock = new Mutex();

      // Source A archived (so Decompose has something to chew); source B left in the inbox.
      const capA = await lock.run(() => captureToInbox(stagingWt, 'test', [{ kind: 'text', text: 'source A about Steve' }]));
      await archiveOne(stagingWt, capA.ids[0], deterministicDecider, lock);
      const srcRelA = (await readDecomposeQueue(stagingWt))[0];
      const capB = await lock.run(() => captureToInbox(stagingWt, 'test', [{ kind: 'text', text: 'source B about Tim' }]));
      const idB = capB.ids[0];

      const mergesBefore = await mergeCommitCount(stagingWt);

      // Concurrently, off the SAME base (barrier): Archivist archives B (writes sources/B) while
      // Decompose processes A (writes candidates/ + A's audit) — disjoint paths, different worktrees.
      const barrier = makeBarrier(2);
      await Promise.all([
        archiveOne(stagingWt, idB, async (m) => (await barrier(), deterministicDecider(m)), lock),
        decomposeOne(stagingWt, srcRelA, async (i) => (await barrier(), decompSteve(i)), lock),
      ]);

      // Both landed: B is now a source (A + B), A produced a candidate.
      expect((await findSourceDirs(stagingWt)).length).toBe(2);
      expect((await readCandidates(stagingWt)).length).toBeGreaterThanOrEqual(1);
      // ORCH-3: the second op replayed onto the moved canonical via cherry-pick — NO merge bubble.
      expect(await mergeCommitCount(stagingWt)).toBe(mergesBefore);
      expect(await isClean(stagingWt)).toBe(true);
    } finally {
      await rmTempDir(dir);
    }
  });

  it('same-path cross-stage (Connect node rewrite ↔ Claims block edit) collides, retries, converges', async () => {
    const dir = await makeTempDir();
    try {
      const root = path.join(dir, 'vault');
      await createKb({ path: root, initGitIfNeeded: true });
      const stagingWt = await ensureStagingWorktree(root);
      const lock = new Mutex();

      // Build a resolved entity for "Steve" from source A, plus a SECOND pending candidate (source B,
      // same block) so a Connect re-run will rewrite the node — while Claims is also pending on it.
      const capA = await lock.run(() => captureToInbox(stagingWt, 'test', [{ kind: 'text', text: 'A: Steve' }]));
      await archiveOne(stagingWt, capA.ids[0], deterministicDecider, lock);
      await decomposeOne(stagingWt, (await readDecomposeQueue(stagingWt))[0], decompSteve, lock);
      await connectOne(stagingWt, (await readConnectQueue(stagingWt))[0].blockKey, connectSteve, lock); // entity X exists

      const capB = await lock.run(() => captureToInbox(stagingWt, 'test', [{ kind: 'text', text: 'B: Steve' }]));
      await archiveOne(stagingWt, capB.ids[0], deterministicDecider, lock);
      await decomposeOne(stagingWt, (await readDecomposeQueue(stagingWt))[0], decompSteve, lock); // a 2nd candidate, same block

      const blockKey = (await readConnectQueue(stagingWt))[0].blockKey; // still actionable (new candidate)
      const entityRel = (await readClaimsQueue(stagingWt))[0]; // X is pending for claims
      expect(blockKey).toBeTruthy();
      expect(entityRel).toBeTruthy();

      const mergesBefore = await mergeCommitCount(stagingWt);

      // Concurrently off the SAME base (barrier): Connect re-resolves the block (rewrites the node)
      // while Claims edits that same node's claims block → a SAME-PATH collision on the entity file.
      const barrier = makeBarrier(2);
      await Promise.all([
        connectOne(stagingWt, blockKey, async (s) => (await barrier(), connectFold(s)), lock),
        claimsOne(stagingWt, entityRel, async (i) => (await barrier(), claimsSteve(i)), lock),
      ]);

      // Converged: exactly one Steve node, carrying the claim (Claims re-synced onto Connect's
      // rewrite, or vice-versa), the 2nd candidate consumed, history linear, tree clean.
      const entities = await findEntityFiles(stagingWt);
      expect(entities.length).toBe(1);
      const nodeMd = await fs.readFile(path.join(stagingWt, entities[0]), 'utf8');
      expect(nodeMd).toContain('Q3 budget'); // the claim survived the collision/retry
      expect(await mergeCommitCount(stagingWt)).toBe(mergesBefore); // ORCH-3: linear, no merge bubble
      expect(await isClean(stagingWt)).toBe(true);
    } finally {
      await rmTempDir(dir);
    }
  });

  it('a stage drain at cap=2 processes two items concurrently, landing them linearly (ORCH-20)', async () => {
    const dir = await makeTempDir();
    try {
      const root = path.join(dir, 'vault');
      await createKb({ path: root, initGitIfNeeded: true });
      const stagingWt = await ensureStagingWorktree(root);
      const lock = new Mutex();
      // Archive two sources so Decompose has two queue items.
      for (const text of ['source one about Steve', 'source two about Steve']) {
        const cap = await lock.run(() => captureToInbox(stagingWt, 'test', [{ kind: 'text', text }]));
        await archiveOne(stagingWt, cap.ids[0], deterministicDecider, lock);
      }
      expect((await readDecomposeQueue(stagingWt)).length).toBe(2);
      const mergesBefore = await mergeCommitCount(stagingWt);

      // Decompose drain at cap=2: both sources prepare concurrently (each in its own ephemeral
      // worktree), advances serialized by the shared lock — disjoint paths replay cleanly.
      const stage = new DecomposeStage(stagingWt, decompSteve, lock, undefined, 2);
      await stage.poke();
      stage.stop();

      expect((await readDecomposeQueue(stagingWt)).length).toBe(0); // both decomposed
      expect((await readCandidates(stagingWt)).length).toBe(2); // one candidate from each source
      expect(await mergeCommitCount(stagingWt)).toBe(mergesBefore); // ORCH-3: linear, no merge bubble
      expect(await isClean(stagingWt)).toBe(true);
    } finally {
      await rmTempDir(dir);
    }
  });
});
