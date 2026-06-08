// SENSE read surface (SPEC-0043 SENSE-10). Pure frontmatter parse + a real-FS batch read.
import { describe, it, expect } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { makeTempDir, rmTempDir } from '../../test/tempVault';
import { dateShard, ulid } from './ulid';
import { parseSensitivityFromSourceMd, readSourceSensitivity, readSourceSensitivities } from './sensitivityRead';

describe('parseSensitivityFromSourceMd (SENSE-10)', () => {
  it('reads the label + provenance from a SENSE-1a frontmatter', () => {
    const md = `---\nid: X\nscope: global\nsensitivity: confidential\nsensitivityMeta:\n  by: connector\n  at: 2026-06-08T00:00:00Z\nraw: raw.md\n---\n\nbody`;
    expect(parseSensitivityFromSourceMd(md)).toEqual({ sensitivity: 'confidential', by: 'connector' });
  });
  it('defaults by → "default" when there is no sensitivityMeta (pre-SENSE source)', () => {
    expect(parseSensitivityFromSourceMd(`---\nsensitivity: internal\n---\n`)).toEqual({ sensitivity: 'internal', by: 'default' });
  });
  it('unquotes a YAML-quoted custom label', () => {
    expect(parseSensitivityFromSourceMd(`---\nsensitivity: "legal: hold"\nsensitivityMeta:\n  by: principal\n  at: x\n---\n`)).toEqual({ sensitivity: 'legal: hold', by: 'principal' });
  });
  it('returns null when there is no sensitivity field', () => {
    expect(parseSensitivityFromSourceMd(`---\nid: X\n---\n`)).toBeNull();
  });
});

describe('readSourceSensitivity / readSourceSensitivities (SENSE-10)', () => {
  it('reads an archived source.md; rejects a non-ULID id (#29); omits unreadable ids', async () => {
    const root = await makeTempDir();
    try {
      const id = ulid(Date.now());
      const dir = path.join(root, 'sources', dateShard(id), id);
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(path.join(dir, 'source.md'), `---\nsensitivity: confidential\nsensitivityMeta:\n  by: principal\n  at: x\n---\n`);

      expect(await readSourceSensitivity(root, id)).toEqual({ sensitivity: 'confidential', by: 'principal' });
      expect(await readSourceSensitivity(root, '../etc/passwd')).toBeNull(); // #29 — not a ULID
      expect(await readSourceSensitivity(root, ulid(Date.now()))).toBeNull(); // valid id, no source

      const map = await readSourceSensitivities(root, [id, '../bad', ulid(Date.now())]);
      expect(map[id]).toEqual({ sensitivity: 'confidential', by: 'principal' });
      expect(Object.keys(map)).toEqual([id]); // bad/missing ids omitted, not errored
    } finally {
      await rmTempDir(root);
    }
  });
});
