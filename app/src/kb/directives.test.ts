// SPEC-0050 Directives slice-1 — the durable disambiguation-directive store. Pure FS (no git):
// append-only JSONL keyed on STABLE block identity, last-wins on revision, tolerant of garbled
// lines, and stored under the evergreen `directives/` tree.
import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { makeTempDir, rmTempDir } from '../../test/tempVault';
import {
  DISAMBIGUATION_DIRECTIVES_REL,
  CONSOLIDATION_DIRECTIVES_REL,
  DIRECTIVES_DIR,
  readDisambiguationDirectives,
  directiveForIdentity,
  recordDisambiguationDirective,
  directivePairKey,
  readConsolidationDirectives,
  consolidationDirectiveForPair,
  recordConsolidationDirective,
} from './directives';

async function withRoot(fn: (root: string) => Promise<void>): Promise<void> {
  const dir = await makeTempDir();
  try {
    await fn(path.join(dir, 'vault'));
  } finally {
    await rmTempDir(dir);
  }
}

describe('directives store (SPEC-0050)', () => {
  it('stores the disambiguation directive log under the evergreen directives/ tree', () => {
    expect(DISAMBIGUATION_DIRECTIVES_REL.startsWith(DIRECTIVES_DIR + path.sep)).toBe(true);
  });

  it('an absent file reads as an empty map (no directives yet)', async () => {
    await withRoot(async (root) => {
      expect((await readDisambiguationDirectives(root)).size).toBe(0);
    });
  });

  it('records and reads a directive by its STABLE block identity (not entity ULIDs)', async () => {
    await withRoot(async (root) => {
      await recordDisambiguationDirective(root, {
        identityKey: 'organization|disney',
        verdict: 'same',
        reviewId: 'rev1',
        decidedAt: '2026-06-14T00:00:00Z',
        entities: ['01A', '01B'],
      });
      const map = await readDisambiguationDirectives(root);
      const d = directiveForIdentity(map, 'organization|disney');
      expect(d?.verdict).toBe('same');
      expect(d?.reviewId).toBe('rev1');
      expect(d?.entities).toEqual(['01A', '01B']); // provenance kept, but never the lookup key
      expect(directiveForIdentity(map, 'organization|pixar')).toBeUndefined();
    });
  });

  it('is last-wins on revision — a later opposite verdict supersedes the earlier one', async () => {
    await withRoot(async (root) => {
      await recordDisambiguationDirective(root, { identityKey: 'organization|disney', verdict: 'same', reviewId: 'r1', decidedAt: '2026-06-14T00:00:00Z' });
      await recordDisambiguationDirective(root, { identityKey: 'organization|disney', verdict: 'distinct', reviewId: 'r2', decidedAt: '2026-06-14T01:00:00Z' });
      const d = directiveForIdentity(await readDisambiguationDirectives(root), 'organization|disney');
      expect(d?.verdict).toBe('distinct');
      expect(d?.reviewId).toBe('r2'); // the revising review's provenance wins
    });
  });

  it('skips garbled / malformed lines without blinding the rest of the store (ENG-16)', async () => {
    await withRoot(async (root) => {
      await recordDisambiguationDirective(root, { identityKey: 'organization|disney', verdict: 'same', reviewId: 'r1', decidedAt: 'now' });
      // Corrupt the file with a non-JSON line + a JSON line missing required fields, then a valid one.
      const file = path.join(path.resolve(root), DISAMBIGUATION_DIRECTIVES_REL);
      await fs.appendFile(file, 'not json at all\n', 'utf8');
      await fs.appendFile(file, JSON.stringify({ identityKey: 'organization|pixar', verdict: 'bogus' }) + '\n', 'utf8');
      await recordDisambiguationDirective(root, { identityKey: 'person|walt disney', verdict: 'distinct', reviewId: 'r2', decidedAt: 'now' });

      const map = await readDisambiguationDirectives(root);
      expect(directiveForIdentity(map, 'organization|disney')?.verdict).toBe('same'); // valid, survives
      expect(directiveForIdentity(map, 'person|walt disney')?.verdict).toBe('distinct'); // valid, survives
      expect(directiveForIdentity(map, 'organization|pixar')).toBeUndefined(); // bad verdict → dropped
    });
  });
});

