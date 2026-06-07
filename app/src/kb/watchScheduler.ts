// The folder-watch scheduler (SPEC-0037 WATCH-2) — the live watcher that drives reconcile passes. It is
// deliberately THIN: all the load-bearing logic (loop-guard, non-recursive scan, no-symlink, contentHash
// dedup, non-destructive copy → INGEST, audit) lives in the tested `reconcileWatchFolder` core; this just
// (1) runs a STARTUP RECONCILE for each enabled folder (catches files added while the app was off — the
// restart-reconcile, WATCH-8) and (2) opens a chokidar watcher per folder that, debounced, re-runs the
// same idempotent reconcile on add/change. chokidar is configured non-recursive (`depth:0`) and to NEVER
// follow symlinks (`followSymlinks:false`) — defense-in-depth alongside the core's own skips.
//
// The watcher factory is injected (default = chokidar) so the lifecycle is unit-testable without real
// filesystem-event timing; production wires the real chokidar.
import chokidar from 'chokidar';
import { reconcileWatchFolder } from './watchRun';
import { readWatchRegistry } from './watchRegistry';
import { checkWatchLoopSafe, type WatchFolderConfig } from './watchConnectors';
import { noopDevLog, type DevLog } from './devlog';

/** A live watcher handle (the subset of chokidar's FSWatcher we use). Injectable for tests. */
export interface WatchHandle {
  close(): Promise<void> | void;
}

/** Build a live watcher over `folderPath` that calls `onChange()` (debounced upstream) on add/change.
 *  Non-recursive + never follows symlinks. The default uses chokidar; tests inject a fake. */
export type WatcherFactory = (folderPath: string, onChange: () => void, onError: (err: unknown) => void) => WatchHandle;

const defaultWatcherFactory: WatcherFactory = (folderPath, onChange, onError) => {
  const w = chokidar.watch(folderPath, {
    depth: 0, // non-recursive (WATCH-6)
    followSymlinks: false, // never follow symlinks out of the watched folder (WATCH-3 scope-escape)
    ignoreInitial: true, // existing files are handled by the explicit startup reconcile, not re-emitted
    awaitWriteFinish: { stabilityThreshold: 2000, pollInterval: 100 }, // stable-file detection (WATCH-2)
  });
  w.on('add', onChange);
  w.on('change', onChange);
  w.on('error', onError);
  return w;
};

export interface WatchSchedulerDeps {
  watcherFactory?: WatcherFactory;
  now?: () => string;
  /** Debounce window collapsing a burst of events into one reconcile (default 250ms). */
  debounceMs?: number;
}

interface ActiveWatch {
  handle: WatchHandle;
  debounce: ReturnType<typeof setTimeout> | null;
}

/**
 * Owns the live folder watchers for the active vault. `start()` provisions a watcher (after a startup
 * reconcile) for each enabled, loop-safe folder; `refresh()` re-syncs to the registry after a config
 * change (start newly-enabled, stop disabled/removed); `stop()` closes everything. A reconcile failure
 * for one folder never breaks the others (logged, not thrown).
 */
export class WatchScheduler {
  private readonly root: string;
  private readonly vaultRoot: string;
  private readonly log: DevLog;
  private readonly factory: WatcherFactory;
  private readonly now: () => string;
  private readonly debounceMs: number;
  private readonly active = new Map<string, ActiveWatch>();
  private readonly reconciling = new Set<string>(); // single-flight per folder
  private started = false;

  constructor(root: string, vaultRoot: string, log: DevLog = noopDevLog, deps: WatchSchedulerDeps = {}) {
    this.root = root;
    this.vaultRoot = vaultRoot;
    this.log = log.child({ scope: 'watch-scheduler' });
    this.factory = deps.watcherFactory ?? defaultWatcherFactory;
    this.now = deps.now ?? (() => new Date().toISOString());
    this.debounceMs = deps.debounceMs ?? 250;
  }

