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
  CORRECTION_DIRECTIVES_REL,
  DIRECTIVES_DIR,
  readDisambiguationDirectives,
  directiveForIdentity,
  recordDisambiguationDirective,
  directivePairKey,
  readConsolidationDirectives,
  consolidationDirectiveForPair,
  recordConsolidationDirective,
  normalizeStatement,
  correctionClaimKey,
  readCorrectionDirectives,
  isClaimRetracted,
  isClaimSuppressed,
  reattributedTarget,
  recordCorrectionDirective,
  CONTRADICTION_DIRECTIVES_REL,
  contradictionClaimKey,
  readContradictionDirectives,
  recordContradictionDirective,
  contradictionForKey,
  openContradictionsForIdentity,
  contestedContradictionsForIdentity,
  isStatementContested,
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

describe('correction directives (SPEC-0050 slice-2b: retract)', () => {
  it('stores the corrections log under the evergreen directives/ tree', () => {
    expect(CORRECTION_DIRECTIVES_REL.startsWith(DIRECTIVES_DIR + path.sep)).toBe(true);
  });

  it('normalizeStatement absorbs casing/punctuation/spacing drift but not rewording', () => {
    expect(normalizeStatement('Founded Apple in 1976.')).toBe('founded apple in 1976');
    expect(normalizeStatement('  founded   APPLE, in 1976  ')).toBe('founded apple in 1976'); // drift collapses
    expect(normalizeStatement('co-founded Apple in 1976')).not.toBe(normalizeStatement('founded Apple in 1976')); // genuine rewording stays distinct
  });

  it('correctionClaimKey combines stable block identity + normalized statement (ULID-free)', () => {
    const k = correctionClaimKey('person|steve jobs', 'Founded Apple in 1976.');
    expect(k).toBe('person|steve jobs::founded apple in 1976');
    // Same fact with punctuation/case drift → same key (survives a re-derive's cosmetic variation).
    expect(correctionClaimKey('person|steve jobs', 'founded apple in 1976')).toBe(k);
  });

  it('an absent file reads as an empty map; no claim is retracted', async () => {
    await withRoot(async (root) => {
      const map = await readCorrectionDirectives(root);
      expect(map.size).toBe(0);
      expect(isClaimRetracted(map, 'person|steve jobs', 'anything')).toBe(false);
    });
  });

  it('records a retract and looks it up by (identity, statement) — drift-tolerant', async () => {
    await withRoot(async (root) => {
      await recordCorrectionDirective(root, {
        type: 'retract',
        identityKey: 'person|steve jobs',
        statement: 'Founded Apple in 1976.',
        reviewId: 'rev1',
        decidedAt: '2026-06-15T00:00:00Z',
      });
      const map = await readCorrectionDirectives(root);
      expect(isClaimRetracted(map, 'person|steve jobs', 'Founded Apple in 1976.')).toBe(true);
      expect(isClaimRetracted(map, 'person|steve jobs', 'founded   apple, in 1976')).toBe(true); // drift still matches
      expect(isClaimRetracted(map, 'person|steve jobs', 'Designed the iPhone.')).toBe(false); // different claim
      expect(isClaimRetracted(map, 'person|steve wozniak', 'Founded Apple in 1976.')).toBe(false); // different subject
    });
  });

  it('skips garbled / malformed lines without blinding the rest (ENG-16)', async () => {
    await withRoot(async (root) => {
      await recordCorrectionDirective(root, { type: 'retract', identityKey: 'person|a', statement: 'claim one', reviewId: 'r1', decidedAt: 'now' });
      const file = path.join(path.resolve(root), CORRECTION_DIRECTIVES_REL);
      await fs.appendFile(file, 'not json\n', 'utf8');
      await fs.appendFile(file, JSON.stringify({ type: 'bogus', correctionKey: 'x', identityKey: 'person|b', statement: 's' }) + '\n', 'utf8');
      await fs.appendFile(file, JSON.stringify({ type: 'retract', identityKey: 'person|c' }) + '\n', 'utf8'); // missing statement/key
      await recordCorrectionDirective(root, { type: 'retract', identityKey: 'person|d', statement: 'claim four', reviewId: 'r2', decidedAt: 'now' });

      const map = await readCorrectionDirectives(root);
      expect(isClaimRetracted(map, 'person|a', 'claim one')).toBe(true); // valid, survives
      expect(isClaimRetracted(map, 'person|d', 'claim four')).toBe(true); // valid, survives
      expect(isClaimRetracted(map, 'person|b', 's')).toBe(false); // bad type → dropped
      expect(isClaimRetracted(map, 'person|c', '')).toBe(false); // missing fields → dropped
    });
  });
});

