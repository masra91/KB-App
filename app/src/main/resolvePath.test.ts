// SPEC-0010 STACK-9 — resolve the user's real PATH for GUI-launched apps.
// Pure, node-tier tests; the shell invocation is injected so nothing is spawned.
import { describe, it, expect, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { mergePath, loginShellPath, ensurePath, defaultFallbackDirs, resolveExecutable } from './resolvePath';

const MINIMAL = '/usr/bin:/bin:/usr/sbin:/sbin'; // what a Finder/Dock launch gives

describe('mergePath (STACK-9)', () => {
  it('prepends resolved + fallbacks ahead of the current PATH', () => {
    const out = mergePath('/usr/bin:/bin', '/opt/homebrew/bin', ['/usr/local/bin']);
    expect(out).toBe('/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin');
  });

  it('de-duplicates while preserving first-seen order', () => {
    const out = mergePath('/usr/bin:/bin', '/opt/homebrew/bin:/usr/bin', ['/usr/local/bin', '/opt/homebrew/bin']);
    expect(out).toBe('/opt/homebrew/bin:/usr/bin:/usr/local/bin:/bin');
  });

  it('drops empty segments and trims', () => {
    expect(mergePath('/usr/bin::', undefined, ['', '  '])).toBe('/usr/bin');
  });

  it('works when current PATH is undefined', () => {
    expect(mergePath(undefined, '/opt/homebrew/bin', ['/usr/local/bin'])).toBe('/opt/homebrew/bin:/usr/local/bin');
  });
});

describe('loginShellPath (STACK-9)', () => {
  it('returns the marked PATH line, ignoring rc banner noise', async () => {
    const runner = vi.fn(async () => 'Welcome to your shell!\nsome banner\n__KBPATH__/opt/homebrew/bin:/usr/bin\n');
    await expect(loginShellPath({ shell: '/bin/zsh', runner })).resolves.toBe('/opt/homebrew/bin:/usr/bin');
    expect(runner).toHaveBeenCalledWith('/bin/zsh', ['-ilc', expect.stringContaining('$PATH')]);
  });

  it('returns null when no $SHELL is available', async () => {
    const runner = vi.fn();
    await expect(loginShellPath({ shell: '', runner })).resolves.toBeNull();
    expect(runner).not.toHaveBeenCalled();
  });

  it('returns null (not throw) when the shell invocation fails', async () => {
    const runner = vi.fn(async () => {
      throw new Error('shell exploded');
    });
    await expect(loginShellPath({ shell: '/bin/zsh', runner })).resolves.toBeNull();
  });

  it('returns null when output has no usable PATH', async () => {
    const runner = vi.fn(async () => '__KBPATH__\n');
    await expect(loginShellPath({ shell: '/bin/zsh', runner })).resolves.toBeNull();
  });
});

describe('ensurePath (STACK-9)', () => {
  // The regression test: a minimal Finder-style PATH must end up containing the dir where
  // user CLIs (copilot/gh) live — proven empirically to be the difference between
  // "command not found" and a working binary.
  it('recovers user CLI dirs from a minimal GUI PATH via the login shell', async () => {
    const env = { PATH: MINIMAL };
    const runner = async () => '__KBPATH__/opt/homebrew/bin:/usr/bin:/bin\n';
    const out = await ensurePath({ env, platform: 'darwin', shell: '/bin/zsh', runner });
    expect(out).toContain('/opt/homebrew/bin');
    expect(env.PATH).toBe(out); // mutated in place
    expect(out.startsWith('/opt/homebrew/bin')).toBe(true);
  });

  it('falls back to default dirs when the login shell yields nothing', async () => {
    const env = { PATH: MINIMAL };
    const runner = async () => {
      throw new Error('no shell');
    };
    const out = await ensurePath({ env, platform: 'darwin', shell: '/bin/zsh', runner, home: '/Users/x' });
    for (const dir of defaultFallbackDirs('/Users/x')) expect(out).toContain(dir);
    expect(out).toContain('/usr/bin'); // original entries retained
  });

  it('is a no-op on Windows', async () => {
    const env = { PATH: 'C:\\Windows\\System32' };
    const runner = vi.fn();
    const out = await ensurePath({ env, platform: 'win32', runner });
    expect(out).toBe('C:\\Windows\\System32');
    expect(env.PATH).toBe('C:\\Windows\\System32');
    expect(runner).not.toHaveBeenCalled();
  });
});

describe('resolveExecutable (STACK-9 / BUG #65 — find the BYOA copilot for the SDK cliPath)', () => {
  it('returns the absolute path of the first match on PATH; null when absent', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'kb-bin-'));
    try {
      const exe = path.join(dir, 'copilot');
      await fs.writeFile(exe, '#!/bin/sh\n');
      const env = { PATH: `/nonexistent-dir:${dir}` } as NodeJS.ProcessEnv;
      expect(resolveExecutable('copilot', env, 'linux')).toBe(exe);
      expect(resolveExecutable('does-not-exist', env, 'linux')).toBeNull();
      expect(resolveExecutable('copilot', { PATH: '' } as NodeJS.ProcessEnv, 'linux')).toBeNull();
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('tries Windows executable suffixes', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'kb-bin-win-'));
    try {
      const exe = path.join(dir, 'copilot.cmd');
      await fs.writeFile(exe, '@echo off\n');
      const env = { PATH: dir } as NodeJS.ProcessEnv;
      expect(resolveExecutable('copilot', env, 'win32')).toBe(exe);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
