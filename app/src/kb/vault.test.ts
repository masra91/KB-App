// Domain tests for vault setup (SPEC-0009 SETUP-2/3/5). These exercise the real
// filesystem + real `git` against a throwaway temp vault (SPEC-0012 TEST-18) — vault
// logic whose whole job is FS/git is only meaningfully tested against real FS/git, kept
// hermetic by confining it to a temp dir. Requires `git` on PATH (a project dependency,
// STACK-4); the suite skips itself if git is absent.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import simpleGit from 'simple-git';
import { inspectPath, createKb, isGitInstalled } from './vault';
import { makeTempDir, rmTempDir, pathExists } from '../../test/tempVault';

function gitInstalledSync(): boolean {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const gitAvailable = gitInstalledSync();

describe('isGitInstalled', () => {
  it('detects system git on PATH (STACK-4)', async () => {
    expect(await isGitInstalled()).toBe(gitAvailable);
  });
});

describe.skipIf(!gitAvailable)('vault setup (SETUP-2/3/5)', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await makeTempDir();
  });
  afterEach(async () => {
    await rmTempDir(dir);
  });

  it('SETUP-2: inspectPath reports a non-existent path', async () => {
    const ins = await inspectPath(path.join(dir, 'does-not-exist'));
    expect(ins.exists).toBe(false);
    expect(ins.isDirectory).toBe(false);
    expect(ins.isGitRepo).toBe(false);
    expect(ins.alreadyKb).toBe(false);
    expect(typeof ins.copilot.available).toBe('boolean');
  });

  it('SETUP-2: inspectPath reports an existing empty (non-repo) directory', async () => {
    const ins = await inspectPath(dir);
    expect(ins.exists).toBe(true);
    expect(ins.isDirectory).toBe(true);
    expect(ins.isGitRepo).toBe(false);
    expect(ins.alreadyKb).toBe(false);
  });

  it('SETUP-3 + SETUP-5: createKb inits git, scaffolds structure, writes config, first commit', async () => {
    const target = path.join(dir, 'vault');
    const res = await createKb({ path: target, initGitIfNeeded: true });

    expect(res.ok).toBe(true);
    expect(res.committed).toBe(true);
    expect(res.vaultConfig?.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(res.vaultConfig?.name).toBe('vault'); // defaults to basename

    // DATA-1: the three content kinds, each tracked via .gitkeep.
    for (const d of ['sources', 'entities', 'outputs']) {
      expect(await pathExists(path.join(target, d, '.gitkeep'))).toBe(true);
    }
    expect(await pathExists(path.join(target, '.kb', 'config.json'))).toBe(true);
    expect(await pathExists(path.join(target, 'README.md'))).toBe(true);
    expect(await pathExists(path.join(target, '.gitignore'))).toBe(true);

    // SETUP-3: a git repo with exactly the one SETUP-5 initial commit.
    const git = simpleGit(target);
    expect(await git.checkIsRepo()).toBe(true);
    const log = await git.log();
    expect(log.total).toBe(1);
    expect(log.latest?.message).toContain('initialize knowledge base');
  });

  it('uses an explicit name when provided', async () => {
    const res = await createKb({ path: path.join(dir, 'v2'), name: 'My Brain', initGitIfNeeded: true });
    expect(res.vaultConfig?.name).toBe('My Brain');
  });

  it('SETUP-5: is idempotent — a second run commits nothing and preserves identity', async () => {
    const target = path.join(dir, 'v3');
    const first = await createKb({ path: target, initGitIfNeeded: true });
    const second = await createKb({ path: target, initGitIfNeeded: true });

    expect(second.ok).toBe(true);
    expect(second.committed).toBe(false);
    expect(second.message).toContain('already initialized');
    expect(second.vaultConfig?.id).toBe(first.vaultConfig?.id);
  });

  it('SETUP-3: refuses a non-repo folder when init is not allowed', async () => {
    const target = path.join(dir, 'v4');
    await fs.mkdir(target, { recursive: true });
    const res = await createKb({ path: target, initGitIfNeeded: false });
    expect(res.ok).toBe(false);
    expect(res.message).toContain('not a git repository');
  });

  it('SETUP-2: inspectPath flags an existing KB that is already a git repo', async () => {
    const target = path.join(dir, 'v5');
    await createKb({ path: target, initGitIfNeeded: true });
    const ins = await inspectPath(target);
    expect(ins.isGitRepo).toBe(true);
    expect(ins.alreadyKb).toBe(true);
  });
});