describe('correction directives (SPEC-0050 slice-2c: reattribute)', () => {
  it('records a reattribute with its corrected target identity', async () => {
    await withRoot(async (root) => {
      await recordCorrectionDirective(root, {
        type: 'reattribute',
        identityKey: 'person|ngan',
        statement: 'Worked at Disney for 20 years.',
        toIdentity: 'person|mason',
        reviewId: 'rev1',
        decidedAt: '2026-06-15T00:00:00Z',
      });
      const map = await readCorrectionDirectives(root);
      // Suppressed on the WRONG subject (both retract + reattribute suppress) …
      expect(isClaimSuppressed(map, 'person|ngan', 'Worked at Disney for 20 years.')).toBe(true);
      // … but it is NOT a retract …
      expect(isClaimRetracted(map, 'person|ngan', 'Worked at Disney for 20 years.')).toBe(false);
      // … and the corrected target is recorded (drift-tolerant lookup).
      expect(reattributedTarget(map, 'person|ngan', 'worked at disney for 20 years')).toBe('person|mason');
      expect(reattributedTarget(map, 'person|mason', 'Worked at Disney for 20 years.')).toBeUndefined(); // not on the target's key
    });
  });

  it('isClaimSuppressed covers BOTH retract and reattribute; isClaimRetracted is retract-only', async () => {
    await withRoot(async (root) => {
      await recordCorrectionDirective(root, { type: 'retract', identityKey: 'person|a', statement: 'wrong fact', reviewId: 'r1', decidedAt: 'now' });
      await recordCorrectionDirective(root, { type: 'reattribute', identityKey: 'person|b', statement: 'misattributed fact', toIdentity: 'person|c', reviewId: 'r2', decidedAt: 'now' });
      const map = await readCorrectionDirectives(root);
      expect(isClaimSuppressed(map, 'person|a', 'wrong fact')).toBe(true);
      expect(isClaimSuppressed(map, 'person|b', 'misattributed fact')).toBe(true);
      expect(isClaimRetracted(map, 'person|a', 'wrong fact')).toBe(true);
      expect(isClaimRetracted(map, 'person|b', 'misattributed fact')).toBe(false); // reattribute ≠ retract
    });
  });

  it('a reattribute requires a corrected target (recordCorrectionDirective throws; reader drops a malformed one)', async () => {
    await withRoot(async (root) => {
      await expect(
        recordCorrectionDirective(root, { type: 'reattribute', identityKey: 'person|a', statement: 's', reviewId: 'r', decidedAt: 'now' }),
      ).rejects.toThrow(/toIdentity/);
      // A hand-written reattribute line missing toIdentity is dropped on read (ENG-16).
      const file = path.join(path.resolve(root), CORRECTION_DIRECTIVES_REL);
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.appendFile(file, JSON.stringify({ type: 'reattribute', correctionKey: 'person|a::s', identityKey: 'person|a', statement: 's' }) + '\n', 'utf8');
      const map = await readCorrectionDirectives(root);
      expect(isClaimSuppressed(map, 'person|a', 's')).toBe(false); // missing toIdentity → dropped
    });
  });
});

