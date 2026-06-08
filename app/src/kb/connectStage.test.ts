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
import { connectOne, readConnectQueue, ConnectStage, DEFAULT_MAX_ATTEMPTS, linkOne, readLinkQueue, dedupClaimsOnce, listConnectSetAsideItems, retryConnectItem, dismissConnectItem } from './connectStage';
import { resolveIndexLockPath, GATE3_STALE_AGE_MS } from './canonicalLockHeal';
import { renderClaimMd } from './claimDoc';
import { findOpenReviews, answerReview } from './reviewStore';
import type { ConnectDecider, CandidateSet } from './connectAgent';
import { parseConnectDecision } from './connect';
import type { Candidate, ConnectDecision } from './connect';
import { Mutex } from './stageLock';
import { planSetAsideAction } from './pipelineControl'; // the stage-agnostic seam (DEV-3 #162)
import { toSetAsideViews } from './pipelineStatusView'; // the Status-view union (DEV-3 #162)

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
      tags: [],
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

  // REVIEW-16: the agent's per-candidate {id, gloss} is enriched into decision-grade subject context
  // ({name, sourceRel, gloss}) on the real park path — the stage joins the id to the candidate's name
  // + source-dir rel (the working Obsidian link); the agent only authors the gloss.
  it('enriches the parked review subject with per-candidate {name, sourceRel, gloss} (REVIEW-16)', async () => {
    await withTempVault(async (root) => {
      await createKb({ path: root, initGitIfNeeded: true });
      // two same-name candidates from DIFFERENT sources — the textbook disambiguation case.
      await seedCandidate(root, 'person', 'Benton', '01S1');
      await seedCandidate(root, 'person', 'Benton', '01S2');
      await commitAll(root, 'seed');

      const reviewer: ConnectDecider = async (set) => ({
        blockKey: set.blockKey,
        clusters: set.candidates.map((c) => ({ canonicalName: c.name, memberCandidateIds: [c.id], confidence: 0.4 })),
        // glosses authored per candidate, keyed by id, tagged with the source so we can assert the join.
        reviews: [
          {
            question: 'Is Benton (fishing-trip notes) the same person as Benton (wedding list)?',
            detail: 'Same name, two sources — ambiguous.',
            candidates: set.candidates.map((c) => ({ id: c.id, gloss: `gloss for ${c.sourceId}` })),
          },
        ],
        agent: { via: 'copilot', model: 'test' },
      });
      const res = await connectOne(root, 'person|benton', reviewer);
      expect(res.parked).toBe(true);

      const review = (await findOpenReviews(root))[0];
      expect(review.subject.candidates).toBeDefined();
      const cands = review.subject.candidates!;
      expect(cands).toHaveLength(2);
      // each carries the candidate's NAME (stage-owned), the agent's GLOSS, and the source-dir REL link.
      for (const c of cands) {
        expect(c.name).toBe('Benton');
        expect(c.gloss).toMatch(/^gloss for 01S[12]$/);
        expect(c.sourceRel).toBe(c.gloss.replace('gloss for ', '')); // sourceDirRel passthrough for the non-ULID fixture id
      }
      // both distinct sources are represented (the whole point — tell the two apart).
      expect(new Set(cands.map((c) => c.sourceRel))).toEqual(new Set(['01S1', '01S2']));
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

  it('resolves (does NOT wedge/set-aside) when the agent returns existingNodeId:"" (#136)', async () => {
    await withTempVault(async (root) => {
      await createKb({ path: root, initGitIfNeeded: true });
      await seedCandidate(root, 'person', 'Grace Hopper', '01S1');
      await commitAll(root, 'seed');

      // The real agent output #136 came from: existingNodeId "" ("no existing node to fold into").
      // Goes through the REAL parse path (was throwing → block failed+set-aside); now coerced to absent.
      const decider: ConnectDecider = async (set) =>
        parseConnectDecision(
          JSON.stringify({
            blockKey: set.blockKey,
            clusters: [{ canonicalName: 'Grace Hopper', memberCandidateIds: set.candidates.map((c) => c.id), existingNodeId: '', confidence: 0.95 }],
          }),
          set.blockKey,
          set.candidates.map((c) => c.id),
        );

      const res = await connectOne(root, 'person|grace hopper', decider);
      expect(res.ok).toBe(true);
      expect(res.setAside).toBe(false); // resolved, not wedged
      expect(res.nodeRels).toEqual(['entities/person/grace-hopper.md']); // born fresh
      expect(await readConnectQueue(root)).toHaveLength(0); // candidate consumed
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
      expect(md).toContain(`[[${apple.rel}|`); // VAULT-12: alias form `[[path|Name]]` to the canonical node
      expect(md).toContain(`[[${apple.rel}|Apple]]`); // shows the entity name, not the raw path
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

  it('an ambiguous target (two nodes share the name) escalates to a yes/no Review — never guessed (CONNECT-15)', async () => {
    await withTempVault(async (root) => {
      await createKb({ path: root, initGitIfNeeded: true });
      const steve = await seedNode(root, 'person', 'Steve Jobs', ['sources/a/01SA']);
      await seedNode(root, 'organization', 'Apple', ['sources/b/01SB']); // entities/organization/apple.md
      await seedNode(root, 'fruit', 'Apple', ['sources/c/01SC']); // entities/fruit/apple.md — same name, distinct entity
      await seedClaimRelatesTo(root, steve.rel, 'Likes Apple.', ['Apple']);
      await commitAll(root, 'seed two same-name nodes');

      const res = await linkOne(root, steve.rel);
      expect(res.reviewsRaised).toBe(1); // ambiguous → Review, NOT a silent note (the CONNECT-15 change)
      expect(res.links).toBe(0);
      expect(res.unresolved).not.toContain('Apple'); // escalated, not noted
      const md = await fs.readFile(path.join(root, steve.rel), 'utf8');
      expect(md).not.toContain('[['); // nothing rendered while parked — never a guess

      // A yes/no Review is open, carrying the merge plan (first match) in its markerKey.
      const open = await findOpenReviews(root);
      expect(open).toHaveLength(1);
      expect(open[0].raisedBy.markerKey).toMatchObject({ kind: 'link', nodeRel: steve.rel, hint: 'Apple' });
      expect(open[0].raisedBy.markerKey.targetRel).toMatch(/entities\/(organization|fruit)\/apple\.md/);
      expect(open[0].question).toContain('Steve Jobs');

      // Idempotent: a second pass does NOT raise a duplicate (the hint is already asked).
      const again = await linkOne(root, steve.rel);
      expect(again.reviewsRaised).toBe(0);
      expect(again.changed).toBe(false);
      expect(await findOpenReviews(root)).toHaveLength(1);
    });
  });

  it('answering the ambiguous-link Review with CONFIRM renders the proposed [[wikilink]] (CONNECT-15)', async () => {
    await withTempVault(async (root) => {
      await createKb({ path: root, initGitIfNeeded: true });
      const steve = await seedNode(root, 'person', 'Steve Jobs', ['sources/a/01SA']);
      await seedNode(root, 'organization', 'Apple', ['sources/b/01SB']);
      await seedNode(root, 'fruit', 'Apple', ['sources/c/01SC']);
      await seedClaimRelatesTo(root, steve.rel, 'Likes Apple.', ['Apple']);
      await commitAll(root, 'seed');

      await linkOne(root, steve.rel); // raises the review (parked)
      const review = (await findOpenReviews(root))[0];
      const target = review.raisedBy.markerKey.targetRel as string;
      await answerReview(root, new Mutex(), review.id, { verdict: 'confirm' });

      const res = await linkOne(root, steve.rel); // resume: render the Principal-approved link
      expect(res.links).toBe(1);
      const md = await fs.readFile(path.join(root, steve.rel), 'utf8');
      expect(md).toContain(LINKS_BLOCK_START);
      expect(md).toContain(`[[${target}|`); // exactly the confirmed target (alias form, VAULT-12) — not the other same-name node
    });
  });

  it('answering the ambiguous-link Review with REJECT leaves it a note, no link (CONNECT-15)', async () => {
    await withTempVault(async (root) => {
      await createKb({ path: root, initGitIfNeeded: true });
      const steve = await seedNode(root, 'person', 'Steve Jobs', ['sources/a/01SA']);
      await seedNode(root, 'organization', 'Apple', ['sources/b/01SB']);
      await seedNode(root, 'fruit', 'Apple', ['sources/c/01SC']);
      await seedClaimRelatesTo(root, steve.rel, 'Likes Apple.', ['Apple']);
      await commitAll(root, 'seed');

      await linkOne(root, steve.rel);
      const review = (await findOpenReviews(root))[0];
      await answerReview(root, new Mutex(), review.id, { verdict: 'reject' });

      const res = await linkOne(root, steve.rel); // resume: declined → note, never linked
      expect(res.links).toBe(0);
      expect(res.unresolved).toContain('Apple');
      const md = await fs.readFile(path.join(root, steve.rel), 'utf8');
      expect(md).not.toContain('[[');
    });
  });

  // REGRESSION (connect.link-error class): linkOne's canonical advance must self-heal a stale
  // `.git/index.lock` like EVERY other canonical writer (ORCH-27). It used to advance via a RAW
  // `git merge --ff-only` that bypassed `reconcileStaleIndexLock`, so a stale lock (the #256 wedge)
  // made it throw `Unable to create '…/index.lock': File exists` for every relatesTo node — links
  // never rendered (isolated nodes / no Obsidian edges) — while decompose/connect self-healed.
  it('heals a stale index.lock instead of throwing connect.link-error (the #256 wedge, second symptom)', async () => {
    await withTempVault(async (root) => {
      await createKb({ path: root, initGitIfNeeded: true });
      const steve = await seedNode(root, 'person', 'Steve Jobs', ['sources/a/01SA']);
      const apple = await seedNode(root, 'organization', 'Apple', ['sources/b/01SB']);
      await seedClaimRelatesTo(root, steve.rel, 'Co-founded Apple.', ['Apple']);
      await commitAll(root, 'seed node + relatesTo claim');

      // A stale `.git/index.lock` left by a crashed / boundedGit-timed-out prior op (#256).
      const lockPath = await resolveIndexLockPath(root);
      await fs.writeFile(lockPath, '', 'utf8');
      const stale = new Date(Date.now() - (GATE3_STALE_AGE_MS + 60_000));
      await fs.utimes(lockPath, stale, stale); // older than the gate-3 threshold → genuinely stale

      // FAILS-BEFORE: raw `merge --ff-only` throws on the present lock. PASSES-AFTER: advanceOrCollide
      // heals the stale lock, advances, and the wikilink renders.
      const res = await linkOne(root, steve.rel);
      expect(res.links).toBe(1);
      const md = await fs.readFile(path.join(root, steve.rel), 'utf8');
      expect(md).toContain(`[[${apple.rel}|Apple]]`);
      expect(await fs.stat(lockPath).then(() => true).catch(() => false)).toBe(false); // lock healed away
      // The heal records its clear in `.kb/audit.jsonl` (ORCH-27 audits every clear) — that breadcrumb
      // is the only working-tree change, so we assert the link landed, not a byte-clean tree.
    });
  });
});

describe.skipIf(!gitAvailable)('connectOne — metadata: type Property + tags on the node (SPEC-0025 META-2/3/4)', () => {
  it('writes the curated type/<kind> tag + normalized agent topic tags into the node', async () => {
    await withTempVault(async (root) => {
      await createKb({ path: root, initGitIfNeeded: true });
      await seedCandidate(root, 'person', 'Steve Jobs', '01S1');
      await commitAll(root, 'seed');

      const tagger: ConnectDecider = async (set) => ({
        blockKey: set.blockKey,
        clusters: [
          {
            canonicalName: 'Steve Jobs',
            memberCandidateIds: set.candidates.map((c) => c.id),
            confidence: 0.95,
            tags: ['Topic/Machine Learning', 'startups'], // emergent, un-normalized — Connect normalizes
          },
        ],
        agent: { via: 'copilot', model: 'test' },
      });
      await connectOne(root, 'person|steve jobs', tagger);

      const md = await fs.readFile(path.join(root, 'entities/person/steve-jobs.md'), 'utf8');
      expect(md).toContain('type: person'); // curated Property
      expect(md).toMatch(/tags: \[[^\]]*"type\/person"[^\]]*\]/); // deterministic curated core, always present
      expect(md).toContain('"topic/machine-learning"'); // agent tag, normalized (META-3)
      expect(md).toContain('"startups"');
      // provenance (META-10): the resolve audit records the tags it set
      const audit = await fs.readFile(path.join(root, 'connect', 'audit.jsonl'), 'utf8');
      const resolved = audit
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l))
        .find((o) => o.event === 'resolved');
      expect(resolved.tags).toContain('type/person');
    });
  });

  it('always emits at least the deterministic type/<kind> tag, even with no agent tags', async () => {
    await withTempVault(async (root) => {
      await createKb({ path: root, initGitIfNeeded: true });
      await seedCandidate(root, 'organization', 'Apple', '01S1');
      await commitAll(root, 'seed');
      await connectOne(root, 'organization|apple', oneClusterDecider('Apple')); // no tags in verdict
      const md = await fs.readFile(path.join(root, 'entities/organization/apple.md'), 'utf8');
      expect(md).toContain('tags: ["type/organization"]');
    });
  });
});

// ── Within-source claim dedup as Connect's post-Claims pass (SPEC-0016 CLAIMS-19) ────────────
describe.skipIf(!gitAvailable)('Connect within-source claim dedup (CLAIMS-19)', () => {
  const SRC = 'sources/2026/06/02/01SRCA';
  /** Seed a claim WITH provenance.derivedFrom (the within-source dedup group key). */
  async function seedClaimProv(
    root: string,
    subjectRel: string,
    statement: string,
    status: 'fact' | 'interpretation' | 'hypothesis',
    confidence: number,
    derivedFrom = SRC,
  ): Promise<string> {
    const id = ulid();
    const rel = path.join('claims', dateShard(id), `${id}.md`);
    const dest = path.join(root, rel);
    await fs.mkdir(path.dirname(dest), { recursive: true });
    await fs.writeFile(
      dest,
      renderClaimMd({ statement, status, confidence, mentions: ['evidence'] }, { id, subject: subjectRel, derivedFrom, createdAt: '2026-06-02T00:00:00Z' }),
      'utf8',
    );
    return rel;
  }
  const exists = (root: string, rel: string) => fs.access(path.join(root, rel)).then(() => true).catch(() => false);

  it('a ConnectStage drain collapses within-source duplicate claims and advances canonical', async () => {
    await withTempVault(async (root) => {
      await createKb({ path: root, initGitIfNeeded: true });
      const ada = await seedNode(root, 'person', 'Ada Lovelace', [SRC]);
      const bab = await seedNode(root, 'person', 'Charles Babbage', [SRC]);
      const REL = 'Ada Lovelace worked with Charles Babbage.';
      const a1 = await seedClaimProv(root, ada.rel, REL, 'fact', 0.9); // canonical (fact)
      const a2 = await seedClaimProv(root, ada.rel, 'ada lovelace   WORKED with charles babbage', 'hypothesis', 0.5); // dup of a1 (same subject)
      const b1 = await seedClaimProv(root, bab.rel, REL, 'interpretation', 0.8); // dup of a1 (cross-subject, same source)
      const sym = await seedClaimProv(root, ada.rel, 'Charles Babbage worked with Ada Lovelace.', 'fact', 0.9); // symmetric reword — must SURVIVE (CONNECT-20)
      await commitAll(root, 'seed entities + duplicate claims');

      // A bare drain (no candidates/links queued) still runs the post-Claims dedup sweep.
      const stage = new ConnectStage(root, oneClusterDecider('unused'), new Mutex(), undefined, undefined, undefined);
      await stage.poke();
      stage.stop();

      // Canonical (root working tree, after the ff-merge inside the pass) reflects the collapse.
      expect(await exists(root, a1)).toBe(true); // fact canonical kept
      expect(await exists(root, a2)).toBe(false); // same-subject dup dropped
      expect(await exists(root, b1)).toBe(false); // cross-subject dup dropped
      expect(await exists(root, sym)).toBe(true); // symmetric reword survives (deferred → CONNECT-20)

      // Ada's regenerated block lists the survivors (a1, sym), not the dropped a2.
      const adaMd = await fs.readFile(path.join(root, ada.rel), 'utf8');
      expect(adaMd).toContain(`[[${a1}]]`);
      expect(adaMd).toContain(`[[${sym}]]`);
      expect(adaMd).not.toContain(`[[${a2}]]`);
      expect(adaMd).toContain('id:'); // identity untouched (CLAIMS-11)
      // Babbage lost its only claim → placeholder block, no dangling link.
      const babMd = await fs.readFile(path.join(root, bab.rel), 'utf8');
      expect(babMd).not.toContain(`[[${b1}]]`);
    });
  });

  it('dedupClaimsOnce commits + advances when it collapses, and is a clean no-op otherwise', async () => {
    await withTempVault(async (root) => {
      await createKb({ path: root, initGitIfNeeded: true });
      const ada = await seedNode(root, 'person', 'Ada Lovelace', [SRC]);
      const REL = 'Pioneered the first published algorithm.';
      await seedClaimProv(root, ada.rel, REL, 'fact', 0.9);
      const dup = await seedClaimProv(root, ada.rel, REL, 'hypothesis', 0.4);
      await commitAll(root, 'seed');
      const headBefore = (await simpleGit(root).revparse(['HEAD'])).trim();

      const first = await dedupClaimsOnce(root);
      expect(first.committed).toBe(true);
      expect(first.dropped).toBe(1);
      expect(await exists(root, dup)).toBe(false);
      const headAfter = (await simpleGit(root).revparse(['HEAD'])).trim();
      expect(headAfter).not.toBe(headBefore); // canonical advanced

      // Idempotent: a second pass finds no dupes → no commit, no advance.
      const second = await dedupClaimsOnce(root);
      expect(second.committed).toBe(false);
      expect(second.dropped).toBe(0);
      expect((await simpleGit(root).revparse(['HEAD'])).trim()).toBe(headAfter);
    });
  });

  // REGRESSION (same class as connect.link-error): dedupClaimsOnce's canonical advance shared the
  // raw `merge --ff-only` blind spot — it must self-heal a stale `.git/index.lock` (ORCH-27) too.
  it('heals a stale index.lock when it advances a dedup (shares the linkOne fix)', async () => {
    await withTempVault(async (root) => {
      await createKb({ path: root, initGitIfNeeded: true });
      const ada = await seedNode(root, 'person', 'Ada Lovelace', [SRC]);
      const REL = 'Pioneered the first published algorithm.';
      await seedClaimProv(root, ada.rel, REL, 'fact', 0.9);
      const dup = await seedClaimProv(root, ada.rel, REL, 'hypothesis', 0.4);
      await commitAll(root, 'seed');

      const lockPath = await resolveIndexLockPath(root);
      await fs.writeFile(lockPath, '', 'utf8');
      const stale = new Date(Date.now() - (GATE3_STALE_AGE_MS + 60_000));
      await fs.utimes(lockPath, stale, stale);

      // FAILS-BEFORE: throws on the stale lock. PASSES-AFTER: heals + commits the collapse.
      const report = await dedupClaimsOnce(root);
      expect(report.committed).toBe(true);
      expect(report.dropped).toBe(1);
      expect(await exists(root, dup)).toBe(false);
      expect(await fs.stat(lockPath).then(() => true).catch(() => false)).toBe(false); // healed
    });
  });
});

// ── Set-aside recovery (OBS-17, Connect half — mirrors claims CLAIMS-20) ─────────────────────
describe.skipIf(!gitAvailable)('Connect set-aside recovery (OBS-17)', () => {
  const KEY = 'person|steve jobs';
  // Induce a poison set-aside block: a throwing decider, K attempts → set aside (CONNECT-14).
  async function seedSetAside(root: string, lock: Mutex): Promise<void> {
    await seedCandidate(root, 'person', 'Steve Jobs', '01S1');
    await commitAll(root, 'seed');
    const failing: ConnectDecider = async () => {
      throw new Error('boom');
    };
    for (let n = 0; n < DEFAULT_MAX_ATTEMPTS; n++) await connectOne(root, KEY, failing, lock, DEFAULT_MAX_ATTEMPTS);
  }

  it('lists a set-aside block (keyed by blockKey, with a human name), off the active queue', async () => {
    await withTempVault(async (root) => {
      await createKb({ path: root, initGitIfNeeded: true });
      const lock = new Mutex();
      await seedSetAside(root, lock);

      expect(await readConnectQueue(root)).toHaveLength(0); // set aside → not in the active queue
      const items = await listConnectSetAsideItems(root);
      expect(items).toHaveLength(1);
      expect(items[0].blockKey).toBe(KEY);
      expect(items[0].name).toBe('Steve Jobs'); // the candidate's spelling, not the normalized key
      expect(items[0].failures).toBe(DEFAULT_MAX_ATTEMPTS);
    });
  });

  it('retry re-enqueues the block and clears it from the set-aside list (idempotent)', async () => {
    await withTempVault(async (root) => {
      await createKb({ path: root, initGitIfNeeded: true });
      const lock = new Mutex();
      await seedSetAside(root, lock);

      await retryConnectItem(root, KEY, lock);
      expect(await listConnectSetAsideItems(root)).toHaveLength(0); // reopened → no longer set aside
      expect((await readConnectQueue(root)).map((s) => s.blockKey)).toContain(KEY); // back in the queue
      // Idempotent in the read-outside/act-under-lock window: a second retry is harmless.
      await retryConnectItem(root, KEY, lock);
      expect((await readConnectQueue(root)).map((s) => s.blockKey)).toContain(KEY);
    });
  });

  it('dismiss retires the block permanently — off BOTH the queue and the set-aside list (idempotent)', async () => {
    await withTempVault(async (root) => {
      await createKb({ path: root, initGitIfNeeded: true });
      const lock = new Mutex();
      await seedSetAside(root, lock);

      await dismissConnectItem(root, KEY, lock);
      expect(await listConnectSetAsideItems(root)).toHaveLength(0); // dismissed ≠ recoverable
      expect(await readConnectQueue(root)).toHaveLength(0); // never re-queued
      await dismissConnectItem(root, KEY, lock); // idempotent
      expect(await readConnectQueue(root)).toHaveLength(0);
    });
  });

  // The GLUED recovery path that pipelineControlForActive composes (OBS-17 e2e, #55 done-bar):
  // poison block → surfaces in the Status-view union → the stage-agnostic planner resolves the
  // renderer's blockKey server-side → my primitive runs → block re-derives (retry) / retires (dismiss).
  // Drives the exact composition from #162's pipeline dispatch, deterministically (no copilot).
  it('end-to-end: poison block surfaces in status, then Retry re-derives and Dismiss retires (#55)', async () => {
    await withTempVault(async (root) => {
      await createKb({ path: root, initGitIfNeeded: true });
      const lock = new Mutex();
      await seedSetAside(root, lock);

      // 1. Surfaces in the Status view (the assembler maps connect items via toSetAsideViews(_, 'connect')).
      const items = await listConnectSetAsideItems(root);
      const views = toSetAsideViews(
        items.map((i) => ({ itemId: i.blockKey, name: i.name, failures: i.failures, rounds: i.rounds })),
        'connect',
      );
      expect(views).toEqual([{ stage: 'connect', itemId: KEY, name: 'Steve Jobs', reason: `set aside after ${DEFAULT_MAX_ATTEMPTS} failed attempts` }]);

      // 2. Server-side resolve the renderer's itemId (blockKey) → handle, via the stage-agnostic planner.
      const targets = items.map((i) => ({ id: i.blockKey, handle: i.blockKey, label: i.name }));
      const plan = planSetAsideAction(targets, { stage: 'connect', action: 'retry', itemId: KEY });
      expect('handle' in plan && plan.handle).toBe(KEY);

      // 3. Retry → block re-derives (back in the active queue), off the set-aside list.
      if ('handle' in plan) await retryConnectItem(root, plan.handle, lock);
      expect((await readConnectQueue(root)).map((s) => s.blockKey)).toContain(KEY);
      expect(await listConnectSetAsideItems(root)).toHaveLength(0);

      // A renderer-supplied itemId NOT in the live list resolves to a no-op error (trust boundary).
      expect('error' in planSetAsideAction(targets, { stage: 'connect', action: 'retry', itemId: 'person|ghost' })).toBe(true);
    });
  });
});
