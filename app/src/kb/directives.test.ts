// SPEC-0050 Directives slice-1 — the durable disambiguation-directive store. Pure FS (no git):
// append-only JSONL keyed on STABLE block identity, last-wins on revision, tolerant of garbled
// lines, and stored under the evergreen `directives/` tree.
import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { makeTempDir, rmTempDir } from '../../test/tempVault';
import {
  DISAMBIGUATION_DIRECTIVES_REL,
  DIRECTIVES_DIR,
  readDisambiguationDirectives,
  directiveForIdentity,
  recordDisambiguationDirective,
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
