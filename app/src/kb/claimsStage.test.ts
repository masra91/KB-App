// Claims stage tests (SPEC-0016 CLAIMS). Real FS + git + worktrees against a throwaway temp
// vault (TEST-18); the deciders are injected so nothing shells out to copilot (TEST-2). The
// pipeline under test: capture → archive → decompose (produce entity nodes) → CLAIMS.
import { describe, it, expect } from 'vitest';
import { promises as fs } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import simpleGit from 'simple-git';
import { makeTempDir, rmTempDir } from '../../test/tempVault';
import { createKb } from './vault';
import { captureToInbox } from './ingest';
import { archiveOne, readQueue } from './orchestrator';
import { deterministicDecider } from './archivist';
import { Mutex } from './stageLock';
import { decomposeOne, DecomposeStage } from './decomposeStage';
import type { DecomposeDecider } from './decomposeAgent';
import { claimsOne, readClaimsQueue, findEntityFiles, parseEntityNode, ClaimsStage, DEFAULT_MAX_ATTEMPTS, DEFAULT_MAX_REVIEW_ROUNDS } from './claimsStage';
import type { ClaimsDecider } from './claimsAgent';
import type { ClaimDecision, ClaimsDecision } from './claims';
import { findOpenReviews, answerReview, getReview } from './reviewStore';

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

/** A decompose decider that mints the given entity names (kind=person). */
function decompDeciderFor(names: string[]): DecomposeDecider {
  return async (input) => ({
    sourceId: input.sourceId,
    entities: names.map((name) => ({ kind: 'person', name, confidence: 0.8, mentions: [name] })),
    agent: { via: 'copilot', model: 'test' },
  });
}

/** A claims decider that returns a fixed claim set (+ optional signals). */
function claimsDeciderFor(claims: ClaimDecision[], signals?: ClaimsDecision['signals']): ClaimsDecider {
  return async (input) => ({ entityId: input.entityId, claims, ...(signals ? { signals } : {}), agent: { via: 'copilot', model: 'test' } });
}

const aClaim = (over: Partial<ClaimDecision> = {}): ClaimDecision => ({
  statement: 'Owns the Q3 budget.',
  status: 'interpretation',
  confidence: 0.7,
  mentions: ['Steve owns the Q3 budget'],
  ...over,
});

/** Capture → archive → decompose one text source into entity nodes; return source + entity rels. */
async function setup(root: string, text: string, names: string[]): Promise<{ srcRel: string; entityRels: string[] }> {
  await captureToInbox(root, 'in-app-panel', [{ kind: 'text', text }]);
  const q = await readQueue(root);
  const srcRel = await archiveOne(root, q[q.length - 1], deterministicDecider);
  await decomposeOne(root, srcRel, decompDeciderFor(names));
  return { srcRel, entityRels: await findEntityFiles(root) };
}

async function readClaimFiles(root: string): Promise<string[]> {
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
      else if (e.name.endsWith('.md')) out.push(await fs.readFile(p, 'utf8'));
    }
  }
  await walk(path.join(root, 'claims'));
  return out;
}

describe('parseEntityNode (CLAIMS-5 — resolves an entity to its whole source)', () => {
  it('extracts kind, name, and derivedFrom, handling quoted scalars', () => {
    const md = '---\nid: 01J\nkind: person\nname: "Q3: budget"\nconfidence: 0.9\nprovenance:\n  derivedFrom: ["sources/2026/05/30/01JSRC"]\n---\n\n# Q3: budget\n';
    expect(parseEntityNode(md)).toEqual({ kind: 'person', name: 'Q3: budget', derivedFrom: 'sources/2026/05/30/01JSRC' });
  });
  it('throws when kind/name are missing', () => {
    expect(() => parseEntityNode('---\nid: x\n---\n')).toThrow(/kind\/name/);
  });
  it('throws when provenance.derivedFrom is missing', () => {
    expect(() => parseEntityNode('---\nkind: person\nname: Steve\n---\n')).toThrow(/derivedFrom/);
  });
});

