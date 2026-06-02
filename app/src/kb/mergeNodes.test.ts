// Entity-merge core (SPEC-0020 CONNECT-10/11; reused by Reflect consolidation REFLECT-7). Pure FS.
import { describe, it, expect } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { makeTempDir, rmTempDir, pathExists } from '../../test/tempVault';
import { mergeNodes } from './mergeNodes';

async function write(root: string, rel: string, content: string): Promise<void> {
  const dest = path.join(root, rel);
  await fs.mkdir(path.dirname(dest), { recursive: true });
  await fs.writeFile(dest, content, 'utf8');
}

const node = (name: string) => `---\nid: ${name}\nkind: person\nname: ${name}\n---\n\n# ${name}\n`;
const claim = (subject: string, statement: string) =>
  `---\nid: 01C\nsubject: ${subject}\nstatus: fact\nconfidence: 0.9\n---\n\n${statement}\n`;

describe('mergeNodes (CONNECT-10/11)', () => {
  it('repoints the loser’s claims to the canonical, regenerates its claims block, deletes the loser', async () => {
    const dir = await makeTempDir();
    try {
      const root = path.join(dir, 'wt');
      const canonical = 'entities/person/steve-jobs.md';
      const loser = 'entities/person/steven-jobs.md';
      await write(root, canonical, node('Steve Jobs'));
      await write(root, loser, node('Steven Jobs'));
      await write(root, 'claims/2026/05/31/01C.md', claim(loser, 'Co-founded Apple.'));

      const res = await mergeNodes(root, canonical, [loser]);
      expect(res.deleted).toEqual([loser]);

      expect(await pathExists(path.join(root, loser))).toBe(false); // loser deleted (no tombstone)
      const claimMd = await fs.readFile(path.join(root, 'claims/2026/05/31/01C.md'), 'utf8');
      expect(claimMd).toContain(`subject: ${canonical}`); // claim repointed (CONNECT-11)
      const canonMd = await fs.readFile(path.join(root, canonical), 'utf8');
      expect(canonMd).toContain('Co-founded Apple.'); // regenerated claims block on the canonical
      expect(canonMd).toContain('kb:claims:start');
    } finally {
      await rmTempDir(dir);
    }
  });

  it('is idempotent / safe: an already-gone loser (or self) merges nothing', async () => {
    const dir = await makeTempDir();
    try {
      const root = path.join(dir, 'wt');
      const canonical = 'entities/person/steve-jobs.md';
      await write(root, canonical, node('Steve Jobs'));
      expect((await mergeNodes(root, canonical, ['entities/person/gone.md'])).deleted).toEqual([]); // absent loser
      expect((await mergeNodes(root, canonical, [canonical])).deleted).toEqual([]); // never self-merge
      expect(await pathExists(path.join(root, canonical))).toBe(true); // canonical untouched
    } finally {
      await rmTempDir(dir);
    }
  });
});
