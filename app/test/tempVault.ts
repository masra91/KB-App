// Shared test fixture: throwaway vault directories in the OS temp dir.
// SPEC-0012 TEST-18 — tests that touch a vault MUST use a temp dir, NEVER the app repo.
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Create a fresh, empty temp directory and return its absolute path. */
export async function makeTempDir(prefix = 'kb-test-'): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

/** Remove a temp directory and everything under it (best-effort). */
export async function rmTempDir(dir: string): Promise<void> {
  await fs.rm(dir, { recursive: true, force: true });
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