describe.skipIf(!gitAvailable)('readClaimsQueue (CLAIMS-2/16)', () => {
  it('lists entity nodes that have no terminal claims marker', async () => {
    await withTempVault(async (root) => {
      await createKb({ path: root, initGitIfNeeded: true });
      const { entityRels } = await setup(root, 'call Steve re: Q3 budget', ['Steve', 'Q3 budget']);
      expect(entityRels).toHaveLength(2);
      expect(await readClaimsQueue(root)).toHaveLength(2); // both entities await claims
    });
  });
});

describe.skipIf(!gitAvailable)('claimsOne writes claims with whole-source provenance (CLAIMS-1/5/6/15)', () => {
  it('writes claim files (subject→entity, derivedFrom→whole source) and ff-advances a clean tree', async () => {
    await withTempVault(async (root) => {
      await createKb({ path: root, initGitIfNeeded: true });
      const { srcRel, entityRels } = await setup(root, 'Steve owns the Q3 budget', ['Steve']);
      const res = await claimsOne(root, entityRels[0], claimsDeciderFor([aClaim()]));

      expect(res.ok).toBe(true);
      expect(res.claimIds).toHaveLength(1);
      const claims = await readClaimFiles(root);
      expect(claims).toHaveLength(1);
      expect(claims[0]).toContain(`subject: ${entityRels[0]}`); // single-subject link (CLAIMS-6)
      expect(claims[0]).toContain(`derivedFrom: ["${srcRel}"]`); // CLAIMS-5 whole source
      expect(claims[0]).toContain('status: interpretation');

      expect((await simpleGit(root).status()).isClean()).toBe(true); // ORCH-3 / CLAIMS-15
    });
  });

  it('feeds the agent the WHOLE source text, not just the node spans (CLAIMS-5)', async () => {
    await withTempVault(async (root) => {
      await createKb({ path: root, initGitIfNeeded: true });
      const text = 'Steve owns the Q3 budget. He also visited the Austin site on the 14th.';
      const { entityRels } = await setup(root, text, ['Steve']);
      let seen = '';
      const spy: ClaimsDecider = async (input) => {
        seen = input.source.text ?? '';
        return { entityId: input.entityId, claims: [], agent: { via: 'copilot', model: 'test' } };
      };
      await claimsOne(root, entityRels[0], spy);
      expect(seen).toBe(text); // the whole source, beyond the "Steve" mention span
    });
  });
});

describe.skipIf(!gitAvailable)('the entity node gets a regenerable claims block (CLAIMS-9/11)', () => {
  it('adds a delimited block linking the claim, leaving identity + heading intact', async () => {
    await withTempVault(async (root) => {
      await createKb({ path: root, initGitIfNeeded: true });
      const { entityRels } = await setup(root, 'Steve owns the Q3 budget', ['Steve']);
      const before = await fs.readFile(path.join(root, entityRels[0]), 'utf8');
      const refBefore = parseEntityNode(before);

      await claimsOne(root, entityRels[0], claimsDeciderFor([aClaim()]));
      const after = await fs.readFile(path.join(root, entityRels[0]), 'utf8');

      expect(after).toContain('<!-- kb:claims:start');
      expect(after).toMatch(/\[\[claims\/.+\.md\]\] — Owns the Q3 budget\. \*\(interpretation, 0\.7\)\*/);
      // Identity is untouched (CLAIMS-11): same kind/name/derivedFrom, heading preserved.
      expect(parseEntityNode(after)).toEqual(refBefore);
      expect(after).toContain('# Steve');
    });
  });

  it('is idempotent on re-poke: no duplicate block or claim files (CLAIMS-13/16)', async () => {
    await withTempVault(async (root) => {
      await createKb({ path: root, initGitIfNeeded: true });
      const { entityRels } = await setup(root, 'Steve owns the Q3 budget', ['Steve']);
      await claimsOne(root, entityRels[0], claimsDeciderFor([aClaim()]));
      expect(await readClaimsQueue(root)).toHaveLength(0); // dequeued (commit-to-dequeue)

      // A second drain must not re-claim the entity (terminal marker) or duplicate files.
      const stage = new ClaimsStage(root, claimsDeciderFor([aClaim()]));
      await stage.poke();
      expect(await readClaimFiles(root)).toHaveLength(1);
      const node = await fs.readFile(path.join(root, entityRels[0]), 'utf8');
      expect(node.match(/kb:claims:start/g)).toHaveLength(1);
    });
  });
});

