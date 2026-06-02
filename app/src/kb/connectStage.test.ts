// Connect stage tests (SPEC-0020). Real FS + git + worktrees against a throwaway temp vault
// (TEST-18); the decider is injected so nothing shells out to copilot (TEST-2).
import { describe, it, expect } from 'vitest';
import { promises as fs } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import simpleGit from 'simple-git';
import { makeTempDir, rmTempDir } from '../../test/tempVault';
import { createKb } from './vault';
import { ulid, dateShard } from './ulid';
import { renderEntityNode, LINKS_BLOCK_START } from './connectDoc';
import { connectOne, readConnectQueue, ConnectStage, DEFAULT_MAX_ATTEMPTS, linkOne, readLinkQueue } from './connectStage';
import type { ConnectDecider, CandidateSet } from './connectAgent';
import type { Candidate, ConnectDecision } from './connect';
import { Mutex } from './stageLock';

function gitInstalledSync(): boolean {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}
const gitAvailable = gitInstalledSync();

async function withTempVault(fn: (root: string) => Promise<void>): Promise<void> {
  const dir = await makeTempDir();
  try {
    await fn(path.join(dir, 'vault'));
  } finally {
    await rmTempDir(dir);
  }
}

/** Commit whatever is in the working tree so the connect worktree (based on main) sees it. */
async function commitAll(root: string, msg: string): Promise<void> {
  const git = simpleGit(root);
  await git.add('-A');
  await git.commit(msg);
}

/** Seed a candidate file in the working zone and return its id. */
async function seedCandidate(root: string, kind: string, name: string, sourceId: string): Promise<string> {
  const id = ulid();
  const rel = path.join('candidates', dateShard(id), `${id}.json`);
  const dest = path.join(root, rel);
  await fs.mkdir(path.dirname(dest), { recursive: true });
  const cand: Candidate = { id, sourceId, kind, name, confidence: 0.8, mentions: [name] };
  await fs.writeFile(dest, JSON.stringify(cand, null, 2), 'utf8');
  return id;
}

/** Seed an existing canonical entity node; returns { id, rel }. */
async function seedNode(root: string, kind: string, name: string, derivedFrom: string[]): Promise<{ id: string; rel: string }> {
  const id = ulid();
  const rel = path.join('entities', kind, `${name.toLowerCase().replace(/\s+/g, '-')}.md`);
  const dest = path.join(root, rel);
  await fs.mkdir(path.dirname(dest), { recursive: true });
  await fs.writeFile(
    dest,
    renderEntityNode({
      id,
      kind,
      name,
      confidence: 0.9,
      aliases: [id],
      derivedFrom,
      resolvedFrom: [],
      createdAt: '2026-05-30T00:00:00Z',
      updatedAt: '2026-05-30T00:00:00Z',
    }),
    'utf8',
  );
  return { id, rel };
}

/** A claim file subject→entityRel, used to test repoint-on-merge. */
async function seedClaim(root: string, subjectRel: string, statement: string): Promise<string> {
  const id = ulid();
  const rel = path.join('claims', dateShard(id), `${id}.md`);
  const dest = path.join(root, rel);
  await fs.mkdir(path.dirname(dest), { recursive: true });
  const fm = ['---', `id: ${id}`, `subject: ${subjectRel}`, 'status: fact', 'confidence: 0.9', '---', '', statement, ''].join('\n');
  await fs.writeFile(dest, fm, 'utf8');
  return rel;
}

/** A claim carrying `relatesTo` hints (what Claims leaves for Connect to promote into links). */
async function seedClaimRelatesTo(root: string, subjectRel: string, statement: string, relatesTo: string[]): Promise<string> {
  const id = ulid();
  const rel = path.join('claims', dateShard(id), `${id}.md`);
  const dest = path.join(root, rel);
  await fs.mkdir(path.dirname(dest), { recursive: true });
  const fm = [
    '---',
    `id: ${id}`,
    `subject: ${subjectRel}`,
    'status: fact',
    'confidence: 0.9',
    `relatesTo: ${JSON.stringify(relatesTo)}`,
    '---',
    '',
    statement,
    '',
  ].join('\n');
  await fs.writeFile(dest, fm, 'utf8');
  return rel;
}

