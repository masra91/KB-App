// SPEC-0018 REVIEW-18 / SPEC-0020 CONNECT-21 — the durable per-pair disambiguation decision store.
import { describe, it, expect } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { makeTempDir, rmTempDir } from '../../test/tempVault';
import {
  disambiguationPairKey,
  verdictToDisambiguation,
  readDisambiguationDecisions,
  recordDisambiguationDecision,
  decisionForPair,
  DISAMBIGUATION_DECISIONS_REL,
} from './disambiguationDecisions';

async function withTemp(fn: (root: string) => Promise<void>): Promise<void> {
  const dir = await makeTempDir();
  try {
    await fn(path.join(dir, 'vault'));
  } finally {
    await rmTempDir(dir);
  }
}

describe('disambiguation decisions (REVIEW-18 / CONNECT-21)', () => {
  it('pairKey is order-independent (the pair {A,B} === {B,A})', () => {
    expect(disambiguationPairKey('A', 'B')).toBe(disambiguationPairKey('B', 'A'));
    expect(disambiguationPairKey('A', 'B')).not.toBe(disambiguationPairKey('A', 'C'));
  });

  it('maps verdicts: confirm→same, reject→distinct', () => {
    expect(verdictToDisambiguation('confirm')).toBe('same');
    expect(verdictToDisambiguation('reject')).toBe('distinct');
  });

  it('records a decision and reads it back for the pair, regardless of argument order', async () => {
    await withTemp(async (root) => {
      await recordDisambiguationDecision(root, { a: 'idA', b: 'idB', verdict: 'distinct', reviewId: 'R1', decidedAt: '2026-06-08T00:00:00Z' });
      const decisions = await readDisambiguationDecisions(root);
      expect(decisionForPair(decisions, 'idA', 'idB')?.verdict).toBe('distinct');
      expect(decisionForPair(decisions, 'idB', 'idA')?.verdict).toBe('distinct'); // order-independent
      expect(decisionForPair(decisions, 'idA', 'idB')?.reviewId).toBe('R1'); // provenance kept (PRIN-5/6)
      expect(decisionForPair(decisions, 'idA', 'idC')).toBeUndefined(); // undecided pair
      // It lives in the working zone, never promoted.
      expect(DISAMBIGUATION_DECISIONS_REL.startsWith('connect')).toBe(true);
    });
  });

  it('is REVISABLE — a later opposite verdict supersedes (last-wins)', async () => {
    await withTemp(async (root) => {
      await recordDisambiguationDecision(root, { a: 'X', b: 'Y', verdict: 'distinct', reviewId: 'R1', decidedAt: '2026-06-08T00:00:00Z' });
      await recordDisambiguationDecision(root, { a: 'X', b: 'Y', verdict: 'same', reviewId: 'R2', decidedAt: '2026-06-08T01:00:00Z' });
      const decisions = await readDisambiguationDecisions(root);
      expect(decisionForPair(decisions, 'X', 'Y')?.verdict).toBe('same'); // the revision wins
      expect(decisionForPair(decisions, 'X', 'Y')?.reviewId).toBe('R2');
    });
  });

  it('an absent decision log is an empty map (no decisions yet), and garbled lines are skipped', async () => {
    await withTemp(async (root) => {
      expect((await readDisambiguationDecisions(root)).size).toBe(0); // absent file
      const file = path.join(root, DISAMBIGUATION_DECISIONS_REL);
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, 'not json\n' + JSON.stringify({ pairKey: 'k', entities: ['a', 'b'], verdict: 'distinct', reviewId: 'R', decidedAt: 't' }) + '\n', 'utf8');
      expect((await readDisambiguationDecisions(root)).size).toBe(1); // garbled line skipped, valid one kept
    });
  });
});