describe.skipIf(!gitAvailable)('sources and entity identity are never mutated (CLAIMS-11)', () => {
  it('leaves source raw + source.md byte-for-byte unchanged', async () => {
    await withTempVault(async (root) => {
      await createKb({ path: root, initGitIfNeeded: true });
      const { srcRel, entityRels } = await setup(root, 'immutable ground truth', ['truth']);
      const rawBefore = await fs.readFile(path.join(root, srcRel, 'raw.md'), 'utf8');
      const mdBefore = await fs.readFile(path.join(root, srcRel, 'source.md'), 'utf8');
      await claimsOne(root, entityRels[0], claimsDeciderFor([aClaim()]));
      expect(await fs.readFile(path.join(root, srcRel, 'raw.md'), 'utf8')).toBe(rawBefore);
      expect(await fs.readFile(path.join(root, srcRel, 'source.md'), 'utf8')).toBe(mdBefore);
    });
  });
});

describe.skipIf(!gitAvailable)('signals route to the audit log only (CLAIMS-13/14)', () => {
  it('writes signals into the source audit.jsonl envelope, never into claims or the entity', async () => {
    await withTempVault(async (root) => {
      await createKb({ path: root, initGitIfNeeded: true });
      const { srcRel, entityRels } = await setup(root, 'Steve owns the Q3 budget', ['Steve']);
      await claimsOne(root, entityRels[0], claimsDeciderFor([aClaim()], [{ type: 'possible-duplicate', note: 'maybe S. Park', refs: ['Steve'] }]));

      const audit = await fs.readFile(path.join(root, srcRel, 'audit.jsonl'), 'utf8');
      const sig = audit.split('\n').map((l) => (l.trim() ? JSON.parse(l) : null)).find((o) => o && o.event === 'signal');
      expect(sig).toMatchObject({ stage: 'claims', entityId: path.basename(entityRels[0], '.md'), event: 'signal', type: 'possible-duplicate', note: 'maybe S. Park' });
      expect(sig.ts).toBeTruthy(); // CLAIMS-14 envelope timestamp

      const claims = (await readClaimFiles(root)).join('\n');
      expect(claims).not.toContain('possible-duplicate');
      expect(claims).not.toContain('maybe S. Park');
      const node = await fs.readFile(path.join(root, entityRels[0]), 'utf8');
      expect(node).not.toContain('maybe S. Park');
    });
  });
});

describe.skipIf(!gitAvailable)('empty claims is a valid outcome (CLAIMS §3.6)', () => {
  it('commits zero claim files, a placeholder block, and dequeues with a claimed marker', async () => {
    await withTempVault(async (root) => {
      await createKb({ path: root, initGitIfNeeded: true });
      const { srcRel, entityRels } = await setup(root, 'name-dropped only', ['Mentioned']);
      const res = await claimsOne(root, entityRels[0], claimsDeciderFor([]));
      expect(res.ok).toBe(true);
      expect(res.claimIds).toHaveLength(0);
      expect(await readClaimFiles(root)).toHaveLength(0);
      expect(await readClaimsQueue(root)).toHaveLength(0); // still dequeued
      const audit = await fs.readFile(path.join(root, srcRel, 'audit.jsonl'), 'utf8');
      expect(audit).toContain('"event":"claimed"');
      expect(await fs.readFile(path.join(root, entityRels[0]), 'utf8')).toContain('_No claims derived yet._');
    });
  });
});