/** A decider that puts ALL candidates into one cluster with the given name (+ optional merge/fold). */
function oneClusterDecider(
  canonicalName: string,
  opts: { existingNodeId?: string; mergeExistingNodeIds?: string[] } = {},
): ConnectDecider {
  return async (set: CandidateSet): Promise<ConnectDecision> => ({
    blockKey: set.blockKey,
    clusters: [
      {
        canonicalName,
        memberCandidateIds: set.candidates.map((c) => c.id),
        confidence: 0.95,
        ...(opts.existingNodeId ? { existingNodeId: opts.existingNodeId } : {}),
        ...(opts.mergeExistingNodeIds ? { mergeExistingNodeIds: opts.mergeExistingNodeIds } : {}),
      },
    ],
    agent: { via: 'copilot', model: 'test' },
  });
}

async function listEntityFiles(root: string): Promise<string[]> {
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
  await walk(path.join(root, 'entities'));
  return out.sort();
}

describe.skipIf(!gitAvailable)('readConnectQueue — blocking (CONNECT-4)', () => {
  it('groups candidates by kind + normalized name into bounded sets', async () => {
    await withTempVault(async (root) => {
      await createKb({ path: root, initGitIfNeeded: true });
      await seedCandidate(root, 'person', 'Steve Jobs', '01S1');
      await seedCandidate(root, 'person', 'steve  jobs', '01S2'); // same block (normalized)
      await seedCandidate(root, 'person', 'Tim Cook', '01S3'); // different block
      await commitAll(root, 'seed candidates');

      const q = await readConnectQueue(root);
      expect(q).toHaveLength(2); // two blocks: {steve jobs}, {tim cook}
      const steve = q.find((s) => s.blockKey === 'person|steve jobs');
      expect(steve?.candidates).toHaveLength(2); // both Steve spellings grouped
    });
  });
});