describe('consolidation directives (SPEC-0050 slice-2: ad-hoc merge/distinct)', () => {
  it('stores the consolidation log under the evergreen directives/ tree', () => {
    expect(CONSOLIDATION_DIRECTIVES_REL.startsWith(DIRECTIVES_DIR + path.sep)).toBe(true);
  });

  it('directivePairKey is order-independent and content-derived (stable across rebirth)', () => {
    const a = 'organization|disney';
    const b = 'organization|walt disney company';
    expect(directivePairKey(a, b)).toBe(directivePairKey(b, a)); // order-independent
    expect(directivePairKey(a, b)).toBe('organization|disney::organization|walt disney company');
    // The key is built only from block identities (no ULID) → identical before and after a re-derive.
    expect(directivePairKey(a, b).includes('::')).toBe(true);
  });

  it('an absent file reads as an empty map', async () => {
    await withRoot(async (root) => {
      expect((await readConsolidationDirectives(root)).size).toBe(0);
    });
  });

  it('records and looks up a verdict by the block-identity PAIR, order-independently', async () => {
    await withRoot(async (root) => {
      await recordConsolidationDirective(root, {
        identityA: 'organization|walt disney company',
        identityB: 'organization|disney',
        verdict: 'distinct',
        reviewId: 'rev1',
        decidedAt: '2026-06-14T00:00:00Z',
      });
      const map = await readConsolidationDirectives(root);
      // Looked up either ordering of the same pair.
      expect(consolidationDirectiveForPair(map, 'organization|disney', 'organization|walt disney company')?.verdict).toBe('distinct');
      expect(consolidationDirectiveForPair(map, 'organization|walt disney company', 'organization|disney')?.verdict).toBe('distinct');
      // identities stored sorted, for provenance.
      expect(consolidationDirectiveForPair(map, 'organization|disney', 'organization|walt disney company')?.identities)
        .toEqual(['organization|disney', 'organization|walt disney company']);
      // An undecided pair is undefined.
      expect(consolidationDirectiveForPair(map, 'organization|disney', 'organization|pixar')).toBeUndefined();
    });
  });

  it('is last-wins on revision — a later opposite verdict supersedes', async () => {
    await withRoot(async (root) => {
      await recordConsolidationDirective(root, { identityA: 'a|x', identityB: 'a|y', verdict: 'distinct', reviewId: 'r1', decidedAt: '2026-06-14T00:00:00Z' });
      await recordConsolidationDirective(root, { identityA: 'a|y', identityB: 'a|x', verdict: 'merge', reviewId: 'r2', decidedAt: '2026-06-14T01:00:00Z' });
      const d = consolidationDirectiveForPair(await readConsolidationDirectives(root), 'a|x', 'a|y');
      expect(d?.verdict).toBe('merge'); // later verdict wins despite reversed argument order
      expect(d?.reviewId).toBe('r2');
    });
  });

  it('skips garbled / malformed lines without blinding the rest (ENG-16)', async () => {
    await withRoot(async (root) => {
      await recordConsolidationDirective(root, { identityA: 'a|x', identityB: 'a|y', verdict: 'merge', reviewId: 'r1', decidedAt: 'now' });
      const file = path.join(path.resolve(root), CONSOLIDATION_DIRECTIVES_REL);
      await fs.appendFile(file, 'not json\n', 'utf8');
      await fs.appendFile(file, JSON.stringify({ pairKey: 'a|p::a|q', verdict: 'bogus', identities: ['a|p', 'a|q'] }) + '\n', 'utf8');
      await fs.appendFile(file, JSON.stringify({ pairKey: 'a|m::a|n', verdict: 'merge' }) + '\n', 'utf8'); // missing identities
      await recordConsolidationDirective(root, { identityA: 'a|s', identityB: 'a|t', verdict: 'distinct', reviewId: 'r2', decidedAt: 'now' });

      const map = await readConsolidationDirectives(root);
      expect(consolidationDirectiveForPair(map, 'a|x', 'a|y')?.verdict).toBe('merge'); // valid, survives
      expect(consolidationDirectiveForPair(map, 'a|s', 'a|t')?.verdict).toBe('distinct'); // valid, survives
      expect(consolidationDirectiveForPair(map, 'a|p', 'a|q')).toBeUndefined(); // bad verdict → dropped
      expect(consolidationDirectiveForPair(map, 'a|m', 'a|n')).toBeUndefined(); // missing identities → dropped
    });
  });
});
