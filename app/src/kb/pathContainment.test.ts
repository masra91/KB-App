// SPEC-0030 / #30 — shared rel-containment helper. Node tier, real fs (temp dirs + a committed
// symlink), since the whole point is symlink-safe resolution. Mirrors the #61 T-matrix shape
// (traversal / absolute / `a/../sources` / committed-symlink-escape / allowlist / root-itself).
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { checkContainedRel, resolveContainedRel, assertContainedRel, ContainmentError } from './pathContainment';

let root: string;
let outside: string;
beforeEach(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'kb-contain-')));
  outside = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'kb-outside-')));
  await fs.mkdir(path.join(root, 'entities'), { recursive: true });
  await fs.writeFile(path.join(root, 'entities', 'ok.md'), 'x', 'utf8');
  await fs.writeFile(path.join(outside, 'secret.txt'), 'TOP SECRET', 'utf8');
});
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
  await fs.rm(outside, { recursive: true, force: true });
});

describe('checkContainedRel — containment (Class A)', () => {
  it('accepts a rel within the root and returns the lexical abs', async () => {
    const r = await checkContainedRel(root, 'entities/ok.md');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.abs).toBe(path.resolve(root, 'entities/ok.md'));
  });

  it('rejects `..` traversal, absolute paths, and mid-path escapes', async () => {
    for (const rel of ['../escape', '../../etc/passwd', 'entities/../../x', '/etc/passwd']) {
      const r = await checkContainedRel(root, rel);
      expect(r.ok, rel).toBe(false);
      if ('kind' in r) expect(r.kind).toBe('escape');
    }
  });

  it('rejects an empty/invalid rel and the root itself', async () => {
    expect((await checkContainedRel(root, '')).ok).toBe(false);
    expect((await checkContainedRel(root, '.')).ok).toBe(false); // resolves to root → escape
  });

  it('is SYMLINK-SAFE: a committed symlink escaping the root is rejected (not lexically contained)', async () => {
    // entities/evil -> <outside> ; a read/write "under" it would follow out of the root.
    await fs.symlink(outside, path.join(root, 'entities', 'evil'));
    const r = await checkContainedRel(root, 'entities/evil/secret.txt', ['entities']);
    expect(r.ok).toBe(false);
    if ('kind' in r) expect(r.kind).toBe('escape');
    // lexical-only resolution would have WRONGLY accepted it (starts with root + /entities/):
    expect(path.resolve(root, 'entities/evil/secret.txt').startsWith(root + path.sep)).toBe(true);
  });

  it('enforces the allowlist on the top-level subtree when given', async () => {
    expect((await checkContainedRel(root, 'entities/ok.md', ['entities'])).ok).toBe(true);
    const r = await checkContainedRel(root, '.git/config', ['entities']);
    expect(r.ok).toBe(false);
    if ('kind' in r) expect(r.kind).toBe('not-allowed');
    // sources excluded even though contained (the #61 invariant: jobs never write ground truth)
    const s = await checkContainedRel(root, 'sources/x.md', ['entities', 'claims', 'outputs']);
    expect(s.ok).toBe(false);
    if ('kind' in s) expect(s.kind).toBe('not-allowed');
  });
});

describe('ergonomics', () => {
  it('resolveContainedRel returns the abs or null (skip-on-escape, reads never throw)', async () => {
    expect(await resolveContainedRel(root, 'entities/ok.md')).toBe(path.resolve(root, 'entities/ok.md'));
    expect(await resolveContainedRel(root, '../escape')).toBeNull();
  });

  it('assertContainedRel returns the abs or throws ContainmentError (writes/deletes)', async () => {
    await expect(assertContainedRel(root, 'entities/ok.md', ['entities'])).resolves.toBe(path.resolve(root, 'entities/ok.md'));
    await expect(assertContainedRel(root, '../escape', ['entities'])).rejects.toBeInstanceOf(ContainmentError);
    await expect(assertContainedRel(root, 'sources/x', ['entities'])).rejects.toMatchObject({ kind: 'not-allowed' });
  });
});