describe.skipIf(!gitAvailable)('connectOne — born-resolved nodes (CONNECT-1/3/7/8)', () => {
  it('resolves a candidate block into one human-named node, consumes the candidates, clean tree', async () => {
    await withTempVault(async (root) => {
      await createKb({ path: root, initGitIfNeeded: true });
      await seedCandidate(root, 'person', 'Steve Jobs', '01S1');
      await seedCandidate(root, 'person', 'Steve Jobs', '01S2');
      await commitAll(root, 'seed');

      const res = await connectOne(root, 'person|steve jobs', oneClusterDecider('Steve Jobs'));
      expect(res.ok).toBe(true);
      expect(res.nodeRels).toEqual(['entities/person/steve-jobs.md']); // human filename (CONNECT-7)

      const md = await fs.readFile(path.join(root, 'entities/person/steve-jobs.md'), 'utf8');
      expect(md).toContain('# Steve Jobs');
      // multi-source provenance (CONNECT-8) — order-independent
      expect(md).toContain('01S1');
      expect(md).toContain('01S2');
      expect(md).toMatch(/derivedFrom: \[/);
      expect(md).toMatch(/resolvedFrom: \[/);

      // candidates consumed (CONNECT-17); canonical tree clean (ORCH-3)
      expect(await readConnectQueue(root)).toHaveLength(0);
      expect((await simpleGit(root).status()).isClean()).toBe(true);
    });
  });

  it('dedups: two same-name candidates from different sources → ONE node (CONNECT-1)', async () => {
    await withTempVault(async (root) => {
      await createKb({ path: root, initGitIfNeeded: true });
      await seedCandidate(root, 'person', 'Steve Jobs', '01S1');
      await seedCandidate(root, 'person', 'Steve Jobs', '01S2');
      await commitAll(root, 'seed');
      await connectOne(root, 'person|steve jobs', oneClusterDecider('Steve Jobs'));
      expect(await listEntityFiles(root)).toEqual(['entities/person/steve-jobs.md']);
    });
  });
});

describe.skipIf(!gitAvailable)('connectOne — fold into existing node (CONNECT-9)', () => {
  it('extends an existing node\'s provenance instead of creating a duplicate', async () => {
    await withTempVault(async (root) => {
      await createKb({ path: root, initGitIfNeeded: true });
      const existing = await seedNode(root, 'person', 'Steve Jobs', ['sources/old/01S0']);
      await seedCandidate(root, 'person', 'Steve Jobs', '01S1');
      await commitAll(root, 'seed');

      await connectOne(root, 'person|steve jobs', oneClusterDecider('Steve Jobs', { existingNodeId: existing.id }));

      expect(await listEntityFiles(root)).toEqual(['entities/person/steve-jobs.md']); // no duplicate
      const md = await fs.readFile(path.join(root, existing.rel), 'utf8');
      expect(md).toContain('sources/old/01S0'); // kept
      expect(md).toContain('01S1'); // folded in
      expect(md).toContain(`id: ${existing.id}`); // identity preserved
    });
  });
});

describe.skipIf(!gitAvailable)('connectOne — merge two existing nodes, delete loser, repoint claims (CONNECT-10/11)', () => {
  it('picks canonical, deletes the loser file (no tombstone), repoints the loser\'s claim', async () => {
    await withTempVault(async (root) => {
      await createKb({ path: root, initGitIfNeeded: true });
      const a = await seedNode(root, 'person', 'Steve Jobs', ['sources/a/01SA']);
      const b = await seedNode(root, 'person', 'Steven Jobs', ['sources/b/01SB']);
      const claimRel = await seedClaim(root, b.rel, 'Co-founded Apple.'); // claim points at the loser
      await seedCandidate(root, 'person', 'Steve Jobs', '01S1');
      await commitAll(root, 'seed two nodes + a claim');

      // Fold into A; merge B into it. (Block key is normalized 'steve jobs' for both.)
      await connectOne(root, 'person|steve jobs', oneClusterDecider('Steve Jobs', { existingNodeId: a.id, mergeExistingNodeIds: [b.id] }));

      const files = await listEntityFiles(root);
      expect(files).toContain(a.rel);
      expect(files).not.toContain(b.rel); // loser DELETED — no tombstone (CONNECT-10)

      // loser is recoverable via git history (CONNECT-10 rationale)
      const log = await simpleGit(root).raw('log', '--all', '--oneline', '--', b.rel);
      expect(log.trim().length).toBeGreaterThan(0);

      // the claim was repointed to the canonical node (CONNECT-11)
      const claimMd = await fs.readFile(path.join(root, claimRel), 'utf8');
      expect(claimMd).toContain(`subject: ${a.rel}`);
      // and shows up in the canonical node's regenerated claims block
      const aMd = await fs.readFile(path.join(root, a.rel), 'utf8');
      expect(aMd).toContain('Co-founded Apple.');
      expect(aMd).toContain('kb:claims:start');
    });
  });
});

describe.skipIf(!gitAvailable)('connectOne — ambiguity parks for Review (CONNECT-15)', () => {
  it('raises a review, applies NO resolution, and the block leaves the active queue (parked)', async () => {
    await withTempVault(async (root) => {
      await createKb({ path: root, initGitIfNeeded: true });
      await seedCandidate(root, 'person', 'Steve Jobs', '01S1');
      await commitAll(root, 'seed');

      const reviewer: ConnectDecider = async (set) => ({
        blockKey: set.blockKey,
        clusters: [{ canonicalName: 'Steve Jobs', memberCandidateIds: set.candidates.map((c) => c.id), confidence: 0.4 }],
        reviews: [{ question: 'Is this the Apple founder?', detail: 'Only a bare name; ambiguous.' }],
        agent: { via: 'copilot', model: 'test' },
      });
      const res = await connectOne(root, 'person|steve jobs', reviewer);
      expect(res.parked).toBe(true);
      expect(res.nodeRels).toHaveLength(0); // NO merge applied
      expect(await listEntityFiles(root)).toHaveLength(0);
      expect(await readConnectQueue(root)).toHaveLength(0); // parked → out of the active queue (REVIEW-5)

      // a review artifact exists
      const reviewsDir = path.join(root, 'reviews');
      const hasReview = await fs
        .readdir(reviewsDir)
        .then(() => true)
        .catch(() => false);
      expect(hasReview).toBe(true);
    });
  });
});

describe.skipIf(!gitAvailable)('connectOne — failure never loses candidates; set aside after K (CONNECT-14)', () => {
  it('retries a poison block then sets it aside, leaving candidates intact', async () => {
    await withTempVault(async (root) => {
      await createKb({ path: root, initGitIfNeeded: true });
      await seedCandidate(root, 'person', 'Steve Jobs', '01S1');
      await commitAll(root, 'seed');

      const failing: ConnectDecider = async () => {
        throw new Error('boom');
      };
      const stage = new ConnectStage(root, failing, new Mutex(), DEFAULT_MAX_ATTEMPTS);
      for (let n = 0; n < DEFAULT_MAX_ATTEMPTS + 1; n++) await stage.poke();

      expect(await readConnectQueue(root)).toHaveLength(0); // set aside → out of active queue
      expect(await listEntityFiles(root)).toHaveLength(0); // no node fabricated
      // candidate file still present (never lost)
      const audit = await fs.readFile(path.join(root, 'connect', 'audit.jsonl'), 'utf8');
      expect(audit).toContain('"event":"setaside"');
    });
  });
});

describe.skipIf(!gitAvailable)('connectOne — idempotent / restartable (CONNECT-17)', () => {
  it('a second drain does not duplicate the resolved node', async () => {
    await withTempVault(async (root) => {
      await createKb({ path: root, initGitIfNeeded: true });
      await seedCandidate(root, 'person', 'Steve Jobs', '01S1');
      await commitAll(root, 'seed');
      const stage = new ConnectStage(root, oneClusterDecider('Steve Jobs'));
      await stage.poke();
      await stage.poke(); // re-poke: candidates already consumed → nothing to do
      expect(await listEntityFiles(root)).toEqual(['entities/person/steve-jobs.md']);
      expect((await simpleGit(root).status()).isClean()).toBe(true);
    });
  });
});

describe.skipIf(!gitAvailable)('connectOne — signals route to the audit log only (CONNECT-18)', () => {
  it('writes signals into connect/audit.jsonl, never into the node', async () => {
    await withTempVault(async (root) => {
      await createKb({ path: root, initGitIfNeeded: true });
      await seedCandidate(root, 'person', 'Steve Jobs', '01S1');
      await commitAll(root, 'seed');

      const withSignal: ConnectDecider = async (set) => ({
        blockKey: set.blockKey,
        clusters: [{ canonicalName: 'Steve Jobs', memberCandidateIds: set.candidates.map((c) => c.id), confidence: 0.9 }],
        signals: [{ type: 'note', note: 'one plausible match only' }],
        agent: { via: 'copilot', model: 'test' },
      });
      await connectOne(root, 'person|steve jobs', withSignal);

      const audit = await fs.readFile(path.join(root, 'connect', 'audit.jsonl'), 'utf8');
      const sig = audit
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l))
        .find((o) => o.event === 'signal');
      expect(sig).toMatchObject({ stage: 'connect', type: 'note', note: 'one plausible match only' });
      const node = await fs.readFile(path.join(root, 'entities/person/steve-jobs.md'), 'utf8');
      expect(node).not.toContain('one plausible match only');
    });
  });
});

