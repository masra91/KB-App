// Domain tests for vault setup (SPEC-0009 SETUP-2/3/5). These exercise the real
// filesystem + real `git` against a throwaway temp vault (SPEC-0012 TEST-18) — vault
// logic whose whole job is FS/git is only meaningfully tested against real FS/git, kept
// hermetic by confining it to a temp dir. Requires `git` on PATH (a project dependency,
// STACK-4); the suite skips itself if git is absent.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import simpleGit from 'simple-git';

// Copilot detection is an external subprocess effect with its own tests (copilot.test.ts).
// Stub it here so vault/inspectPath tests stay hermetic and fast — never shelling out to
// `copilot`/`gh` (which hangs to its timeout on machines that have `gh` but not the
// extension, e.g. CI runners). TEST-2: no uncontrolled external env beyond `git`.
vi.mock('./copilot', () => ({
  detectCopilot: vi.fn(async () => ({ available: false, detail: 'stubbed in vault tests' })),
}));

import { inspectPath, createKb, isGitInstalled, detectTccProtectedDir } from './vault';
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

// Pure path classifier — no FS/git, so it runs everywhere (home + platform injected). BUG #56.
describe('detectTccProtectedDir (BUG #56 / STACK-10)', () => {
  const home = '/Users/alice';

  it('flags a vault directly inside a protected dir', () => {
    expect(detectTccProtectedDir('/Users/alice/Documents/MyVault', home, 'darwin')).toBe('Documents');
    expect(detectTccProtectedDir('/Users/alice/Desktop/kb', home, 'darwin')).toBe('Desktop');
    expect(detectTccProtectedDir('/Users/alice/Downloads/notes', home, 'darwin')).toBe('Downloads');
  });

  it('flags a deeply nested vault inside a protected dir', () => {
    expect(detectTccProtectedDir('/Users/alice/Documents/a/b/c/vault', home, 'darwin')).toBe('Documents');
  });

  it('flags the protected dir itself', () => {
    expect(detectTccProtectedDir('/Users/alice/Documents', home, 'darwin')).toBe('Documents');
  });

  it('flags the iCloud Drive container', () => {
    const icloud = '/Users/alice/Library/Mobile Documents/com~apple~CloudDocs/vault';
    expect(detectTccProtectedDir(icloud, home, 'darwin')).toBe('iCloud Drive');
  });

  it('does not flag a safe location outside protected dirs', () => {
    expect(detectTccProtectedDir('/Users/alice/kb', home, 'darwin')).toBeNull();
    expect(detectTccProtectedDir('/Users/alice/projects/kb', home, 'darwin')).toBeNull();
    expect(detectTccProtectedDir('/tmp/vault', home, 'darwin')).toBeNull();
  });

  it('does not flag a sibling whose name merely shares a prefix', () => {
    // `DocumentsArchive` is not inside `Documents` — guard against a naive startsWith.
    expect(detectTccProtectedDir('/Users/alice/DocumentsArchive/kb', home, 'darwin')).toBeNull();
  });

  it('only applies on macOS (TCC is darwin-only)', () => {
    expect(detectTccProtectedDir('/Users/alice/Documents/kb', home, 'linux')).toBeNull();
    expect(detectTccProtectedDir('C:\\Users\\alice\\Documents\\kb', home, 'win32')).toBeNull();
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
