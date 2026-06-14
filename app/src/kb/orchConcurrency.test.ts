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
import { connectOne, readCandidates, readConnectQueue, ConnectStage } from './connectStage';
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

  // SPEC-0048 SCALE-5 gate-of-record (QD-2): unpinning Connect's concurrency. The hazard cap=1 guarded
  // was the dedup/canonical-merge racing on shared `entities/`. With the ephemeral-worktree migration,
  // two resolves of the SAME block key (the worst case) each run in their OWN worktree off the same base,
  // both fold the pending candidate into the existing canonical node (a same-path write on that node's
  // file) → one advances, the other re-syncs onto the moved canonical + re-runs (the candidate is now
  // consumed → no-op). MUST converge: NO duplicate node, NO lost merge, linear history.
  it('SCALE-5: two concurrent connectOne on the SAME block key converge to ONE node (no dup, no lost merge)', async () => {
    const dir = await makeTempDir();
    try {
      const root = path.join(dir, 'vault');
      await createKb({ path: root, initGitIfNeeded: true });
      const stagingWt = await ensureStagingWorktree(root);
      const lock = new Mutex();

      // A resolved "Steve" node exists (source A), then a SECOND candidate (source B, same block) pends.
      const capA = await lock.run(() => captureToInbox(stagingWt, 'test', [{ kind: 'text', text: 'A: Steve' }]));
      await archiveOne(stagingWt, capA.ids[0], deterministicDecider, lock);
      await decomposeOne(stagingWt, (await readDecomposeQueue(stagingWt))[0], decompSteve, lock);
      await connectOne(stagingWt, (await readConnectQueue(stagingWt))[0].blockKey, connectSteve, lock); // node N exists

      const capB = await lock.run(() => captureToInbox(stagingWt, 'test', [{ kind: 'text', text: 'B: Steve' }]));
      await archiveOne(stagingWt, capB.ids[0], deterministicDecider, lock);
      await decomposeOne(stagingWt, (await readDecomposeQueue(stagingWt))[0], decompSteve, lock); // 2nd candidate, same block

      const blockKey = (await readConnectQueue(stagingWt))[0].blockKey;
      expect(blockKey).toBeTruthy();
      const mergesBefore = await mergeCommitCount(stagingWt);

      // Off the SAME base (barrier): two resolves fold the candidate into node N. Pre-migration this raced
      // on the shared worktree (the reason cap was pinned to 1); now they're isolated + converge.
      const barrier = makeBarrier(2);
      await Promise.all([
        connectOne(stagingWt, blockKey, async (s) => (await barrier(), connectFold(s)), lock),
        connectOne(stagingWt, blockKey, async (s) => (await barrier(), connectFold(s)), lock),
      ]);

      const entities = await findEntityFiles(stagingWt);
      expect(entities.length).toBe(1); // ONE Steve node — the race minted no duplicate
      const nodeMd = await fs.readFile(path.join(stagingWt, entities[0]), 'utf8');
      expect(nodeMd).toContain('Steve');
      expect((await readConnectQueue(stagingWt)).length).toBe(0); // candidate consumed — no lost merge
      expect((await readCandidates(stagingWt)).length).toBe(0);
      expect(await mergeCommitCount(stagingWt)).toBe(mergesBefore); // ORCH-3: linear, no merge bubble
      expect(await isClean(stagingWt)).toBe(true);
    } finally {
      await rmTempDir(dir);
    }
  });

  it('SCALE-5: a ConnectStage drain at cap=2 resolves two distinct blocks concurrently, landing them linearly', async () => {
    const dir = await makeTempDir();
    try {
      const root = path.join(dir, 'vault');
      await createKb({ path: root, initGitIfNeeded: true });
      const stagingWt = await ensureStagingWorktree(root);
      const lock = new Mutex();

      // Two sources → two DISTINCT entities (Steve, Dave) → two block keys pending in Connect.
      let n = 0;
      const decompDistinct: DecomposeDecider = async (i) => {
        const name = ['Steve', 'Dave'][n++] ?? 'X';
        return {
          sourceId: i.sourceId,
          entities: [{ kind: 'person', name, confidence: 0.8, mentions: [name] }],
          agent: { via: 'copilot', model: 'test' },
        };
      };
      for (const text of ['one about Steve', 'two about Dave']) {
        const cap = await lock.run(() => captureToInbox(stagingWt, 'test', [{ kind: 'text', text }]));
        await archiveOne(stagingWt, cap.ids[0], deterministicDecider, lock);
        await decomposeOne(stagingWt, (await readDecomposeQueue(stagingWt))[0], decompDistinct, lock);
      }
      expect((await readConnectQueue(stagingWt)).length).toBe(2); // two distinct blocks
      const mergesBefore = await mergeCommitCount(stagingWt);

      // Connect drain at cap=2: both blocks prepare concurrently (each in its own ephemeral worktree),
      // advances serialized by the shared lock — disjoint entity paths replay cleanly (ORCH-3).
      let deciderCalls = 0;
      const connectByName: ConnectDecider = async (set) => {
        deciderCalls++;
        return {
          blockKey: set.blockKey,
          clusters: [{ canonicalName: set.candidates[0].name, memberCandidateIds: set.candidates.map((c) => c.id), confidence: 0.95 }],
          agent: { via: 'copilot', model: 'test' },
        };
      };
      const stage = new ConnectStage(stagingWt, connectByName, lock, undefined, undefined, undefined, undefined, 2);
      await stage.poke();
      stage.stop();

      expect((await readConnectQueue(stagingWt)).length).toBe(0); // both resolved
      expect((await findEntityFiles(stagingWt)).length).toBe(2); // Steve + Dave, no dup
      // SCALE-5 / QD-2: EXACTLY one decide per block — disjoint blocks replay cleanly on the per-block
      // audit, so cap>1 actually parallelizes. A shared-audit collision would re-run prepare (re-invoke
      // the LLM decider) → deciderCalls > 2. This guards the throughput/$ regression, not just convergence.
      expect(deciderCalls).toBe(2);
      expect(await mergeCommitCount(stagingWt)).toBe(mergesBefore); // linear, no merge bubble
      expect(await isClean(stagingWt)).toBe(true);
    } finally {
      await rmTempDir(dir);
    }
  });
});
