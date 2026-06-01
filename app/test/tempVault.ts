// Shared test fixture: throwaway vault directories in the OS temp dir.
// SPEC-0012 TEST-18 — tests that touch a vault MUST use a temp dir, NEVER the app repo.
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Create a fresh, empty temp directory and return its absolute path. */
export async function makeTempDir(prefix = 'kb-test-'): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

/**
 * Remove a temp directory and everything under it (best-effort).
 *
 * Vault temp dirs are git repos, and git can leave a background process briefly
 * writing into `.git/objects/pack` after a commit returns — so a plain recursive
 * remove intermittently throws `ENOTEMPTY`/`EBUSY` (a teardown race, not a product
 * bug). `fs.rm`'s built-in `maxRetries`/`retryDelay` retries exactly these codes,
 * making teardown deterministic across runners (fixes a CI flake).
 */
export async function rmTempDir(dir: string): Promise<void> {
  await fs.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
}

/** True if a path exists. */
export async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}
