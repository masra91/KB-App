// SPEC-0014 ORCH-27 — stale-lock self-heal tests. The never-clear-a-live-lock cases are the
// GATE-OF-RECORD (KB-Lead): a live sidecar-pid, a fresh external lock, an inconclusive scan, and a
// live in-process op must EACH be left untouched — clearing a live lock corrupts the repo.
import { describe, it, expect, afterEach, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { makeTempDir, rmTempDir } from '../../test/tempVault';
import {
  classifyIndexLock,
  reconcileStaleIndexLock,
  resolveIndexLockPath,
  GATE3_STALE_AGE_MS,
  type ClassifyInputs,
} from './canonicalLockHeal';
import { writeLockMeta, readLockMeta, type CanonicalLockMeta } from './canonicalLockMeta';

const NOW = 1_700_000_000_000;
const base = (over: Partial<ClassifyInputs> = {}): ClassifyInputs => ({
  lockExists: true,
  lockAgeMs: 0,
  meta: null,
  liveInProcHolder: false,
  selfPid: 1000,
  pidAlive: () => true,
  externalGitScan: 'none',
  now: NOW,
  ...over,
});
const meta = (over: Partial<CanonicalLockMeta> = {}): CanonicalLockMeta => ({ pid: 4242, startedAt: NOW, op: 'advance', timeoutMs: 20_000, ...over });
// A complete DevLog whose `warn` is a spy (the others noop). `child` returns self so scoped logging works.
const fakeLog = () => {
  const warn = vi.fn();
  const log = { debug: vi.fn(), info: vi.fn(), warn, error: vi.fn(), child: () => log, flush: async () => {} };
  return { log, warn };
};

describe('ORCH-27 classifyIndexLock (PURE triple-gate truth table)', () => {
  it('no lock on disk → absent (the healthy common case)', () => {
    expect(classifyIndexLock(base({ lockExists: false }))).toEqual({ action: 'absent' });
  });

  // GATE 1 — live in-process holder
  it('SAFETY gate-1: a live in-process index-op holds it → KEEP (even if a sidecar looks dead)', () => {
    const v = classifyIndexLock(base({ liveInProcHolder: true, meta: meta({ pid: 999999, startedAt: 0 }), pidAlive: () => false }));
    expect(v.action).toBe('keep');
  });

  // GATE 2 — sidecar present
  it('gate-2: sidecar pid is DEAD → clear', () => {
    const v = classifyIndexLock(base({ meta: meta({ pid: 4242 }), pidAlive: () => false }));
    expect(v.action).toBe('clear');
  });

  it('gate-2: sidecar pid == self with no live in-proc op → clear (our prior op leaked it)', () => {
    const v = classifyIndexLock(base({ selfPid: 1000, meta: meta({ pid: 1000 }), pidAlive: () => true }));
    expect(v.action).toBe('clear');
    if (v.action === 'clear') expect(v.reason).toContain('self');
  });

  it('gate-2: sidecar pid alive (other proc) but age > 2×timeout → clear (detached leak)', () => {
    const v = classifyIndexLock(base({ meta: meta({ pid: 4242, startedAt: NOW - 41_000, timeoutMs: 20_000 }), pidAlive: () => true, now: NOW }));
    expect(v.action).toBe('clear');
  });

  it('SAFETY gate-2: sidecar pid alive (other proc) AND within age → KEEP (a live op in another instance)', () => {
    const v = classifyIndexLock(base({ meta: meta({ pid: 4242, startedAt: NOW - 5_000, timeoutMs: 20_000 }), pidAlive: () => true, now: NOW }));
    expect(v.action).toBe('keep');
  });

  // GATE 3 — no sidecar (external holder)
  it('SAFETY gate-3: no sidecar + a LIVE external git process → KEEP', () => {
    expect(classifyIndexLock(base({ meta: null, externalGitScan: 'present', lockAgeMs: GATE3_STALE_AGE_MS * 10 })).action).toBe('keep');
  });

  it('SAFETY gate-3: no sidecar + INCONCLUSIVE scan → KEEP (fail safe, never clear on a scan we could not run)', () => {
    expect(classifyIndexLock(base({ meta: null, externalGitScan: 'inconclusive', lockAgeMs: GATE3_STALE_AGE_MS * 10 })).action).toBe('keep');
  });

  it('SAFETY gate-3: no sidecar + no live git but lock is FRESH (≤ threshold) → KEEP', () => {
    expect(classifyIndexLock(base({ meta: null, externalGitScan: 'none', lockAgeMs: GATE3_STALE_AGE_MS - 1 })).action).toBe('keep');
  });

  it('SAFETY gate-3: no sidecar + lock age UNKNOWN → KEEP (fail safe)', () => {
    expect(classifyIndexLock(base({ meta: null, externalGitScan: 'none', lockAgeMs: null })).action).toBe('keep');
  });

  it('gate-3: no sidecar + no live git + lock OLDER than threshold → clear', () => {
    expect(classifyIndexLock(base({ meta: null, externalGitScan: 'none', lockAgeMs: GATE3_STALE_AGE_MS + 1 })).action).toBe('clear');
  });
});

describe('ORCH-27 reconcileStaleIndexLock (wiring + heal)', () => {
  let root: string;
  afterEach(async () => {
    if (root) await rmTempDir(root);
  });

  const makeIndexLock = async (r: string): Promise<string> => {
    await fs.mkdir(path.join(r, '.git'), { recursive: true });
    const p = await resolveIndexLockPath(r);
    await fs.writeFile(p, '', 'utf8');
    return p;
  };

  it('no lock → absent, nothing cleared', async () => {
    root = await makeTempDir('kb-heal-');
    await fs.mkdir(path.join(root, '.git'), { recursive: true });
    const audit = vi.fn();
    expect(await reconcileStaleIndexLock(root, { isLiveInProcHolder: () => false, audit })).toEqual({ action: 'absent' });
    expect(audit).not.toHaveBeenCalled();
  });

  it('gate-2: a dead-pid sidecar lock is CLEARED — lock + sidecar removed, clear audited + dev-logged', async () => {
    root = await makeTempDir('kb-heal-');
    const lock = await makeIndexLock(root);
    await writeLockMeta(root, { pid: 4242, startedAt: NOW, op: 'advance', timeoutMs: 20_000 });
    const audit = vi.fn();
    const { log, warn } = fakeLog();

    const v = await reconcileStaleIndexLock(root, {
      isLiveInProcHolder: () => false,
      pidAlive: () => false, // the recorded pid is dead
      now: () => NOW,
      audit,
      log,
    });

    expect(v.action).toBe('clear');
    await expect(fs.access(lock)).rejects.toThrow(); // index.lock removed
    expect(await readLockMeta(root)).toBeNull(); // sidecar removed
    expect(audit).toHaveBeenCalledTimes(1); // every clear audited
    expect(warn).toHaveBeenCalledWith('orch.lock.healed', expect.objectContaining({ lock })); // visible, not silent
  });

  it('SAFETY: a live in-process holder → KEEP, the lock is NOT removed', async () => {
    root = await makeTempDir('kb-heal-');
    const lock = await makeIndexLock(root);
    await writeLockMeta(root, { pid: 4242, startedAt: NOW, op: 'advance', timeoutMs: 20_000 });
    const audit = vi.fn();
    const v = await reconcileStaleIndexLock(root, { isLiveInProcHolder: () => true, pidAlive: () => false, now: () => NOW, audit });
    expect(v.action).toBe('keep');
    await expect(fs.access(lock)).resolves.toBeUndefined(); // lock untouched
    expect(audit).not.toHaveBeenCalled();
  });

  it('SAFETY: a live sidecar pid within age → KEEP, lock NOT removed (a live op in another instance)', async () => {
    root = await makeTempDir('kb-heal-');
    const lock = await makeIndexLock(root);
    await writeLockMeta(root, { pid: 4242, startedAt: NOW - 5_000, op: 'advance', timeoutMs: 20_000 });
    const v = await reconcileStaleIndexLock(root, { isLiveInProcHolder: () => false, pidAlive: () => true, now: () => NOW });
    expect(v.action).toBe('keep');
    await expect(fs.access(lock)).resolves.toBeUndefined();
  });

  it('SAFETY: no sidecar + inconclusive external scan → KEEP + held-stall surfaced (visible)', async () => {
    root = await makeTempDir('kb-heal-');
    const lock = await makeIndexLock(root);
    const { log, warn } = fakeLog();
    const v = await reconcileStaleIndexLock(root, {
      isLiveInProcHolder: () => false,
      scanExternalGit: async () => 'inconclusive',
      now: () => NOW,
      log,
    });
    expect(v.action).toBe('keep');
    await expect(fs.access(lock)).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith('orch.lock.held', expect.anything()); // the stall is named, never silent
  });

  // REGRESSION (fails-before/passes-after, the CLASS = "a stale lock left by a crash wedges every
  // future advance until healed"): a leaked dead-pid lock must be cleared so a subsequent acquire can
  // proceed. Before ORCH-27 the lock persisted and every advance stayed wedged (#256).
  it('REGRESSION #256: a crash-leaked stale lock is healed so the next advance is unblocked', async () => {
    root = await makeTempDir('kb-heal-');
    const lock = await makeIndexLock(root);
    await writeLockMeta(root, { pid: 999_999, startedAt: NOW - 10 * 60_000, op: 'advance', timeoutMs: 20_000 }); // dead crashed proc
    const v = await reconcileStaleIndexLock(root, { isLiveInProcHolder: () => false, pidAlive: () => false, now: () => NOW });
    expect(v.action).toBe('clear');
    await expect(fs.access(lock)).rejects.toThrow(); // wedge cleared → a fresh acquire can now take index.lock
  });
});
