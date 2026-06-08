// SPEC-0014 ORCH-27 — sidecar mechanism tests. The sidecar is the evidence the stale-lock heal uses
// to prove ownership before clearing a lock, so its write/read/clear must be exact + fail-safe.
import { describe, it, expect, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import { makeTempDir, rmTempDir } from '../../test/tempVault';
import { writeLockMeta, readLockMeta, clearLockMeta, lockMetaPath, type CanonicalLockMeta } from './canonicalLockMeta';

describe('ORCH-27 canonical-writer lock sidecar', () => {
  let root: string;
  afterEach(async () => {
    if (root) await rmTempDir(root);
  });

  it('round-trips {pid, startedAt, op}', async () => {
    root = await makeTempDir('kb-lockmeta-');
    const meta: CanonicalLockMeta = { pid: 4242, startedAt: 1_700_000_000_000, op: 'advance' };
    await writeLockMeta(root, meta);
    expect(await readLockMeta(root)).toEqual(meta);
  });

  it('writes under .kb/cache/ (working-zone, never committed)', async () => {
    root = await makeTempDir('kb-lockmeta-');
    await writeLockMeta(root, { pid: 1, startedAt: 1, op: 'advance' });
    expect(lockMetaPath(root).endsWith('/.kb/cache/canonical-writer.lock.meta')).toBe(true);
    await expect(fs.access(lockMetaPath(root))).resolves.toBeUndefined();
  });

  it('read returns null when the sidecar is absent (→ the no-sidecar conservative gate)', async () => {
    root = await makeTempDir('kb-lockmeta-');
    expect(await readLockMeta(root)).toBeNull();
  });

  it('read returns null on a corrupt/shape-invalid sidecar (never trust a malformed meta)', async () => {
    root = await makeTempDir('kb-lockmeta-');
    await fs.mkdir(`${root}/.kb/cache`, { recursive: true });
    await fs.writeFile(lockMetaPath(root), '{ not valid json', 'utf8');
    expect(await readLockMeta(root)).toBeNull();
    await fs.writeFile(lockMetaPath(root), JSON.stringify({ pid: 'nope' }), 'utf8');
    expect(await readLockMeta(root)).toBeNull(); // wrong-typed fields → treated as absent
  });

  it('clear removes the sidecar and is idempotent (safe when already gone)', async () => {
    root = await makeTempDir('kb-lockmeta-');
    await writeLockMeta(root, { pid: 7, startedAt: 2, op: 'advance' });
    await clearLockMeta(root);
    expect(await readLockMeta(root)).toBeNull();
    await expect(clearLockMeta(root)).resolves.toBeUndefined(); // idempotent — no throw on a missing file
  });

  it('a later write atomically replaces an earlier one (last writer wins, no partial state)', async () => {
    root = await makeTempDir('kb-lockmeta-');
    await writeLockMeta(root, { pid: 1, startedAt: 100, op: 'advance' });
    await writeLockMeta(root, { pid: 2, startedAt: 200, op: 'reconcile' });
    expect(await readLockMeta(root)).toEqual({ pid: 2, startedAt: 200, op: 'reconcile' });
  });
});
