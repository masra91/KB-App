// WatchScheduler lifecycle (SPEC-0037 WATCH-2/8). Real KB + git (TEST-18); the chokidar watcher is
// injected as a fake so the lifecycle is deterministic (no real fs-event timing). Asserts: a STARTUP
// RECONCILE ingests pre-existing files (restart-reconcile), a live event drives an (idempotent) reconcile
// that picks up a new file, `watchingIds` reflects enabled folders, and disabling tears the watcher down.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import { createKb } from './vault';
import { readEvents } from './activityIndex';
import { upsertWatchFolder, patchWatchFolder } from './watchRegistry';
import { WatchScheduler, type WatcherFactory, type WatchHandle } from './watchScheduler';

function gitInstalledSync(): boolean {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}
const gitAvailable = gitInstalledSync();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** Poll `fn` until it reaches `target` or the timeout — robust against the reconcile's git-commit timing. */
async function waitUntil(fn: () => Promise<number>, target: number, timeoutMs = 4000): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  let v = await fn();
  while (v < target && Date.now() < deadline) {
    await sleep(25);
    v = await fn();
  }
  return v;
}

describe.skipIf(!gitAvailable)('WatchScheduler (SPEC-0037)', () => {
  let dir: string;
  let vault: string;
  let watched: string;
  let fire: (() => void) | null;
  let closed: number;
  let factory: WatcherFactory;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'kb-watchsched-'));
    vault = path.join(dir, 'vault');
    watched = path.join(dir, 'watched');
    await createKb({ path: vault, initGitIfNeeded: true });
    await fs.mkdir(watched, { recursive: true });
    fire = null;
    closed = 0;
    factory = (_folderPath, onChange): WatchHandle => {
      fire = onChange; // capture so the test can drive a "file event"
      return { close() { closed++; } };
    };
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  async function ingestedCount(): Promise<number> {
    return (await readEvents(vault, {})).filter((e) => e.actor === 'watch' && e.eventType === 'watch-ingested').length;
  }

  it('startup reconcile ingests a pre-existing file; a live event ingests a newly-added one', async () => {
    await fs.writeFile(path.join(watched, 'a.md'), 'A');
    await upsertWatchFolder(vault, { id: 'drop', folderPath: watched, enabled: true, scope: 'global', sensitivity: 'internal' });
    const sched = new WatchScheduler(vault, vault, undefined, { watcherFactory: factory, debounceMs: 0 });

    await sched.refresh(); // = what start() kicks off; awaited for determinism
    expect(sched.watchingIds().has('drop')).toBe(true);
    expect(await ingestedCount()).toBe(1); // a.md via the startup reconcile

    // A new file arrives; the live watcher fires → debounced reconcile ingests it.
    await fs.writeFile(path.join(watched, 'b.md'), 'B');
    expect(fire).toBeTypeOf('function');
    fire!();
    expect(await waitUntil(ingestedCount, 2)).toBe(2); // b.md picked up by the event-driven reconcile

    sched.stop();
    expect(closed).toBe(1);
  });

  it('refresh tears down a watcher when its folder is disabled', async () => {
    await upsertWatchFolder(vault, { id: 'drop', folderPath: watched, enabled: true, scope: 'global', sensitivity: 'internal' });
    const sched = new WatchScheduler(vault, vault, undefined, { watcherFactory: factory, debounceMs: 0 });
    await sched.refresh();
    expect(sched.watchingIds().has('drop')).toBe(true);

    await patchWatchFolder(vault, 'drop', { enabled: false });
    await sched.refresh();
    expect(sched.watchingIds().has('drop')).toBe(false);
    expect(closed).toBe(1);
  });

  it('never provisions a watcher for a loop-unsafe folder (inside the vault)', async () => {
    await upsertWatchFolder(vault, { id: 'bad', folderPath: path.join(vault, 'sources'), enabled: true, scope: 'global', sensitivity: 'internal' });
    const sched = new WatchScheduler(vault, vault, undefined, { watcherFactory: factory, debounceMs: 0 });
    await sched.refresh();
    expect(sched.watchingIds().has('bad')).toBe(false); // loop-guard kept it from being watched
  });
});
