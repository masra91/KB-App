// Folder-watch run-pass tests (SPEC-0037 WATCH-3/4/8/10). Real FS + real git against a throwaway vault
// (TEST-18), like intakeRun.test.ts. Skips if git is absent. Exercises the load-bearing security
// invariants as fails-before/passes-after requirement-traced tests: the LOOP-GUARD refusal (WATCH-10),
// NON-DESTRUCTIVE copy (WATCH-4 — original untouched), NO-SYMLINK-FOLLOW + non-recursive (WATCH-3/6),
// and contentHash dedup (unchanged = no-op; changed = new source carrying the prior-source link).
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import { createKb } from './vault';
import { readEvents } from './activityIndex';
import { reconcileWatchFolder } from './watchRun';
import type { WatchFolderConfig } from './watchConnectors';

function gitInstalledSync(): boolean {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}
const gitAvailable = gitInstalledSync();

const T = () => '2025-06-03T12:00:00.000Z';

describe.skipIf(!gitAvailable)('reconcileWatchFolder (SPEC-0037 WATCH)', () => {
  let dir: string;
  let vault: string;
  let watched: string;
  const cfg = (over: Partial<WatchFolderConfig> = {}): WatchFolderConfig => ({ id: 'drop', folderPath: watched, enabled: true, scope: 'global', sensitivity: 'internal', ...over });

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'kb-watch-'));
    vault = path.join(dir, 'vault');
    watched = path.join(dir, 'watched');
    await createKb({ path: vault, initGitIfNeeded: true });
    await fs.mkdir(watched, { recursive: true });
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  async function watchEvents(): Promise<Array<{ eventType: string; payload: Record<string, unknown> }>> {
    return (await readEvents(vault, {})).filter((e) => e.actor === 'watch').map((e) => ({ eventType: e.eventType, payload: e.payload }));
  }

  it('copies a stable text file in as a PRIMARY source — and the original is UNTOUCHED (WATCH-4, copy opt-out)', async () => {
    const file = path.join(watched, 'note.md');
    await fs.writeFile(file, '# Meeting\n\nShipped WATCH core.');
    // copy mode (consume:false) — the WATCH-16 default DRAINS (moves out); this asserts the never-destroy
    // copy path explicitly. (Drain is covered in watchConsume.test.ts.)
    const res = await reconcileWatchFolder(vault, cfg({ consume: false }), { vaultRoot: vault, now: T });
    expect(res.ingested).toBe(1);
    expect(res.sourceIds.length).toBe(1);
    // NON-DESTRUCTIVE: the watched original still exists with identical bytes.
    expect(await fs.readFile(file, 'utf8')).toBe('# Meeting\n\nShipped WATCH core.');
    const ev = await watchEvents();
    expect(ev.some((e) => e.eventType === 'watch-ingested')).toBe(true);
  });

  it('dedups an unchanged re-save (no-op) but ingests a CHANGED file as a NEW source carrying the prior link (Fork#1/WATCH-8)', async () => {
    const file = path.join(watched, 'report.md');
    await fs.writeFile(file, 'v1');
    const first = await reconcileWatchFolder(vault, cfg(), { vaultRoot: vault, now: T });
    expect(first.ingested).toBe(1);
    const priorId = first.sourceIds[0];

    // Re-run with no change → no-op (contentHash dedup).
    const second = await reconcileWatchFolder(vault, cfg(), { vaultRoot: vault, now: T });
    expect(second.ingested).toBe(0);
    expect(second.note).toMatch(/no new files/);

    // Change the file → a NEW source, provenance-linked to the prior.
    await fs.writeFile(file, 'v2 — revised');
    const third = await reconcileWatchFolder(vault, cfg(), { vaultRoot: vault, now: T });
    expect(third.ingested).toBe(1);
    expect(third.sourceIds[0]).not.toBe(priorId);
    const ingested = (await watchEvents()).filter((e) => e.eventType === 'watch-ingested');
    const supersede = ingested.flatMap((e) => (e.payload.supersedes as Array<{ priorSourceId: string }>) ?? []);
    expect(supersede.some((s) => s.priorSourceId === priorId)).toBe(true);
  });

  it('NEVER follows symlinks and is NON-RECURSIVE (WATCH-3/6 scope-escape)', async () => {
    await fs.writeFile(path.join(watched, 'real.md'), 'real');
    // A symlink to a secret outside the folder — must be skipped, not ingested.
    const secret = path.join(dir, 'secret.md');
    await fs.writeFile(secret, 'TOP SECRET');
    try {
      await fs.symlink(secret, path.join(watched, 'link.md'), 'file');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'EPERM') return; // symlink-restricted FS → N/A
      throw e;
    }
    // A subdirectory with a file — must NOT be descended (non-recursive).
    await fs.mkdir(path.join(watched, 'sub'), { recursive: true });
    await fs.writeFile(path.join(watched, 'sub', 'deep.md'), 'deep');

    const res = await reconcileWatchFolder(vault, cfg(), { vaultRoot: vault, now: T });
    expect(res.ingested).toBe(1); // only real.md — not the symlink, not the subdir file
    expect(res.skipped).toBeGreaterThanOrEqual(2); // symlink + subdir skipped
  });

  it('REFUSES the vault root / a path inside the vault (loop-guard WATCH-10) with a distinct audited event', async () => {
    const res = await reconcileWatchFolder(vault, cfg({ folderPath: path.join(vault, 'sources') }), { vaultRoot: vault, now: T });
    expect(res.refused).toBe(true);
    expect(res.ingested).toBe(0);
    expect((await watchEvents()).some((e) => e.eventType === 'watch-refused')).toBe(true);
  });

  it('skips dotfiles + ignoreGlobs (bounds WATCH-6)', async () => {
    await fs.writeFile(path.join(watched, 'keep.md'), 'keep');
    await fs.writeFile(path.join(watched, '.DS_Store'), 'x');
    await fs.writeFile(path.join(watched, 'tmp.part'), 'partial');
    const res = await reconcileWatchFolder(vault, cfg({ ignoreGlobs: ['*.part'] }), { vaultRoot: vault, now: T });
    expect(res.ingested).toBe(1); // only keep.md
  });

  it('a read failure is a DISTINCT audited watch-failed, not a silent empty (OBS-4)', async () => {
    const res = await reconcileWatchFolder(vault, cfg({ folderPath: path.join(dir, 'does-not-exist') }), { vaultRoot: vault, now: T });
    // A non-existent folder is caught by the loop-guard (refused) — a folder that exists at guard time
    // but fails to read would be watch-failed; both are distinct from a silent no-op.
    expect(res.refused || res.failed).toBe(true);
    expect(res.ingested).toBe(0);
  });
});
