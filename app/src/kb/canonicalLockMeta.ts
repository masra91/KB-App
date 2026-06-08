// SPEC-0014 ORCH-27 — the canonical-writer lock SIDECAR. When `boundedGit` runs an index-touching op
// under the canonical-writer lock (the ff/cherry-pick in `advanceOrCollide`), it atomically records
// who holds the root repo's `.git/index.lock` and since when: `{pid, startedAt, op}`. The stale-lock
// self-heal (ORCH-27) reads this to prove ownership before EVER clearing a lock — a lock whose sidecar
// names a LIVE pid within the op-timeout window is genuinely held and MUST NOT be cleared (clearing a
// live lock corrupts the repo). The sidecar lives in `.kb/cache/` (working-zone, never canonical), so
// it is not committed and a crash leaves it behind as the evidence the heal needs.
//
// This module is ONLY the sidecar mechanism (write/read/clear); the stale-decision heuristic + the
// heal itself live alongside it (ORCH-27), gated on KB-Lead's ruling.
import { promises as fs } from 'node:fs';
import path from 'node:path';

/** Sidecar path: `.kb/cache/canonical-writer.lock.meta` under the vault root. */
export function lockMetaPath(root: string): string {
  return path.join(path.resolve(root), '.kb', 'cache', 'canonical-writer.lock.meta');
}

/** What the sidecar records about the in-flight holder of the root `index.lock` (ORCH-27 gate 2). */
export interface CanonicalLockMeta {
  /** OS pid of the process that took the lock — `kill(pid, 0)` proves alive/dead. */
  pid: number;
  /** Epoch ms when the index-op started — an age > 2× the op-timeout marks the lock stale. */
  startedAt: number;
  /** The operation holding it (e.g. `advance`) — for the audited why-stale record. */
  op: string;
}

/**
 * Atomically write the sidecar (write-temp + rename, so a reader never sees a half-written file).
 * Called as an index-touching op acquires the lock. Best-effort: a sidecar write must NEVER fail the
 * git op it annotates — the heal degrades safely to the no-sidecar (conservative) gate without it.
 */
export async function writeLockMeta(root: string, meta: CanonicalLockMeta): Promise<void> {
  const target = lockMetaPath(root);
  try {
    await fs.mkdir(path.dirname(target), { recursive: true });
    const tmp = `${target}.${meta.pid}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(meta), 'utf8');
    await fs.rename(tmp, target); // atomic replace
  } catch {
    /* best-effort: never let the sidecar break the op it annotates (ORCH-27 degrades to gate 3) */
  }
}

/** Read the sidecar, or null when absent/unreadable/corrupt (→ the no-sidecar conservative gate). */
export async function readLockMeta(root: string): Promise<CanonicalLockMeta | null> {
  try {
    const raw = await fs.readFile(lockMetaPath(root), 'utf8');
    const parsed = JSON.parse(raw) as Partial<CanonicalLockMeta>;
    if (typeof parsed.pid === 'number' && typeof parsed.startedAt === 'number' && typeof parsed.op === 'string') {
      return { pid: parsed.pid, startedAt: parsed.startedAt, op: parsed.op };
    }
    return null; // shape-invalid → treat as absent (fail safe, never trust a malformed sidecar)
  } catch {
    return null; // absent/unreadable
  }
}

/** Remove the sidecar (on clean release of the index-op, or after a heal clears a stale lock). */
export async function clearLockMeta(root: string): Promise<void> {
  await fs.rm(lockMetaPath(root), { force: true }).catch(() => {});
}
