// The folder-watch registry (SPEC-0037 WATCH-1) — per-vault config the Principal owns, the parallel
// sibling of the intake/researcher/job registries. Stored at `.kb/watch/registry.json`: tracked on
// `staging` (the vault gitignore ignores only `.kb/cache/`), never promoted — git-auditable but hidden
// from Obsidian on `main`. Control-Panel edits (DEV-2's unified Sources view) go through the IPC, which
// validates + loop-guards before these helpers persist.
//
// Mirrors intakeRegistry's #29 path-injection hardening: validate the untrusted, hand-/foreign-editable
// `id` at EVERY boundary (read + write + patch) via `isSafeWatchId`, surfacing rejects on the injectable
// devlog, never silent — a `.kb/watch/<id>/` ledger path can never be fed a traversal id downstream.
// (The folderPath loop-guard is enforced at the IPC boundary + in the watcher; the registry guards the id.)
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { DEFAULT_WATCH_SCOPE, DEFAULT_WATCH_SENSITIVITY, isSafeWatchId, type WatchFolderConfig } from './watchConnectors';
import { noopDevLog, type DevLog } from './devlog';

const REGISTRY_REL = path.join('.kb', 'watch', 'registry.json');

/** Absolute path to a vault's folder-watch registry file. */
export function watchRegistryPath(root: string): string {
  return path.join(path.resolve(root), REGISTRY_REL);
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.trim().length > 0;
}

/** Validate one stored row into a WatchFolderConfig, or null to skip a malformed one (never crash a read). */
function validWatchFolder(v: unknown): WatchFolderConfig | null {
  if (typeof v !== 'object' || v === null) return null;
  const o = v as Record<string, unknown>;
  if (!isNonEmptyString(o.id) || !isNonEmptyString(o.folderPath)) return null;
  const c: WatchFolderConfig = {
    id: o.id,
    folderPath: o.folderPath,
    enabled: o.enabled === true,
    scope: isNonEmptyString(o.scope) ? o.scope : DEFAULT_WATCH_SCOPE,
    sensitivity: isNonEmptyString(o.sensitivity) ? o.sensitivity : DEFAULT_WATCH_SENSITIVITY,
  };
  if (isNonEmptyString(o.label)) c.label = o.label;
  if (Array.isArray(o.ignoreGlobs)) c.ignoreGlobs = o.ignoreGlobs.filter(isNonEmptyString);
  if (o.config && typeof o.config === 'object') c.config = o.config as Record<string, unknown>;
  return c;
}

/**
 * Read the vault's folder-watch registry. Missing/malformed file → empty (no watchers). A row whose
 * `id` is not a bare slug is DROPPED at this read boundary (path-injection guard, #29-class) and
 * surfaced on `devlog` (never silent). Valid rows still load. (The folderPath is re-validated loop-safe
 * before the watcher actually watches it — read here does not touch the fs path.)
 */
export async function readWatchRegistry(root: string, devlog: DevLog = noopDevLog): Promise<WatchFolderConfig[]> {
  let raw: string;
  try {
    raw = await fs.readFile(watchRegistryPath(root), 'utf8');
  } catch {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const out: WatchFolderConfig[] = [];
  for (const row of parsed) {
    const c = validWatchFolder(row);
    if (!c) continue;
    if (!isSafeWatchId(c.id)) {
      devlog.warn('watch-id-rejected', { watchId: c.id, source: 'registry-read', reason: 'id is not a bare slug (path-traversal guard, WATCH/#29)' });
      continue;
    }
    out.push(c);
  }
  return out;
}

/** Write the registry deterministically under `.kb/watch/`. */
export async function writeWatchRegistry(root: string, folders: WatchFolderConfig[]): Promise<void> {
  const p = watchRegistryPath(root);
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, JSON.stringify(folders, null, 2) + '\n', 'utf8');
}

/** Insert or replace a watched folder by `id`, returning the updated registry. Rejects an unsafe `id`
 *  at the write boundary (throw — never persist) so a traversal id can't enter the registry. */
export async function upsertWatchFolder(root: string, folder: WatchFolderConfig): Promise<WatchFolderConfig[]> {
  if (!isSafeWatchId(folder.id)) {
    throw new Error(`refusing to register watched folder with unsafe id: ${JSON.stringify(folder.id)}`);
  }
  const folders = await readWatchRegistry(root);
  const idx = folders.findIndex((f) => f.id === folder.id);
  if (idx === -1) folders.push(folder);
  else folders[idx] = folder;
  await writeWatchRegistry(root, folders);
  return folders;
}

/** Patch one watched folder's mutable fields; no-op if absent. Rejects an unsafe `id` at the boundary. */
export async function patchWatchFolder(
  root: string,
  id: string,
  patch: Partial<Pick<WatchFolderConfig, 'enabled' | 'folderPath' | 'scope' | 'sensitivity' | 'label' | 'ignoreGlobs' | 'config'>>,
): Promise<WatchFolderConfig[]> {
  if (!isSafeWatchId(id)) throw new Error(`refusing to patch watched folder with unsafe id: ${JSON.stringify(id)}`);
  const folders = await readWatchRegistry(root);
  const f = folders.find((x) => x.id === id);
  if (f) {
    if (patch.enabled !== undefined) f.enabled = patch.enabled;
    if (patch.folderPath !== undefined) f.folderPath = patch.folderPath;
    if (patch.scope !== undefined) f.scope = patch.scope;
    if (patch.sensitivity !== undefined) f.sensitivity = patch.sensitivity;
    if (patch.label !== undefined) f.label = patch.label;
    if (patch.ignoreGlobs !== undefined) f.ignoreGlobs = patch.ignoreGlobs;
    if (patch.config !== undefined) f.config = patch.config;
    await writeWatchRegistry(root, folders);
  }
  return folders;
}
