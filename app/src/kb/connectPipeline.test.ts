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
import { LINKS_BLOCK_START } from './connectDoc';
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

// Connect resolves the block AND coins an emergent topic tag (SPEC-0025 META-2).
const connectDeciderTagged: ConnectDecider = async (set) => ({
  blockKey: set.blockKey,
  clusters: [
    {
      canonicalName: 'Steve',
      memberCandidateIds: set.candidates.map((c) => c.id),
      confidence: 0.95,
      tags: ['Topic/Tech'], // un-normalized — Connect normalizes to topic/tech
    },
  ],
  agent: { via: 'copilot', model: 'test' },
});

// Claims attaches one grounded assertion to the resolved node.
const claimsDecider: ClaimsDecider = async (input) => ({
  entityId: input.entityId,
  claims: [{ statement: 'Steve owns the Q3 budget.', status: 'fact', confidence: 0.9, mentions: ['Q3 budget'] }],
  agent: { via: 'copilot', model: 'test' },
});

// For the wikilink e2e: one source naming two entities; Steve's claim relates to Apple.
const decompDeciderTwo: DecomposeDecider = async (i) => ({
  sourceId: i.sourceId,
  entities: [
    { kind: 'person', name: 'Steve', confidence: 0.8, mentions: ['Steve'] },
    { kind: 'organization', name: 'Apple', confidence: 0.8, mentions: ['Apple'] },
  ],
  agent: { via: 'copilot', model: 'test' },
});

// Each block resolves to one node named after its candidates (Steve → person, Apple → org).
const connectDeciderEach: ConnectDecider = async (set) => ({
  blockKey: set.blockKey,
  clusters: [{ canonicalName: set.candidates[0].name, memberCandidateIds: set.candidates.map((c) => c.id), confidence: 0.95 }],
  agent: { via: 'copilot', model: 'test' },
});