describe.skipIf(!gitAvailable)('no cross-source claim dedup in v1 (CLAIMS-17)', () => {
  it('two entities (same name, different sources) each get their own claims', async () => {
    await withTempVault(async (root) => {
      await createKb({ path: root, initGitIfNeeded: true });
      await setup(root, 'Steve owns budget A', ['Steve']);
      await setup(root, 'Steve owns budget B', ['Steve']);
      const ents = await findEntityFiles(root);
      expect(ents).toHaveLength(2); // two un-merged Steve nodes (DECOMP-14)
      for (const e of ents) await claimsOne(root, e, claimsDeciderFor([aClaim()]));
      expect(await readClaimFiles(root)).toHaveLength(2); // one claim per entity, not merged
    });
  });
});

describe.skipIf(!gitAvailable)('failure never loses the entity; set aside after K (CLAIMS-12)', () => {
  it('retries then sets aside a poison entity without blocking the queue or writing claims', async () => {
    await withTempVault(async (root) => {
      await createKb({ path: root, initGitIfNeeded: true });
      const { entityRels } = await setup(root, 'Steve and Dana', ['Steve', 'Dana']);
      const poison = entityRels[0];
      const poisonId = path.basename(poison, '.md');

      const decider: ClaimsDecider = async (input) => {
        if (input.entityId === poisonId) throw new Error('boom');
        return claimsDeciderFor([aClaim()])(input);
      };
      const stage = new ClaimsStage(root, decider, new Mutex(), DEFAULT_MAX_ATTEMPTS);
      for (let n = 0; n < DEFAULT_MAX_ATTEMPTS + 1; n++) await stage.poke();

      expect(await readClaimsQueue(root)).toHaveLength(0); // no head-of-line block
      // Exactly one claim file — for the good entity; none for the poison one.
      expect(await readClaimFiles(root)).toHaveLength(1);
      // The poison entity node has no claims block (its work was discarded on failure).
      expect(await fs.readFile(path.join(root, poison), 'utf8')).not.toContain('kb:claims:start');
    });
  });
});

describe.skipIf(!gitAvailable)('shares the canonical-writer lock with Decompose (SPEC-0014 §5)', () => {
  it('decompose + claims advance the same canonical ref without racing', async () => {
    await withTempVault(async (root) => {
      await createKb({ path: root, initGitIfNeeded: true });
      // One already-decomposed source gives Claims work; a second fresh source gives Decompose work.
      await setup(root, 'Steve owns the Q3 budget', ['Steve']);
      await captureToInbox(root, 'in-app-panel', [{ kind: 'text', text: 'Dana' }]);
      const q = await readQueue(root);
      const src2 = await archiveOne(root, q[q.length - 1], deterministicDecider);

      const lock = new Mutex();
      const decompose = new DecomposeStage(root, decompDeciderFor(['Dana']), lock);
      const claims = new ClaimsStage(root, claimsDeciderFor([aClaim()]), lock);
      await Promise.all([decompose.poke(), claims.poke()]);
      void src2;

      expect((await simpleGit(root).status()).isClean()).toBe(true);
      // Drain again to pick up entities Decompose produced concurrently.
      await claims.poke();
      expect(await readClaimsQueue(root)).toHaveLength(0);
      expect((await simpleGit(root).status()).isClean()).toBe(true);
    });
  });
});

// ── SPEC-0018 REVIEW: raise → park → answer → resume → cascade (via the Claims stage) ──

/** A decider that raises one review (and produces no claims) — the "ask, don't guess" path. */
function raiseDeciderFor(question = 'Is this the same Steve as Steve Jones?'): ClaimsDecider {
  return async (input) => ({
    entityId: input.entityId,
    claims: [],
    reviews: [{ question, detail: 'why this matters and what a yes/no means', refs: [input.name] }],
    agent: { via: 'copilot', model: 'test' },
  });
}

