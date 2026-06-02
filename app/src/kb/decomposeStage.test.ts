// Decompose stage tests (SPEC-0015 DECOMP). Real FS + git + worktrees against a throwaway
// temp vault (TEST-18); the decider is injected so nothing shells out to copilot (TEST-2).
import { describe, it, expect } from 'vitest';
import { promises as fs } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import simpleGit from 'simple-git';
import { makeTempDir, rmTempDir } from '../../test/tempVault';
import { createKb } from './vault';
import { captureToInbox } from './ingest';
import { archiveOne, readQueue, Orchestrator } from './orchestrator';
import { deterministicDecider } from './archivist';
import { Mutex } from './stageLock';
import {
  decomposeOne,
  readDecomposeQueue,
  findSourceDirs,
  DecomposeStage,
  DEFAULT_MAX_ATTEMPTS,
} from './decomposeStage';
import { findEntityFiles } from './claimsStage';
import type { DecomposeDecider } from './decomposeAgent';
import type { DecomposeDecision } from './decompose';

function gitInstalledSync(): boolean {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}
const gitAvailable = gitInstalledSync();

/** Run `fn` against a fresh throwaway vault dir, cleaning up afterwards. */
async function withTempVault(fn: (root: string) => Promise<void>): Promise<void> {
  const dir = await makeTempDir();
  try {
    await fn(path.join(dir, 'vault'));
  } finally {
    await rmTempDir(dir);
  }
}

/** Capture + archive one text source; return its repo-relative source dir. */
async function archiveText(root: string, text: string): Promise<string> {
  await captureToInbox(root, 'in-app-panel', [{ kind: 'text', text }]);
  const queue = await readQueue(root);
  return archiveOne(root, queue[queue.length - 1], deterministicDecider);
}

/** A decider that returns a fixed set of entity names (all kind=person) + optional signals. */
function deciderFor(names: string[], signals?: DecomposeDecision['signals']): DecomposeDecider {
  return async (input) => ({
    sourceId: input.sourceId,
    entities: names.map((name) => ({ kind: 'person', name, confidence: 0.8, mentions: [name] })),
    ...(signals ? { signals } : {}),
    agent: { via: 'copilot', model: 'test' },
  });
}

/** Walk a tree under `root/<sub>` and read every file matching `ext`. */
async function readFilesUnder(root: string, sub: string, ext: string): Promise<string[]> {
  const dir = path.join(root, sub);
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
      else if (e.name.endsWith(ext)) out.push(await fs.readFile(p, 'utf8'));
    }
  }
  await walk(dir);
  return out;
}

/** The candidate JSON files Decompose writes on `staging` (STAGING-5). */
async function readCandidateFiles(root: string): Promise<string[]> {
  return readFilesUnder(root, 'candidates', '.json');
}

/** Parsed candidate objects, for asserting on shape/provenance. */
async function readCandidates(root: string): Promise<Array<Record<string, unknown>>> {
  return (await readCandidateFiles(root)).map((s) => JSON.parse(s) as Record<string, unknown>);
}

describe.skipIf(!gitAvailable)('readDecomposeQueue (DECOMP-13, DECOMP-16)', () => {
  it('lists archived sources that have no terminal decompose marker', async () => {
    await withTempVault(async (root) => {
      await createKb({ path: root, initGitIfNeeded: true });
      await archiveText(root, 'one');
      await archiveText(root, 'two');
      const q = await readDecomposeQueue(root);
      expect(q.length).toBe(2);
      expect((await findSourceDirs(root)).length).toBe(2);
    });
  });
});

describe.skipIf(!gitAvailable)('decomposeOne (DECOMP-1/5/12; STAGING-5)', () => {
  it('writes candidate files with sourceId provenance, NO entities/, and ff-advances a clean tree', async () => {
    await withTempVault(async (root) => {
      await createKb({ path: root, initGitIfNeeded: true });
      const srcRel = await archiveText(root, 'call Steve re: Q3 budget');
      const res = await decomposeOne(root, srcRel, deciderFor(['Steve', 'Q3 budget']));

      expect(res.ok).toBe(true);
      expect(res.candidateIds).toHaveLength(2);
      const cands = await readCandidates(root);
      expect(cands).toHaveLength(2);
      // STAGING-5: each candidate carries provenance via sourceId (= the source's ULID), not a node.
      expect(cands.map((c) => c.sourceId)).toEqual([path.basename(srcRel), path.basename(srcRel)]);
      expect(cands.map((c) => c.name).sort()).toEqual(['Q3 budget', 'Steve']);
      // CANON-4: Decompose writes NO entity nodes — entities/ stays empty until Connect resolves.
      expect(await findEntityFiles(root)).toHaveLength(0);

      const status = await simpleGit(root).status();
      expect(status.isClean()).toBe(true); // ORCH-3 canonical never left dirty
    });
  });
});

