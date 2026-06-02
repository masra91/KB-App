// The Code researcher's read-only git layer (SPEC-0028 RESEARCH-10, Slice 2a). Pure security logic
// (arg-building + value guards + workspace containment) is network/process-free; the executor is
// exercised against a REAL local temp repo (git required; skipped if absent).
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { makeTempDir, rmTempDir } from '../../test/tempVault';
import {
  researcherWorkspace,
  isSafeGitValue,
  isSafeGitRef,
  isSafeRepoPath,
  buildGitReadArgs,
  assertLocalRepoSource,
  cloneOrRefresh,
  gitRead,
} from './codeGit';

function gitInstalledSync(): boolean {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}
const gitAvailable = gitInstalledSync();

describe('researcherWorkspace — sandbox containment (RESEARCH-10)', () => {
  it('builds a contained .kb/cache/researchers/<id> path for a safe id', () => {
    expect(researcherWorkspace('/vault', 'code-1')).toBe(path.join('/vault', '.kb', 'cache', 'researchers', 'code-1'));
  });
  it('refuses an unsafe (path-traversal) id before building any path', () => {
    expect(() => researcherWorkspace('/vault', '../../etc')).toThrow(/unsafe researcher id/);
    expect(() => researcherWorkspace('/vault', 'a/b')).toThrow(/unsafe researcher id/);
  });
});

describe('value guards — the option-injection defense (RESEARCH-10)', () => {
  it('isSafeGitValue rejects flags, control bytes, empty, overlong', () => {
    expect(isSafeGitValue('main')).toBe(true);
    expect(isSafeGitValue('-c')).toBe(false); // a flag
    expect(isSafeGitValue('--upload-pack=evil')).toBe(false);
    expect(isSafeGitValue('a\nb')).toBe(false);
    expect(isSafeGitValue('a\0b')).toBe(false);
    expect(isSafeGitValue('')).toBe(false);
    expect(isSafeGitValue('x'.repeat(513))).toBe(false);
  });
  it('isSafeGitRef enforces the ref charset + no `..` range', () => {
    expect(isSafeGitRef('origin/main')).toBe(true);
    expect(isSafeGitRef('v1.2.3')).toBe(true);
    expect(isSafeGitRef('a..b')).toBe(false); // range
    expect(isSafeGitRef('a b')).toBe(false); // space
    expect(isSafeGitRef('HEAD~1')).toBe(false); // peel op outside charset
  });
  it('isSafeRepoPath rejects absolute + traversal', () => {
    expect(isSafeRepoPath('src/index.ts')).toBe(true);
    expect(isSafeRepoPath('/etc/passwd')).toBe(false);
    expect(isSafeRepoPath('../secret')).toBe(false);
    expect(isSafeRepoPath('a/../../b')).toBe(false);
  });
});

describe('buildGitReadArgs — structured read-only ops, never a raw subcommand (RESEARCH-10)', () => {
  it('log: bounded, no-color, with guarded ref + path after `--`', () => {
    const args = buildGitReadArgs({ kind: 'log', maxCount: 5, ref: 'origin/main', path: 'src/a.ts' });
    expect(args[0]).toBe('log');
    expect(args).toContain('--max-count=5');
    expect(args).toContain('origin/main');
    expect(args.slice(-2)).toEqual(['--', 'src/a.ts']); // pathspec after the separator
  });
  it('log: clamps an absurd maxCount + defaults a missing one', () => {
    expect(buildGitReadArgs({ kind: 'log', maxCount: 99999 })).toContain('--max-count=500');
    expect(buildGitReadArgs({ kind: 'log' })).toContain('--max-count=20');
  });
  it('show: reads <ref>:<path> as one object name (path can never be a flag)', () => {
    expect(buildGitReadArgs({ kind: 'show', ref: 'HEAD', path: 'README.md' })).toEqual(['show', '--no-color', 'HEAD:README.md']);
  });
  it('grep: pattern passed via `-e` with fixed-strings (never parsed as an option)', () => {
    const args = buildGitReadArgs({ kind: 'grep', pattern: 'TODO' });
    expect(args).toEqual(['grep', '--no-color', '-n', '-I', '--fixed-strings', '-e', 'TODO']);
  });
  it('THROWS on an injected ref/path/pattern rather than emitting it', () => {
    expect(() => buildGitReadArgs({ kind: 'log', ref: '--output=/tmp/x' })).toThrow(/unsafe ref/);
    expect(() => buildGitReadArgs({ kind: 'show', ref: 'HEAD', path: '../../etc/passwd' })).toThrow(/unsafe path/);
    expect(() => buildGitReadArgs({ kind: 'grep', pattern: '-O/tmp/x' })).toThrow(/unsafe pattern/);
    expect(() => buildGitReadArgs({ kind: 'diff', refA: 'main', refB: '--upload-pack=evil' })).toThrow(/unsafe ref/);
  });
});

describe.skipIf(!gitAvailable)('assertLocalRepoSource + cloneOrRefresh + gitRead (real git, local repo)', () => {
  async function makeSourceRepo(dir: string): Promise<string> {
    const src = path.join(dir, 'source-repo');
    await fs.mkdir(src, { recursive: true });
    const g = (args: string[]): void => {
      execFileSync('git', args, { cwd: src, stdio: 'ignore' });
    };
    g(['init', '-q']);
    g(['config', 'user.email', 't@t']);
    g(['config', 'user.name', 'T']);
    await fs.writeFile(path.join(src, 'README.md'), '# Atlas\nThe Atlas launch codename.\n');
    g(['add', '.']);
    g(['commit', '-q', '-m', 'initial: Atlas readme']);
    return src;
  }

  it('rejects a non-absolute / non-existent / non-repo source', async () => {
    await expect(assertLocalRepoSource('relative/path')).rejects.toThrow(/absolute local path/);
    await expect(assertLocalRepoSource('/no/such/path/xyz')).rejects.toThrow(/does not exist/);
  });

  it('clones a local repo into the contained workspace + reads it; refresh is a no-op fetch; source is untouched', async () => {
    const dir = await makeTempDir();
    try {
      const src = await makeSourceRepo(dir);
      const vault = path.join(dir, 'vault');
      const ws = researcherWorkspace(vault, 'code-1');

      await cloneOrRefresh(ws, src, { depth: 1 });
      // the clone landed under the gitignored .kb/cache, NOT the user's tree
      expect(ws.includes(path.join('.kb', 'cache', 'researchers'))).toBe(true);
      expect(await fs.stat(path.join(ws, '.git')).then(() => true)).toBe(true);

      // read: ls-files sees the file; show reads the blob; grep finds the term (with line number)
      expect(await gitRead(ws, { kind: 'lsFiles' })).toContain('README.md');
      expect(await gitRead(ws, { kind: 'show', ref: 'HEAD', path: 'README.md' })).toContain('Atlas launch codename');
      expect(await gitRead(ws, { kind: 'grep', pattern: 'Atlas' })).toMatch(/README\.md:\d+:/);

      // refresh path (workspace already cloned → fetch) does not throw
      await cloneOrRefresh(ws, src, { depth: 1 });

      // read-only world: the SOURCE repo still has exactly one commit (clone never wrote to it)
      const srcLog = execFileSync('git', ['-C', src, 'rev-list', '--count', 'HEAD']).toString().trim();
      expect(srcLog).toBe('1');
    } finally {
      await rmTempDir(dir);
    }
  });
});