describe('contradiction lifecycle (SPEC-0036 CONTRA)', () => {
  const A = 'Born in 1815.';
  const B = 'Born in 1816.';

  it('the key is content-derived + order-independent over the two statements', () => {
    // Same entity + same pair in either order → ONE key (so a re-detection updates, never duplicates).
    expect(contradictionClaimKey('person|ada lovelace', A, B)).toBe(contradictionClaimKey('person|ada lovelace', B, A));
    // Casing/punctuation drift across a re-derive still collapses to the same key (normalizeStatement).
    expect(contradictionClaimKey('person|ada lovelace', 'BORN IN 1815', B)).toBe(contradictionClaimKey('person|ada lovelace', A, B));
    // A different entity is a different contradiction.
    expect(contradictionClaimKey('person|ada lovelace', A, B)).not.toBe(contradictionClaimKey('person|charles babbage', A, B));
  });

  it('records a needs-you flag that surfaces as an OPEN contradiction on the entity', async () => {
    await withRoot(async (root) => {
      await recordContradictionDirective(root, {
        identityKey: 'person|ada lovelace',
        statementA: A,
        statementB: B,
        state: 'needs-you',
        reviewId: 'rev-contra-1',
        decidedAt: '2026-06-27T00:00:00Z',
      });
      const map = await readContradictionDirectives(root);
      const open = openContradictionsForIdentity(map, 'person|ada lovelace');
      expect(open).toHaveLength(1);
      expect(open[0].state).toBe('needs-you');
      expect(open[0].statements).toEqual([A, B].sort()); // statements stored sorted for stability
      // It is also CONTESTED at recall, and each statement flags individually.
      expect(contestedContradictionsForIdentity(map, 'person|ada lovelace')).toHaveLength(1);
      expect(isStatementContested(map, 'person|ada lovelace', 'born in 1815')).toBe(true); // drift-tolerant
      expect(isStatementContested(map, 'person|ada lovelace', 'Died in 1852.')).toBe(false);
    });
  });

  it('resolving CLEARS the open flag (last-wins) but leaves no contest; accepting clears the flag yet stays contested', async () => {
    await withRoot(async (root) => {
      // resolved: superseded → flag clears, not contested at recall (one answer won).
      await recordContradictionDirective(root, { identityKey: 'person|x', statementA: A, statementB: B, state: 'needs-you', reviewId: 'r', decidedAt: '1' });
      await recordContradictionDirective(root, { identityKey: 'person|x', statementA: A, statementB: B, state: 'resolved', reviewId: 'r', decidedAt: '2' });
      let map = await readContradictionDirectives(root);
      expect(openContradictionsForIdentity(map, 'person|x')).toHaveLength(0);
      expect(contestedContradictionsForIdentity(map, 'person|x')).toHaveLength(0);
      expect(contradictionForKey(map, 'person|x', A, B)?.state).toBe('resolved'); // last-wins

      // accepted: both stand → flag clears from the queue, but recall still surfaces it as contested.
      await recordContradictionDirective(root, { identityKey: 'person|y', statementA: A, statementB: B, state: 'needs-you', reviewId: 'r', decidedAt: '1' });
      await recordContradictionDirective(root, { identityKey: 'person|y', statementA: A, statementB: B, state: 'accepted', reviewId: 'r', decidedAt: '2' });
      map = await readContradictionDirectives(root);
      expect(openContradictionsForIdentity(map, 'person|y')).toHaveLength(0);
      expect(contestedContradictionsForIdentity(map, 'person|y')).toHaveLength(1); // accepted = still contested
      expect(isStatementContested(map, 'person|y', A)).toBe(true);
    });
  });

  it('re-opens a terminal contradiction when a fresh needs-you lands later (last-wins)', async () => {
    await withRoot(async (root) => {
      await recordContradictionDirective(root, { identityKey: 'person|z', statementA: A, statementB: B, state: 'resolved', reviewId: 'r', decidedAt: '1' });
      await recordContradictionDirective(root, { identityKey: 'person|z', statementA: A, statementB: B, state: 'needs-you', reviewId: 'r2', decidedAt: '2' });
      const map = await readContradictionDirectives(root);
      expect(openContradictionsForIdentity(map, 'person|z')).toHaveLength(1); // re-opened
      expect(contradictionForKey(map, 'person|z', A, B)?.state).toBe('needs-you');
    });
  });

  it('tolerates a garbled line + drops malformed records (ENG-16)', async () => {
    await withRoot(async (root) => {
      const file = path.join(path.resolve(root), CONTRADICTION_DIRECTIVES_REL);
      await fs.mkdir(path.dirname(file), { recursive: true });
      const good = JSON.stringify({ contradictionKey: contradictionClaimKey('person|g', A, B), identityKey: 'person|g', statements: [A, B], state: 'needs-you', reviewId: 'r', decidedAt: '1' });
      await fs.appendFile(file, '{not json\n' + good + '\n' + JSON.stringify({ identityKey: 'person|g', state: 'bogus' }) + '\n', 'utf8');
      const map = await readContradictionDirectives(root);
      expect(openContradictionsForIdentity(map, 'person|g')).toHaveLength(1); // the one good line survives
    });
  });

  it('an absent store yields no flags', async () => {
    await withRoot(async (root) => {
      const map = await readContradictionDirectives(root);
      expect(openContradictionsForIdentity(map, 'person|nobody')).toEqual([]);
      expect(isStatementContested(map, 'person|nobody', A)).toBe(false);
    });
  });
});