describe.skipIf(!gitAvailable)('raising a review parks only that item (REVIEW-5)', () => {
  it('writes an open review, parks the entity, and applies no claims', async () => {
    await withTempVault(async (root) => {
      await createKb({ path: root, initGitIfNeeded: true });
      const { entityRels } = await setup(root, 'Steve owns the Q3 budget', ['Steve']);
      const res = await claimsOne(root, entityRels[0], raiseDeciderFor());

      expect(res.parked).toBe(true);
      expect(res.claimIds).toHaveLength(0);
      expect(await readClaimFiles(root)).toHaveLength(0); // nothing applied until answered
      expect(await readClaimsQueue(root)).toHaveLength(0); // parked → excluded from the queue
      const open = await findOpenReviews(root);
      expect(open).toHaveLength(1);
      expect(open[0].question).toContain('Steve');
      expect(open[0].raisedBy.item.ref).toBe(entityRels[0]);
    });
  });

  it('parks ONLY the raising item; sibling entities keep draining', async () => {
    await withTempVault(async (root) => {
      await createKb({ path: root, initGitIfNeeded: true });
      const { entityRels } = await setup(root, 'Steve and Dana', ['Steve', 'Dana']);
      const parkId = path.basename(entityRels[0], '.md');
      const decider: ClaimsDecider = async (input) =>
        input.entityId === parkId
          ? { entityId: input.entityId, claims: [], reviews: [{ question: 'q?', detail: 'd' }], agent: { via: 'copilot', model: 'test' } }
          : claimsDeciderFor([aClaim()])(input);

      await new ClaimsStage(root, decider).poke();
      expect(await readClaimsQueue(root)).toHaveLength(0); // one parked, one claimed — none left queued
      expect(await readClaimFiles(root)).toHaveLength(1); // the non-parked sibling was claimed
      expect(await findOpenReviews(root)).toHaveLength(1); // the parked one awaits an answer
    });
  });
});

describe.skipIf(!gitAvailable)('answering resumes the parked item (REVIEW-6)', () => {
  // Raise on the first pass (no prior answers); claim once the question is answered.
  const raiseThenClaim: ClaimsDecider = async (input) =>
    (input.priorReviews?.length ?? 0) === 0
      ? { entityId: input.entityId, claims: [], reviews: [{ question: 'Is this Steve, Steve Jones?', detail: 'ctx', refs: [input.name] }], agent: { via: 'copilot', model: 'test' } }
      : { entityId: input.entityId, claims: [aClaim()], agent: { via: 'copilot', model: 'test' } };

  it('confirm re-enqueues the item and the re-run produces claims', async () => {
    await withTempVault(async (root) => {
      await createKb({ path: root, initGitIfNeeded: true });
      const lock = new Mutex();
      const { entityRels } = await setup(root, 'Steve owns the Q3 budget', ['Steve']);
      await claimsOne(root, entityRels[0], raiseThenClaim); // parks
      const [open] = await findOpenReviews(root);

      const ans = await answerReview(root, lock, open.id, { verdict: 'confirm' });
      expect(ans.ok).toBe(true);
      expect(await findOpenReviews(root)).toHaveLength(0); // answered → leaves the queue
      expect(await readClaimsQueue(root)).toHaveLength(1); // re-enqueued (REVIEW-6)

      await claimsOne(root, entityRels[0], raiseThenClaim); // resumes → claims now
      expect(await readClaimFiles(root)).toHaveLength(1);
      const rev = await getReview(root, open.id);
      expect(rev?.status).toBe('answered');
      expect(rev?.answer?.verdict).toBe('confirm');
    });
  });

  it('feeds the answered review back to the re-run as authoritative context (REVIEW-6)', async () => {
    await withTempVault(async (root) => {
      await createKb({ path: root, initGitIfNeeded: true });
      const lock = new Mutex();
      const { entityRels } = await setup(root, 'Steve', ['Steve']);
      await claimsOne(root, entityRels[0], raiseDeciderFor('Is this Steve, Steve Jones?'));
      const [open] = await findOpenReviews(root);
      await answerReview(root, lock, open.id, { verdict: 'reject', note: "it's Steve Lin" });

      let seen: unknown;
      const spy: ClaimsDecider = async (input) => {
        seen = input.priorReviews;
        return { entityId: input.entityId, claims: [aClaim()], agent: { via: 'copilot', model: 'test' } };
      };
      await claimsOne(root, entityRels[0], spy);
      expect(seen).toEqual([{ question: 'Is this Steve, Steve Jones?', verdict: 'reject', note: "it's Steve Lin" }]);
    });
  });

  it('an answer note becomes a primary source, linked from the review (REVIEW-7)', async () => {
    await withTempVault(async (root) => {
      await createKb({ path: root, initGitIfNeeded: true });
      const lock = new Mutex();
      const { entityRels } = await setup(root, 'Steve', ['Steve']);
      await claimsOne(root, entityRels[0], raiseDeciderFor());
      const [open] = await findOpenReviews(root);

      await answerReview(root, lock, open.id, { verdict: 'reject', note: "it's Steve Lin" });
      const rev = await getReview(root, open.id);
      expect(rev?.answer?.noteSourceId).toBeTruthy();
      // The note was captured into the ingest inbox as a new primary unit (propagates on its own).
      const inbox = await readQueue(root);
      expect(inbox.some((u) => u.includes(rev!.answer!.noteSourceId!))).toBe(true);
    });
  });
});