// Claims leaves a relatesTo hint to Apple on Steve's claim (CLAIMS-10); Apple gets none.
const claimsDeciderLink: ClaimsDecider = async (input) => ({
  entityId: input.entityId,
  claims:
    input.name === 'Steve'
      ? [{ statement: 'Steve co-founded Apple.', status: 'fact', confidence: 0.95, mentions: ['Apple'], relatesTo: ['Apple'] }]
      : [],
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

  it('metadata: the resolved node carries type/<kind> + an emergent topic tag, visible on main (SPEC-0025 META-1/9)', async () => {
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

      await orch.capture('s1', [{ kind: 'text', text: 'call Steve re: Q3 budget' }]);
      await orch.poke();
      for (const srcRel of await readDecomposeQueue(stagingWt)) {
        await decomposeOne(stagingWt, srcRel, decompDecider);
      }
      const connect = new ConnectStage(stagingWt, connectDeciderTagged, lock, undefined, promoteEvergreen);
      await connect.poke();

      const nodeRel = (await findEntityFiles(root))[0]; // promoted to main by Connect's hook
      expect(nodeRel).toBeTruthy();
      const md = await fs.readFile(path.join(root, nodeRel), 'utf8');
      expect(md).toContain('type: person'); // curated Property visible on main
      expect(md).toContain('"type/person"'); // deterministic curated tag
      expect(md).toContain('"topic/tech"'); // emergent agent tag, normalized
      expect((await simpleGit(root).status()).isClean()).toBe(true);
    } finally {
      await rmTempDir(dir);
    }
  });

  it('link-promotion: a claim relatesTo hint becomes a real [[wikilink]] between nodes, visible on main (CONNECT-12)', async () => {
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

      // One source naming two entities → archive → decompose (2 candidates: Steve + Apple).
      await orch.capture('s1', [{ kind: 'text', text: 'Steve co-founded Apple in 1976.' }]);
      await orch.poke();
      for (const srcRel of await readDecomposeQueue(stagingWt)) {
        await decomposeOne(stagingWt, srcRel, decompDeciderTwo);
      }

      // Connect resolves both blocks → two canonical nodes (Steve, Apple), promoted to main.
      const connect = new ConnectStage(stagingWt, connectDeciderEach, lock, undefined, promoteEvergreen);
      await connect.poke();
      expect((await findEntityFiles(root)).length).toBe(2);

      // Claims attaches a claim on Steve carrying relatesTo: ['Apple'] (promoted to main).
      const claims = new ClaimsStage(stagingWt, claimsDeciderLink, lock, undefined, promoteEvergreen);
      await claims.poke();

      // Re-poke Connect: the link-promotion pass turns the relatesTo hint into a real [[wikilink]]
      // to the Apple node, and its afterDrain promotes the linked node — visible on main.
      await connect.poke();

      const ents = await findEntityFiles(root);
      const steveRel = ents.find((r) => r.includes(`${path.sep}person${path.sep}`));
      const appleRel = ents.find((r) => r.includes(`${path.sep}organization${path.sep}`));
      expect(steveRel).toBeTruthy();
      expect(appleRel).toBeTruthy();
      const steveMd = await fs.readFile(path.join(root, steveRel as string), 'utf8');
      expect(steveMd).toContain(LINKS_BLOCK_START);
      expect(steveMd).toContain(`[[${appleRel}]]`); // native Obsidian wikilink between canonical nodes
      expect((await simpleGit(root).status()).isClean()).toBe(true);
    } finally {
      await rmTempDir(dir);
    }
  });

  // REGRESSION (BUG #62, CONNECT-12/13): the test above triggers link-promotion with a MANUAL
  // `connect.poke()`. Live, nothing pokes Connect by hand — the only post-Claims trigger is
  // Claims' `afterDrain`, wired in pipeline.ts as `await promote(); void connect.poke()`. This
  // test drives link-promotion EXCLUSIVELY through that wiring (Claims' afterDrain pokes Connect;
  // we retain the returned drain promise only to await it deterministically — we never poke
  // Connect ourselves as the trigger). If the post-Claims auto-poke is missing/broken, the
  // wikilink never renders on `main` and this fails — the live symptom #35's tests masked.
  it('link-promotion fires from Claims’ afterDrain alone — no manual Connect poke (regression; CONNECT-12)', async () => {
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

      await orch.capture('s1', [{ kind: 'text', text: 'Steve co-founded Apple in 1976.' }]);
      await orch.poke();
      for (const srcRel of await readDecomposeQueue(stagingWt)) {
        await decomposeOne(stagingWt, srcRel, decompDeciderTwo);
      }

      const connect = new ConnectStage(stagingWt, connectDeciderEach, lock, undefined, promoteEvergreen);
      await connect.poke();
      expect((await findEntityFiles(root)).length).toBe(2);

      // Wire Claims EXACTLY as pipeline.ts does: afterDrain promotes claims, then pokes Connect so
      // its link-promotion pass turns the `relatesTo` hint into a real [[wikilink]]. We keep the
      // poke's promise (pipeline.ts discards it via `void`) ONLY to await the auto-triggered drain.
      let linkDrain: Promise<void> = Promise.resolve();
      const claims = new ClaimsStage(stagingWt, claimsDeciderLink, lock, undefined, async () => {
        await promoteEvergreen();
        linkDrain = connect.poke(); // the post-Claims trigger under test — NOT a manual test poke
      });
      await claims.poke();
      await linkDrain; // settle the link-promotion drain Claims' afterDrain kicked off

      const ents = await findEntityFiles(root);
      const steveRel = ents.find((r) => r.includes(`${path.sep}person${path.sep}`));
      const appleRel = ents.find((r) => r.includes(`${path.sep}organization${path.sep}`));
      expect(steveRel).toBeTruthy();
      expect(appleRel).toBeTruthy();
      const steveMd = await fs.readFile(path.join(root, steveRel as string), 'utf8');
      expect(steveMd).toContain(LINKS_BLOCK_START);
      expect(steveMd).toContain(`[[${appleRel}]]`); // wikilink rendered on main via the auto-poke alone
      expect((await simpleGit(root).status()).isClean()).toBe(true);
    } finally {
      await rmTempDir(dir);
    }
  });
});
