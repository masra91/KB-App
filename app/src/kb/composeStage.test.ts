// Compose stage tests (SPEC-0046 COMPOSE-7). Real FS + git + worktrees against a throwaway temp
// vault (TEST-18); deciders are injected so nothing shells out to copilot (TEST-2). Exercises the
// REAL claims→compose handoff: archive a source → seed an entity → run Claims to attach a real
// claims block + claim files + source.md → then Compose.
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
import { renderEntityNode, entityFileRel } from './connectDoc';
import { CLAIMS_BLOCK_START } from './claimDoc';
import { ulid } from './ulid';
import { claimsOne, findEntityFiles } from './claimsStage';
import type { ClaimsDecider } from './claimsAgent';
import type { ClaimDecision } from './claims';
import {
  composeOne,
  readComposeQueue,
  ComposeStage,
  claimsBlockSig,
  linkedEntityNames,
  hasClaims,
  DEFAULT_MAX_ATTEMPTS,
} from './composeStage';
import { hasProse } from './composeDoc';
import type { ComposeDecider, ComposeInput } from './composeAgent';
import type { ComposeSection } from './compose';

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

async function archiveText(root: string, text: string): Promise<string> {
  await captureToInbox(root, 'in-app-panel', [{ kind: 'text', text }]);
  const q = await readQueue(root);
  return archiveOne(root, q[q.length - 1], deterministicDecider);
}

async function seedEntity(root: string, srcRel: string, name: string): Promise<string> {
  const id = ulid();
  const rel = entityFileRel('person', name, id, new Set(await findEntityFiles(root)));
  const dest = path.join(root, rel);
  await fs.mkdir(path.dirname(dest), { recursive: true });
  const now = new Date().toISOString();
  await fs.writeFile(
    dest,
    renderEntityNode({
      id, kind: 'person', name, confidence: 0.9, aliases: [id], derivedFrom: [srcRel],
      resolvedFrom: [], tags: [], createdAt: now, updatedAt: now, agent: { via: 'copilot', model: 'test' },
    }),
    'utf8',
  );
  const git = simpleGit(root);
  await git.raw('add', '-A');
  await git.commit('test: seed entity');
  return rel;
}

const aClaim = (over: Partial<ClaimDecision> = {}): ClaimDecision => ({
  statement: 'Co-founded Apple in 1976.',
  status: 'fact',
  confidence: 0.95,
  mentions: ['co-founded Apple'],
  ...over,
});

function claimsDeciderFor(claims: ClaimDecision[]): ClaimsDecider {
  return async (input) => ({ entityId: input.entityId, claims, agent: { via: 'copilot', model: 'test' } });
}

function composeDeciderFor(sections: ComposeSection[]): ComposeDecider {
  return async (input: ComposeInput) => ({ entityId: input.entityId, sections, agent: { via: 'copilot', model: 'test' } });
}

/** Archive a source, seed one entity, and run Claims so the entity carries a real claims block. */
async function composeReady(root: string, text: string, name: string, claims: ClaimDecision[] = [aClaim()]): Promise<string> {
  const srcRel = await archiveText(root, text);
  const entityRel = await seedEntity(root, srcRel, name);
  await claimsOne(root, entityRel, claimsDeciderFor(claims));
  return entityRel;
}

const LEDE: ComposeSection[] = [{ sentences: [{ text: 'Steve Jobs co-founded [[Apple]].', claims: [1] }] }];