describe.skipIf(!gitAvailable)('cascade: a resumed run may raise a follow-up (REVIEW-8)', () => {
  // Raise q1 (0 prior), q2 (1 prior), then claim (2 prior).
  const cascade: ClaimsDecider = async (input) => {
    const n = input.priorReviews?.length ?? 0;
    return n < 2
      ? { entityId: input.entityId, claims: [], reviews: [{ question: `q${n + 1}?`, detail: 'd' }], agent: { via: 'copilot', model: 'test' } }
      : { entityId: input.entityId, claims: [aClaim()], agent: { via: 'copilot', model: 'test' } };
  };

  it('answering one review can surface the next, then resolve', async () => {
    await withTempVault(async (root) => {
      await createKb({ path: root, initGitIfNeeded: true });
      const lock = new Mutex();
      const { entityRels } = await setup(root, 'Steve', ['Steve']);

      await claimsOne(root, entityRels[0], cascade); // park q1
      const [o1] = await findOpenReviews(root);
      expect(o1.question).toBe('q1?');
      await answerReview(root, lock, o1.id, { verdict: 'confirm' });

      await claimsOne(root, entityRels[0], cascade); // resume → raises q2 (cascade)
      const [o2] = await findOpenReviews(root);
      expect(o2.question).toBe('q2?');
      await answerReview(root, lock, o2.id, { verdict: 'confirm' });

      await claimsOne(root, entityRels[0], cascade); // resume → claims
      expect(await readClaimFiles(root)).toHaveLength(1);
      expect(await findOpenReviews(root)).toHaveLength(0);
    });
  });

  it('a runaway cascade is set aside after the round cap (REVIEW-8)', async () => {
    await withTempVault(async (root) => {
      await createKb({ path: root, initGitIfNeeded: true });
      const lock = new Mutex();
      const { entityRels } = await setup(root, 'Steve', ['Steve']);
      const alwaysRaise = raiseDeciderFor('q?');

      for (let i = 0; i < DEFAULT_MAX_REVIEW_ROUNDS; i++) {
        await claimsOne(root, entityRels[0], alwaysRaise); // park
        for (const o of await findOpenReviews(root)) await answerReview(root, lock, o.id, { verdict: 'confirm' });
      }
      const res = await claimsOne(root, entityRels[0], alwaysRaise); // round cap reached
      expect(res.setAside).toBe(true);
      expect(await readClaimsQueue(root)).toHaveLength(0); // set aside — no longer queued
    });
  });
});