describe.skipIf(!gitAvailable)('idempotent commit-to-dequeue (DECOMP-13, ORCH-13)', () => {
  it('a decomposed source leaves the queue and is not re-processed', async () => {
    await withTempVault(async (root) => {
      await createKb({ path: root, initGitIfNeeded: true });
      const srcRel = await archiveText(root, 'hello');
      await decomposeOne(root, srcRel, deciderFor(['A']));
      expect(await readDecomposeQueue(root)).toHaveLength(0); // dequeued
      // A second drain must not duplicate candidates.
      const stage = new DecomposeStage(root, deciderFor(['A']));
      await stage.poke();
      expect(await readCandidateFiles(root)).toHaveLength(1);
    });
  });
});

describe.skipIf(!gitAvailable)('sources are never mutated (DECOMP-8)', () => {
  it('leaves raw payload and source.md byte-for-byte unchanged', async () => {
    await withTempVault(async (root) => {
      await createKb({ path: root, initGitIfNeeded: true });
      const srcRel = await archiveText(root, 'immutable ground truth');
      const rawBefore = await fs.readFile(path.join(root, srcRel, 'raw.md'), 'utf8');
      const mdBefore = await fs.readFile(path.join(root, srcRel, 'source.md'), 'utf8');
      await decomposeOne(root, srcRel, deciderFor(['X']));
      expect(await fs.readFile(path.join(root, srcRel, 'raw.md'), 'utf8')).toBe(rawBefore);
      expect(await fs.readFile(path.join(root, srcRel, 'source.md'), 'utf8')).toBe(mdBefore);
    });
  });
});

describe.skipIf(!gitAvailable)('signals route to the audit log only (DECOMP-9, DECOMP-11)', () => {
  it('writes signals into audit.jsonl with the rigid envelope, never into candidates', async () => {
    await withTempVault(async (root) => {
      await createKb({ path: root, initGitIfNeeded: true });
      const srcRel = await archiveText(root, 'trip report');
      await decomposeOne(root, srcRel, deciderFor(['Austin site'], [{ type: 'ambiguity', note: 'which Austin?', refs: ['Austin site'] }]));

      const audit = await fs.readFile(path.join(root, srcRel, 'audit.jsonl'), 'utf8');
      const sigLine = audit
        .split('\n')
        .map((l) => (l.trim() ? JSON.parse(l) : null))
        .find((o) => o && o.event === 'signal');
      expect(sigLine).toMatchObject({ stage: 'decompose', sourceId: expect.any(String), event: 'signal', type: 'ambiguity', note: 'which Austin?' });
      expect(sigLine.ts).toBeTruthy(); // envelope timestamp (DECOMP-11)

      const cands = (await readCandidateFiles(root)).join('\n');
      expect(cands).not.toContain('ambiguity'); // signal must NOT leak into the working graph
      expect(cands).not.toContain('which Austin?');
    });
  });

  it('emits a research-request signal with its what/context into the audit (SPEC-0028 RESEARCH-3)', async () => {
    await withTempVault(async (root) => {
      await createKb({ path: root, initGitIfNeeded: true });
      const srcRel = await archiveText(root, 'we shipped on Atlas');
      await decomposeOne(root, srcRel, deciderFor([], [{ type: 'research-request', note: 'unexplained term', what: 'Atlas', context: 'we shipped on Atlas' }]));

      const audit = await fs.readFile(path.join(root, srcRel, 'audit.jsonl'), 'utf8');
      const sigLine = audit
        .split('\n')
        .map((l) => (l.trim() ? JSON.parse(l) : null))
        .find((o) => o && o.event === 'signal' && o.type === 'research-request');
      // The structured fields the dispatcher reads back must ride along on the signal line.
      expect(sigLine).toMatchObject({ type: 'research-request', note: 'unexplained term', what: 'Atlas', context: 'we shipped on Atlas' });
    });
  });
});

describe.skipIf(!gitAvailable)('empty result is valid (SPEC-0015 §3.5)', () => {
  it('commits zero candidates and dequeues cleanly', async () => {
    await withTempVault(async (root) => {
      await createKb({ path: root, initGitIfNeeded: true });
      const srcRel = await archiveText(root, 'nthg');
      const res = await decomposeOne(root, srcRel, deciderFor([]));
      expect(res.ok).toBe(true);
      expect(res.candidateIds).toHaveLength(0);
      expect(await readDecomposeQueue(root)).toHaveLength(0);
    });
  });
});