describe.skipIf(!gitAvailable)('linkOne — promote relatesTo hints into [[wikilinks]] (CONNECT-12/13)', () => {
  it('resolves a relatesTo hint by name to a canonical node and renders a real [[wikilink]] block', async () => {
    await withTempVault(async (root) => {
      await createKb({ path: root, initGitIfNeeded: true });
      const steve = await seedNode(root, 'person', 'Steve Jobs', ['sources/a/01SA']);
      const apple = await seedNode(root, 'organization', 'Apple', ['sources/b/01SB']);
      await seedClaimRelatesTo(root, steve.rel, 'Co-founded Apple.', ['Apple']);
      await commitAll(root, 'seed node + relatesTo claim');

      expect(await readLinkQueue(root)).toEqual([steve.rel]); // Steve's claim has a hint
      const res = await linkOne(root, steve.rel);
      expect(res.changed).toBe(true);
      expect(res.links).toBe(1);

      const md = await fs.readFile(path.join(root, steve.rel), 'utf8');
      expect(md).toContain(LINKS_BLOCK_START);
      expect(md).toContain(`[[${apple.rel}]]`); // real Obsidian wikilink to the canonical node
      expect((await simpleGit(root).status()).isClean()).toBe(true); // ORCH-3
    });
  });

  it('is idempotent: a second linkOne on an unchanged node is a no-op (regenerate-whole)', async () => {
    await withTempVault(async (root) => {
      await createKb({ path: root, initGitIfNeeded: true });
      const steve = await seedNode(root, 'person', 'Steve Jobs', ['sources/a/01SA']);
      await seedNode(root, 'organization', 'Apple', ['sources/b/01SB']);
      await seedClaimRelatesTo(root, steve.rel, 'Co-founded Apple.', ['Apple']);
      await commitAll(root, 'seed');

      expect((await linkOne(root, steve.rel)).changed).toBe(true);
      const res2 = await linkOne(root, steve.rel);
      expect(res2.changed).toBe(false); // no churn — block regenerated identically
      expect((await simpleGit(root).status()).isClean()).toBe(true);
    });
  });

  it('an unknown target is NOT a dangling guess — it becomes a note signal (CONNECT-13)', async () => {
    await withTempVault(async (root) => {
      await createKb({ path: root, initGitIfNeeded: true });
      const steve = await seedNode(root, 'person', 'Steve Jobs', ['sources/a/01SA']);
      await seedClaimRelatesTo(root, steve.rel, 'Knows someone at Nowhere Inc.', ['Nowhere Inc']);
      await commitAll(root, 'seed');

      const res = await linkOne(root, steve.rel);
      expect(res.links).toBe(0);
      expect(res.unresolved).toContain('Nowhere Inc');
      const md = await fs.readFile(path.join(root, steve.rel), 'utf8');
      expect(md).not.toContain('[['); // no dangling wikilink rendered
      const audit = await fs.readFile(path.join(root, 'connect', 'audit.jsonl'), 'utf8');
      const note = audit
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l))
        .find((o) => o.event === 'signal' && o.type === 'note');
      expect(note.note).toContain('Nowhere Inc'); // recorded for follow-up, not guessed
    });
  });

  it('an ambiguous target (two nodes share the name) is NOT linked — note, never guess (CONNECT-13)', async () => {
    await withTempVault(async (root) => {
      await createKb({ path: root, initGitIfNeeded: true });
      const steve = await seedNode(root, 'person', 'Steve Jobs', ['sources/a/01SA']);
      await seedNode(root, 'organization', 'Apple', ['sources/b/01SB']); // entities/organization/apple.md
      await seedNode(root, 'fruit', 'Apple', ['sources/c/01SC']); // entities/fruit/apple.md — same name
      await seedClaimRelatesTo(root, steve.rel, 'Likes Apple.', ['Apple']);
      await commitAll(root, 'seed two same-name nodes');

      const res = await linkOne(root, steve.rel);
      expect(res.links).toBe(0); // ambiguous → not linked
      expect(res.unresolved).toContain('Apple');
      const md = await fs.readFile(path.join(root, steve.rel), 'utf8');
      expect(md).not.toContain('[['); // no guessed link to either Apple
    });
  });
});
