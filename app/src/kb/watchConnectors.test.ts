// WATCH shared types/guards (SPEC-0037). Pure/fs-temp; the loop-guard is the security-critical piece —
// requirement-traced (WATCH-10): a folder that would re-ingest the vault into itself is REFUSED.
import { describe, it, expect } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  isSafeWatchId,
  checkWatchLoopSafe,
  isIgnoredFile,
  hashContent,
  renderWatchSourceBody,
  type WatchFolderConfig,
} from './watchConnectors';

async function tmp(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}
const cfg = (over: Partial<WatchFolderConfig> = {}): WatchFolderConfig => ({ id: 'drop', folderPath: '/x', enabled: true, scope: 'global', sensitivity: 'internal', ...over });

describe('isSafeWatchId (#29 bare-slug guard)', () => {
  it('accepts bare slugs, rejects traversal/separators/garbage', () => {
    for (const ok of ['drop', 'inbox-1', 'A9']) expect(isSafeWatchId(ok)).toBe(true);
    for (const bad of ['../x', 'a/b', '.kb', '', '  ', 42, null, undefined]) expect(isSafeWatchId(bad as unknown)).toBe(false);
  });
});

describe('checkWatchLoopSafe — the loop-guard (WATCH-10, security)', () => {
  it('ACCEPTS a real directory outside the vault', async () => {
    const vault = await tmp('kb-vault-');
    const outside = await tmp('kb-outside-');
    try {
      expect((await checkWatchLoopSafe(vault, outside)).ok).toBe(true);
    } finally {
      await fs.rm(vault, { recursive: true, force: true });
      await fs.rm(outside, { recursive: true, force: true });
    }
  });

  it('REFUSES the vault root itself, a folder inside the vault (incl. .kb/.git), and an ancestor', async () => {
    const parent = await tmp('kb-parent-');
    const vault = path.join(parent, 'vault');
    await fs.mkdir(path.join(vault, '.kb'), { recursive: true });
    await fs.mkdir(path.join(vault, 'sources'), { recursive: true });
    try {
      expect((await checkWatchLoopSafe(vault, vault)).ok).toBe(false); // the vault itself
      expect((await checkWatchLoopSafe(vault, path.join(vault, '.kb'))).ok).toBe(false); // inside (.kb)
      expect((await checkWatchLoopSafe(vault, path.join(vault, 'sources'))).ok).toBe(false); // inside (content)
      expect((await checkWatchLoopSafe(vault, parent)).ok).toBe(false); // ancestor — would sweep the vault
    } finally {
      await fs.rm(parent, { recursive: true, force: true });
    }
  });

  it('REFUSES a non-existent folder, a non-absolute path, and a non-directory', async () => {
    const vault = await tmp('kb-vault-');
    try {
      expect((await checkWatchLoopSafe(vault, path.join(vault, '..', 'nope-does-not-exist'))).ok).toBe(false);
      expect((await checkWatchLoopSafe(vault, 'relative/path')).ok).toBe(false);
      const file = path.join(vault, '..', 'afile.txt');
      await fs.writeFile(file, 'x');
      expect((await checkWatchLoopSafe(vault, file)).ok).toBe(false); // not a directory
      await fs.rm(file, { force: true });
    } finally {
      await fs.rm(vault, { recursive: true, force: true });
    }
  });

  it('is SYMLINK-SAFE — a symlink that resolves inside the vault is refused', async () => {
    const parent = await tmp('kb-parent-');
    const vault = path.join(parent, 'vault');
    await fs.mkdir(path.join(vault, 'sources'), { recursive: true });
    const link = path.join(parent, 'sneaky'); // looks outside, resolves into the vault
    try {
      await fs.symlink(path.join(vault, 'sources'), link, 'dir');
      expect((await checkWatchLoopSafe(vault, link)).ok).toBe(false); // realpath catches the escape
    } catch (e) {
      // Some CI FS disallow symlinks; treat as N/A rather than a false failure.
      if ((e as NodeJS.ErrnoException).code === 'EPERM') return;
      throw e;
    } finally {
      await fs.rm(parent, { recursive: true, force: true });
    }
  });
});

describe('isIgnoredFile (bounds, WATCH-6)', () => {
  it('always skips dotfiles; matches ignoreGlobs (case-insensitive *,?)', () => {
    expect(isIgnoredFile('.DS_Store')).toBe(true);
    expect(isIgnoredFile('.partial.crdownload')).toBe(true);
    expect(isIgnoredFile('notes.md')).toBe(false);
    expect(isIgnoredFile('draft.tmp', ['*.tmp'])).toBe(true);
    expect(isIgnoredFile('Thumbs.DB', ['thumbs.db'])).toBe(true);
    expect(isIgnoredFile('keep.md', ['*.tmp'])).toBe(false);
  });
});

describe('hashContent + renderWatchSourceBody', () => {
  it('hashes deterministically as sha256:<hex>', () => {
    const h = hashContent(new TextEncoder().encode('hello'));
    expect(h).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(hashContent(new TextEncoder().encode('hello'))).toBe(h);
    expect(hashContent(new TextEncoder().encode('world'))).not.toBe(h);
  });
  it('renders provenance header; includes the prior-source link when superseding (Fork#1)', () => {
    const body = renderWatchSourceBody(cfg({ id: 'inbox' }), 'report.md', '2026-01-01T00:00:00.000Z', { textContent: 'Q4 numbers', priorSourceId: '01PRIOR' });
    expect(body).toContain('# report.md');
    expect(body).toContain('folder-watch `inbox`');
    expect(body).toContain('Supersedes the prior version'); // carries the prior-source link
    expect(body).toContain('01PRIOR');
    expect(body).toContain('Q4 numbers');
  });
});
