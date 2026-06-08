// Folder-watch registry (SPEC-0037 WATCH-1). Real FS temp dirs (TEST-18); mirrors intakeRegistry,
// incl. the #29-class path-injection guard at read/write/patch boundaries.
import { describe, it, expect, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { makeTempDir, rmTempDir } from '../../test/tempVault';
import { readWatchRegistry, writeWatchRegistry, upsertWatchFolder, patchWatchFolder, watchRegistryPath } from './watchRegistry';
import type { WatchFolderConfig } from './watchConnectors';

async function withTemp(fn: (root: string) => Promise<void>): Promise<void> {
  const dir = await makeTempDir();
  try {
    await fn(dir);
  } finally {
    await rmTempDir(dir);
  }
}

function watcher(over: Partial<WatchFolderConfig> = {}): WatchFolderConfig {
  return { id: 'drop', folderPath: '/abs/inbox', enabled: false, scope: 'global', sensitivity: 'internal', ...over };
}

describe('readWatchRegistry', () => {
  it('returns [] for a missing or malformed file', async () => {
    await withTemp(async (root) => {
      expect(await readWatchRegistry(root)).toEqual([]);
      await fs.mkdir(path.dirname(watchRegistryPath(root)), { recursive: true });
      await fs.writeFile(watchRegistryPath(root), 'not json');
      expect(await readWatchRegistry(root)).toEqual([]);
    });
  });

  it('applies conservative defaults; drops a row missing id/folderPath; preserves ignoreGlobs', async () => {
    await withTemp(async (root) => {
      await writeWatchRegistry(root, [
        { id: 'r1', folderPath: '/abs/a', enabled: true, scope: '', sensitivity: '', ignoreGlobs: ['*.tmp'] } as unknown as WatchFolderConfig,
        { id: 'no-path' } as unknown as WatchFolderConfig, // missing folderPath → dropped
      ]);
      const reg = await readWatchRegistry(root);
      expect(reg.map((r) => r.id)).toEqual(['r1']);
      expect(reg[0].scope).toBe('global'); // empty → default
      expect(reg[0].sensitivity).toBe('internal');
      expect(reg[0].ignoreGlobs).toEqual(['*.tmp']);
    });
  });

  it('drops a row whose id is not a bare slug and surfaces it on devlog (#29 read guard)', async () => {
    await withTemp(async (root) => {
      await writeWatchRegistry(root, [watcher({ id: 'drop' }), watcher({ id: '../../tmp/evil' }), watcher({ id: '.kb' })]);
      const warn = vi.fn();
      const loaded = await readWatchRegistry(root, { debug() {}, info() {}, warn, error() {}, child: () => ({}) as never, flush: async () => {} } as never);
      expect(loaded.map((r) => r.id)).toEqual(['drop']); // only the safe id loads
      expect(warn).toHaveBeenCalledTimes(2); // both unsafe ids surfaced — not silent
    });
  });
});

describe('upsertWatchFolder / patchWatchFolder', () => {
  it('inserts, then replaces by id; multiple watched folders allowed', async () => {
    await withTemp(async (root) => {
      await upsertWatchFolder(root, watcher({ id: 'drop', folderPath: '/abs/a' }));
      await upsertWatchFolder(root, watcher({ id: 'photos', folderPath: '/abs/b' }));
      let reg = await readWatchRegistry(root);
      expect(reg.map((r) => r.id).sort()).toEqual(['drop', 'photos']);
      await upsertWatchFolder(root, watcher({ id: 'drop', folderPath: '/abs/a2' })); // replace
      reg = await readWatchRegistry(root);
      expect(reg.length).toBe(2);
      expect(reg.find((r) => r.id === 'drop')!.folderPath).toBe('/abs/a2');
    });
  });

  it('rejects an unsafe id at the write boundary (throw, never persist) — #29', async () => {
    await withTemp(async (root) => {
      await expect(upsertWatchFolder(root, watcher({ id: '../x' }))).rejects.toThrow(/unsafe id/);
      await expect(patchWatchFolder(root, 'a/b', { enabled: true })).rejects.toThrow(/unsafe id/);
      expect(await readWatchRegistry(root)).toEqual([]); // nothing persisted
    });
  });

  it('patches mutable fields; no-op on an absent id', async () => {
    await withTemp(async (root) => {
      await upsertWatchFolder(root, watcher({ id: 'drop', enabled: false, ignoreGlobs: [] }));
      await patchWatchFolder(root, 'drop', { enabled: true, ignoreGlobs: ['*.part'], scope: 'work' });
      const r = (await readWatchRegistry(root)).find((x) => x.id === 'drop')!;
      expect(r).toMatchObject({ enabled: true, scope: 'work', ignoreGlobs: ['*.part'] });
      await patchWatchFolder(root, 'nope', { enabled: false }); // absent → no throw, no change
      expect((await readWatchRegistry(root)).length).toBe(1);
    });
  });

  it('round-trips the Slice-2 opt-ins (recursive / maxDepth / consume) and ignores junk values (WATCH-12/14)', async () => {
    await withTemp(async (root) => {
      await upsertWatchFolder(root, watcher({ id: 'deep', recursive: true, maxDepth: 4, consume: true }));
      let r = (await readWatchRegistry(root)).find((x) => x.id === 'deep')!;
      expect(r).toMatchObject({ recursive: true, maxDepth: 4, consume: true });
      await patchWatchFolder(root, 'deep', { recursive: false, consume: false });
      r = (await readWatchRegistry(root)).find((x) => x.id === 'deep')!;
      expect(r.recursive ?? false).toBe(false); // explicit false normalizes to absent (both = non-recursive)
      // WATCH-16: an explicit `consume: false` (the copy opt-out) MUST be PRESERVED across read — drain is
      // the default, so a folder that opted out of draining can't silently revert to draining.
      expect(r.consume).toBe(false);

      // A hand-edited registry with junk Slice-2 values → ignored, falls back to the safe default.
      await writeWatchRegistry(root, [
        { id: 'junk', folderPath: '/abs/j', enabled: true, scope: 'global', sensitivity: 'internal', recursive: 'yes', maxDepth: -3, consume: 1 } as unknown as WatchFolderConfig,
      ]);
      const j = (await readWatchRegistry(root)).find((x) => x.id === 'junk')!;
      expect(j.recursive).toBeUndefined(); // 'yes' (not true) → not set
      expect(j.maxDepth).toBeUndefined(); // -3 (<0) → not set
      expect(j.consume).toBeUndefined(); // 1 (not true) → not set
    });
  });
});