  /** Kick off provisioning (fire-and-forget to fit the sync stage-start contract). */
  start(): void {
    if (this.started) return;
    this.started = true;
    void this.refresh();
  }

  /** Re-sync the live watchers to the current registry: provision enabled+loop-safe folders (with a
   *  startup reconcile), tear down folders no longer enabled/registered. Safe to call repeatedly. */
  async refresh(): Promise<void> {
    let folders: WatchFolderConfig[];
    try {
      folders = (await readWatchRegistry(this.root, this.log)).filter((f) => f.enabled);
    } catch (err) {
      this.log.error('watch.registry-read-failed', { err });
      return;
    }
    const want = new Set<string>();
    for (const f of folders) {
      const guard = await checkWatchLoopSafe(this.vaultRoot, f.folderPath);
      if (!guard.ok) {
        // A loop-unsafe / missing folder never gets a live watcher; the reconcile core also audits a
        // watch-refused if it's ever invoked directly. Don't spin a watcher on it.
        this.log.warn('watch.skip-unsafe-folder', { watchId: f.id, folderPath: f.folderPath, reason: guard.reason });
        continue;
      }
      want.add(f.id);
      if (!this.active.has(f.id)) await this.provision(f);
    }
    // Tear down watchers whose folder is no longer enabled/registered/safe.
    for (const id of [...this.active.keys()]) if (!want.has(id)) await this.teardown(id);
  }

  /** Start watching one folder: a startup reconcile first (catch offline arrivals), then the live watcher. */
  private async provision(f: WatchFolderConfig): Promise<void> {
    await this.runReconcile(f); // restart reconcile (WATCH-8) — existing files ingested once
    const handle = this.factory(
      f.folderPath,
      () => this.onEvent(f.id),
      (err) => this.log.error('watch.watcher-error', { watchId: f.id, err }),
    );
    this.active.set(f.id, { handle, debounce: null });
  }

  /** Debounced live-event handler: collapse a burst into one idempotent reconcile (dedup handles repeats). */
  private onEvent(id: string): void {
    const a = this.active.get(id);
    if (!a) return;
    if (a.debounce) clearTimeout(a.debounce);
    a.debounce = setTimeout(() => {
      a.debounce = null;
      void this.reconcileById(id);
    }, this.debounceMs);
    a.debounce.unref?.();
  }

  private async reconcileById(id: string): Promise<void> {
    let folders: WatchFolderConfig[];
    try {
      folders = await readWatchRegistry(this.root, this.log);
    } catch {
      return;
    }
    const f = folders.find((x) => x.id === id && x.enabled);
    if (f) await this.runReconcile(f);
  }

  /** Run one reconcile pass, single-flight per folder; never throws into the watcher loop. */
  private async runReconcile(f: WatchFolderConfig): Promise<void> {
    if (this.reconciling.has(f.id)) return; // single-flight (WATCH-2)
    this.reconciling.add(f.id);
    try {
      await reconcileWatchFolder(this.root, f, { vaultRoot: this.vaultRoot, now: this.now });
    } catch (err) {
      this.log.error('watch.reconcile-failed', { watchId: f.id, err });
    } finally {
      this.reconciling.delete(f.id);
    }
  }

  private async teardown(id: string): Promise<void> {
    const a = this.active.get(id);
    if (!a) return;
    if (a.debounce) clearTimeout(a.debounce);
    try {
      await a.handle.close();
    } catch (err) {
      this.log.warn('watch.close-failed', { watchId: id, err });
    }
    this.active.delete(id);
  }

  /** The folder ids currently under a live watcher (for the WatchFolderView `watching` flag). */
  watchingIds(): Set<string> {
    return new Set(this.active.keys());
  }

  /** Close every live watcher (vault switch / shutdown). */
  stop(): void {
    for (const id of [...this.active.keys()]) void this.teardown(id);
    this.started = false;
  }
}