describe.skipIf(!gitAvailable)('composeOne (COMPOSE-1/2/5/7/8)', () => {
  it('writes grounded prose with a titled References citation, keeping the claims block below', async () => {
    await withTempVault(async (root) => {
      await createKb({ path: root, initGitIfNeeded: true });
      const entityRel = await composeReady(root, 'Apple Keynote Notes\n\nSteve co-founded Apple.', 'Steve Jobs');

      const res = await composeOne(root, entityRel, composeDeciderFor(LEDE));
      expect(res.composed).toBe(true);

      const md = await fs.readFile(path.join(root, entityRel), 'utf8');
      // prose, woven link, inline citation — above the claims block (COMPOSE-1/2/4/5)
      expect(md).toContain('Steve Jobs co-founded [[Apple]].[^1]');
      expect(md).toContain('## References');
      expect(md).toMatch(/\[\^1\]: \[\[sources\/.+\/source\.md\|.+\]\]/); // titled, navigable, never a ULID label
      expect(md).not.toMatch(/\[\^1\]: \[\[sources\/[^|]*\|[0-9A-HJKMNP-TV-Z]{26}\]\]/); // not a ULID label
      expect(md.indexOf('Steve Jobs co-founded')).toBeLessThan(md.indexOf(CLAIMS_BLOCK_START));
      expect(md).toContain(CLAIMS_BLOCK_START); // structured block preserved (COMPOSE-5)
    });
  });

  it('is idempotent — once composed, the entity leaves the queue and a re-run is a no-op', async () => {
    await withTempVault(async (root) => {
      await createKb({ path: root, initGitIfNeeded: true });
      const entityRel = await composeReady(root, 'Apple Keynote Notes\n\nSteve co-founded Apple.', 'Steve Jobs');
      await composeOne(root, entityRel, composeDeciderFor(LEDE));

      expect(await readComposeQueue(root)).not.toContain(entityRel); // composed for this sig
      const before = await fs.readFile(path.join(root, entityRel), 'utf8');
      const res2 = await composeOne(root, entityRel, composeDeciderFor(LEDE));
      expect(res2.composed).toBe(false); // nothing to do
      const after = await fs.readFile(path.join(root, entityRel), 'utf8');
      expect(after).toBe(before); // byte-stable
    });
  });

  it('re-queues when the claims change (a new signature) — regenerated on claim change (COMPOSE-7)', async () => {
    await withTempVault(async (root) => {
      await createKb({ path: root, initGitIfNeeded: true });
      const entityRel = await composeReady(root, 'Apple Keynote Notes\n\nSteve co-founded Apple.', 'Steve Jobs');
      const sigBefore = claimsBlockSig(await fs.readFile(path.join(root, entityRel), 'utf8'));
      await composeOne(root, entityRel, composeDeciderFor(LEDE));
      expect(await readComposeQueue(root)).not.toContain(entityRel);

      // Simulate a claim change: a second Claims pass is the real trigger; here we change the block
      // directly + commit, which changes the signature → re-queue.
      const md = await fs.readFile(path.join(root, entityRel), 'utf8');
      const changed = md.replace(CLAIMS_BLOCK_START, `${CLAIMS_BLOCK_START}\n- [[claims/2026/06/08/01NEW.md]] — A new claim. *(fact, 0.9)*`);
      await fs.writeFile(path.join(root, entityRel), changed, 'utf8');
      const git = simpleGit(root);
      await git.raw('add', '-A');
      await git.commit('test: a claim changed');

      expect(claimsBlockSig(changed)).not.toBe(sigBefore); // signature moved
      expect(await readComposeQueue(root)).toContain(entityRel); // back in the queue
    });
  });

  it('falls back to blocks-only when the agent fails — no prose, never a hard error (COMPOSE-7)', async () => {
    await withTempVault(async (root) => {
      await createKb({ path: root, initGitIfNeeded: true });
      const entityRel = await composeReady(root, 'Apple Keynote Notes\n\nSteve co-founded Apple.', 'Steve Jobs');
      const throwing: ComposeDecider = async () => {
        throw new Error('compose: copilot unavailable');
      };

      const res = await composeOne(root, entityRel, throwing);
      expect(res.composed).toBe(false);
      const md = await fs.readFile(path.join(root, entityRel), 'utf8');
      expect(hasProse(md)).toBe(false); // left as today's structured-blocks-only node
      expect(md).toContain(CLAIMS_BLOCK_START); // blocks intact
    });
  });

  it('sets aside after K failures (for the signature) so it stops churning', async () => {
    await withTempVault(async (root) => {
      await createKb({ path: root, initGitIfNeeded: true });
      const entityRel = await composeReady(root, 'Apple Keynote Notes\n\nSteve co-founded Apple.', 'Steve Jobs');
      const throwing: ComposeDecider = async () => {
        throw new Error('boom');
      };
      let last;
      for (let i = 0; i < DEFAULT_MAX_ATTEMPTS; i++) last = await composeOne(root, entityRel, throwing);
      expect(last?.setAside).toBe(true);
      expect(await readComposeQueue(root)).not.toContain(entityRel); // exhausted → out of the queue
    });
  });
});

describe.skipIf(!gitAvailable)('readComposeQueue (COMPOSE-7 queue)', () => {
  it('queues an entity with claims, not one without', async () => {
    await withTempVault(async (root) => {
      await createKb({ path: root, initGitIfNeeded: true });
      // entity WITH claims
      const withClaim = await composeReady(root, 'Apple Keynote Notes\n\nSteve co-founded Apple.', 'Steve Jobs');
      // entity WITHOUT claims (seeded, never claimed)
      const src2 = await archiveText(root, 'Empty.');
      const noClaim = await seedEntity(root, src2, 'Tim Cook');

      const q = await readComposeQueue(root);
      expect(q).toContain(withClaim);
      expect(q).not.toContain(noClaim);
      expect(hasClaims(await fs.readFile(path.join(root, noClaim), 'utf8'))).toBe(false);
    });
  });
});

describe.skipIf(!gitAvailable)('ComposeStage drain', () => {
  it('composes every pending entity on poke and runs afterDrain', async () => {
    await withTempVault(async (root) => {
      await createKb({ path: root, initGitIfNeeded: true });
      const e1 = await composeReady(root, 'Apple Keynote Notes\n\nSteve co-founded Apple.', 'Steve Jobs');
      let promoted = 0;
      const stage = new ComposeStage(root, composeDeciderFor(LEDE), undefined, DEFAULT_MAX_ATTEMPTS, async () => {
        promoted += 1;
      });
      await stage.poke();
      expect(promoted).toBeGreaterThan(0);
      expect(hasProse(await fs.readFile(path.join(root, e1), 'utf8'))).toBe(true);
      expect(await readComposeQueue(root)).toHaveLength(0);
    });
  });
});

describe('linkedEntityNames (COMPOSE-4 weave input)', () => {
  it('pulls display names from the links block (alias form and bare path)', () => {
    const md = [
      '# X', '',
      '<!-- kb:links:start (generated — edit via Connect, not here) -->',
      '- [[entities/organization/Apple.md|Apple]]',
      '- [[entities/person/Steve Wozniak.md]]',
      '<!-- kb:links:end -->',
    ].join('\n');
    expect(linkedEntityNames(md)).toEqual(['Apple', 'Steve Wozniak']);
  });
});