describe.skipIf(!gitAvailable)('fresh candidates, no cross-source resolution (DECOMP-14, STAGING-5)', () => {
  it('two sources mentioning the same name produce two distinct candidates (resolution is Connect’s job)', async () => {
    await withTempVault(async (root) => {
      await createKb({ path: root, initGitIfNeeded: true });
      const a = await archiveText(root, 'Steve A');
      const b = await archiveText(root, 'Steve B');
      await decomposeOne(root, a, deciderFor(['Steve']));
      await decomposeOne(root, b, deciderFor(['Steve']));
      const cands = await readCandidates(root);
      expect(cands).toHaveLength(2); // not merged — two Steve candidates, one per source
      expect(new Set(cands.map((c) => c.sourceId)).size).toBe(2); // distinct provenance
      expect(new Set(cands.map((c) => c.id)).size).toBe(2); // distinct candidate ids
    });
  });
});

describe.skipIf(!gitAvailable)('failure never loses the source; set aside after K (DECOMP-6, ORCH-12)', () => {
  it('retries then sets aside a poison source without blocking the queue or writing candidates', async () => {
    await withTempVault(async (root) => {
      await createKb({ path: root, initGitIfNeeded: true });
      const bad = await archiveText(root, 'poison');
      const good = await archiveText(root, 'fine');

      const badId = path.basename(bad);
      // Fails the poison source on every attempt; succeeds for the good source.
      const decider: DecomposeDecider = async (i) => {
        if (i.sourceId === badId) throw new Error('boom');
        return deciderFor(['OK'])(i);
      };

      const stage = new DecomposeStage(root, decider, new Mutex(), DEFAULT_MAX_ATTEMPTS);
      // Poke enough times to exhaust the poison source's attempts.
      for (let n = 0; n < DEFAULT_MAX_ATTEMPTS + 1; n++) await stage.poke();

      // Good source decomposed; poison set aside; queue drained (no head-of-line block).
      expect(await readDecomposeQueue(root)).toHaveLength(0);
      const badAudit = await fs.readFile(path.join(root, bad, 'audit.jsonl'), 'utf8');
      expect(badAudit).toContain('"event":"setaside"');
      expect(badAudit).not.toContain('"event":"decomposed"');
      // The good source WAS decomposed (the poison item didn't block it).
      expect(await fs.readFile(path.join(root, good, 'audit.jsonl'), 'utf8')).toContain('"event":"decomposed"');
      // Exactly one candidate exists — the good source's; the poison source wrote none (DECOMP-6).
      const cands = await readCandidates(root);
      expect(cands).toHaveLength(1);
      expect(cands[0].sourceId).toBe(path.basename(good));
      // The poison source is still preserved.
      expect(await fs.readFile(path.join(root, bad, 'raw.md'), 'utf8')).toBe('poison');
    });
  });
});

describe.skipIf(!gitAvailable)('shared canonical-writer lock serializes stages (SPEC-0014 §5)', () => {
  it('archivist + decompose advance the same canonical ref without racing', async () => {
    await withTempVault(async (root) => {
      await createKb({ path: root, initGitIfNeeded: true });
      // Pre-archive one source so decompose has work; queue a fresh capture for the archivist.
      const srcRel = await archiveText(root, 'shared');
      await captureToInbox(root, 'in-app-panel', [{ kind: 'text', text: 'concurrent' }]);

      const lock = new Mutex();
      const orch = new Orchestrator(root, deterministicDecider, lock);
      const decompose = new DecomposeStage(root, deciderFor(['Shared']), lock);
      // Drain both concurrently — the shared lock must serialize the canonical ff-advances so
      // the two stages never race on the root index.lock (the property under test).
      await Promise.all([orch.poke(), decompose.poke()]);
      void srcRel;

      // The canonical tree is clean and the archivist fully drained — proof the concurrent
      // ff-advances serialized cleanly (a race would corrupt the tree or abort a merge).
      const status = await simpleGit(root).status();
      expect(status.isClean()).toBe(true);
      expect(await readQueue(root)).toHaveLength(0); // archivist drained

      // A final decompose poke drains whatever the archivist produced concurrently (the
      // periodic sweep does this in production; here we force it deterministically).
      await decompose.poke();
      expect(await readDecomposeQueue(root)).toHaveLength(0);
      const status2 = await simpleGit(root).status();
      expect(status2.isClean()).toBe(true);
    });
  });
});
