// locateSourceRef tests (SPEC-0018 REVIEW-17 / PRIN-24) — the working-zone-aware open never fires a
// dead Obsidian link: a source on `main` opens; a staging-only source (raised mid-pipeline, not yet
// promoted) routes to the in-app fallback; a missing/escaping ref opens nothing.
import { describe, it, expect } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { makeTempDir, rmTempDir } from '../../test/tempVault';
import { locateSourceRef } from './sourceOpen';

const REL = 'sources/2026/06/08/01ABCSOURCE/source.md';

async function writeFileAt(root: string, rel: string, content = 'x'): Promise<void> {
  const dest = path.join(root, rel);
  await fs.mkdir(path.dirname(dest), { recursive: true });
  await fs.writeFile(dest, content, 'utf8');
}

async function withMainAndStaging(fn: (main: string, staging: string) => Promise<void>): Promise<void> {
  const dir = await makeTempDir();
  try {
    const main = path.join(dir, 'main');
    const staging = path.join(dir, 'staging');
    await fs.mkdir(main, { recursive: true });
    await fs.mkdir(staging, { recursive: true });
    await fn(main, staging);
  } finally {
    await rmTempDir(dir);
  }
}

describe('locateSourceRef (REVIEW-17 working-zone-aware open)', () => {
  it('resolves to `main` (openable in Obsidian) when the source.md is promoted', async () => {
    await withMainAndStaging(async (main, staging) => {
      await writeFileAt(main, REL);
      const got = await locateSourceRef(main, staging, REL);
      expect(got.location).toBe('main');
      expect(got.mainAbs).toBe(path.join(main, REL)); // the path the caller hands to obsidianOpenUri
    });
  });

  it('resolves to `staging` when the source is staging-only (not yet promoted) — no dead Obsidian link', async () => {
    await withMainAndStaging(async (main, staging) => {
      await writeFileAt(staging, REL); // present in staging, absent on main
      const got = await locateSourceRef(main, staging, REL);
      expect(got.location).toBe('staging');
      expect(got.mainAbs).toBeUndefined();
    });
  });

  it('prefers `main` when the source exists in BOTH zones (prefer the vault the user sees)', async () => {
    await withMainAndStaging(async (main, staging) => {
      await writeFileAt(main, REL);
      await writeFileAt(staging, REL);
      expect((await locateSourceRef(main, staging, REL)).location).toBe('main');
    });
  });

  it('resolves to `missing` when the source is in neither zone', async () => {
    await withMainAndStaging(async (main, staging) => {
      expect((await locateSourceRef(main, staging, REL)).location).toBe('missing');
    });
  });

  it('resolves to `missing` (not a crash) when there is no active staging worktree', async () => {
    await withMainAndStaging(async (main) => {
      expect((await locateSourceRef(main, null, REL)).location).toBe('missing');
    });
  });

  it('rejects an empty or traversal/escaping ref as `invalid` (never an fs touch outside the zone)', async () => {
    await withMainAndStaging(async (main, staging) => {
      expect((await locateSourceRef(main, staging, '')).location).toBe('invalid');
      expect((await locateSourceRef(main, staging, '../../etc/passwd')).location).toBe('invalid');
    });
  });
});
