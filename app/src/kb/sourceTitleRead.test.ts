// PRIN-24 status title resolution (real-FS). The roster/current-item id → human title load that
// feeds computePipelineStatus, so The Line + the Status stations + the tray never show a raw ULID.
// Reuses the ONE shared deriveSourceTitle (no second fallback ladder).
import { describe, it, expect } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { makeTempDir, rmTempDir } from '../../test/tempVault';
import { dateShard, ulid } from './ulid';
import { readSourceTitle, readSourceTitles } from './sourceTitleRead';

async function writeSource(root: string, id: string, body: string): Promise<void> {
  const dir = path.join(root, 'sources', dateShard(id), id);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'source.md'), body);
}

describe('readSourceTitle (PRIN-24)', () => {
  it('resolves an archived source id to its human title via deriveSourceTitle (originalName)', async () => {
    const root = await makeTempDir();
    try {
      const id = ulid(Date.now());
      await writeSource(root, id, `---\nid: ${id}\noriginalName: Quarterly Report.pdf\n---\n\n# ignored\n`);
      // Fails-before/passes-after: before PRIN-24 the roster surfaced the bare ULID; now the id
      // resolves to the source's human title.
      expect(await readSourceTitle(root, id)).toBe('Quarterly Report.pdf');
      expect(await readSourceTitle(root, id)).not.toBe(id); // never the ULID
    } finally {
      await rmTempDir(root);
    }
  });

  it('falls through to the first body line for a titleless (text) source', async () => {
    const root = await makeTempDir();
    try {
      const id = ulid(Date.now());
      await writeSource(root, id, `---\nid: ${id}\n---\n\nMeeting notes from the offsite\n`);
      expect(await readSourceTitle(root, id)).toBe('Meeting notes from the offsite');
    } finally {
      await rmTempDir(root);
    }
  });

  it('rejects a non-ULID id (#29 — not a source path) and returns undefined for a missing source', async () => {
    const root = await makeTempDir();
    try {
      expect(await readSourceTitle(root, 'person|atlas')).toBeUndefined(); // connect block key — not a ULID
      expect(await readSourceTitle(root, '../etc/passwd')).toBeUndefined(); // #29 path-escape guard
      expect(await readSourceTitle(root, ulid(Date.now()))).toBeUndefined(); // valid ULID, no source on disk
    } finally {
      await rmTempDir(root);
    }
  });

  it('readSourceTitles resolves a batch → {id→title}, omitting non-ULID + missing ids, deduped', async () => {
    const root = await makeTempDir();
    try {
      const a = ulid(Date.now());
      const b = ulid(Date.now() + 1);
      await writeSource(root, a, `---\nid: ${a}\noriginalName: Ada bio\n---\n`);
      await writeSource(root, b, `---\nid: ${b}\n---\n\nGrace Hopper interview\n`);
      const missing = ulid(Date.now() + 2);
      const map = await readSourceTitles(root, [a, a, b, missing, 'person|atlas']); // `a` twice → deduped
      expect(map.get(a)).toBe('Ada bio');
      expect(map.get(b)).toBe('Grace Hopper interview');
      expect(map.has(missing)).toBe(false); // valid ULID, no source → omitted (not errored)
      expect(map.has('person|atlas')).toBe(false); // non-ULID → omitted
      expect(map.size).toBe(2);
    } finally {
      await rmTempDir(root);
    }
  });
});
