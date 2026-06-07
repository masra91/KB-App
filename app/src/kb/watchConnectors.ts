// Folder-Watch Ingestion — shared types, id/loop guards, dedup, and source rendering (SPEC-0037 WATCH).
//
// WATCH is the *programmatic ingress* surface: a watched local folder whose stable files are COPIED
// (non-destructive, WATCH-4) into the vault as immutable PRIMARY sources on the INGEST spine
// (provenance `surface=watch:<folder-id>`). It is the sibling of INTAKE (feed pulls) — both produce
// PRIMARY `origin:'external'` sources via `captureToInbox`, NOT the JobBehavior write-sink — but WATCH
// is event-driven (a filesystem watcher) rather than cadence-scheduled.
//
// Ratified forks (KB-Lead, SPEC-0037 §5): #1 a changed watched file = a NEW immutable source
// provenance-linked to the prior (contentHash dedup → unchanged re-save is a no-op); #2 default is a
// non-destructive COPY (move-out is Slice 2); #3 v1 is NON-RECURSIVE and does NOT follow symlinks
// (scope-escape security); #4 engine is chokidar (E1-pinned).
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

/** Connector-default classification (mirrors INTAKE): conservative defaults applied to ingested files. */
export const DEFAULT_WATCH_SCOPE = 'global';
export const DEFAULT_WATCH_SENSITIVITY = 'internal';

/**
 * One registered watched folder (WATCH-1) — a per-vault folder the Principal owns, the parallel sibling
 * of the intake connector registry. `folderPath` is an ABSOLUTE local path; `scope`/`sensitivity` are
 * the defaults applied to every file it ingests; `ignoreGlobs` bound what's watched. v1 is non-recursive
 * and never follows symlinks (the loop-guard + chokidar options enforce both).
 */
export interface WatchFolderConfig {
  id: string;
  /** Absolute path of the watched folder. Validated loop-safe at every boundary (never the vault/.kb/.git). */
  folderPath: string;
  enabled: boolean;
  /** Connector-default scope applied to ingested files (SCOPE-14). Defaults to `global`. */
  scope: string;
  /** Connector-default sensitivity applied to ingested files (SCOPE-8/14). Defaults to `internal`. */
  sensitivity: string;
  /** Principal-facing label shown in the Sources view (optional). */
  label?: string;
  /** Ignore patterns (basename or path globs) — files matching are never ingested (bounds, WATCH-6). */
  ignoreGlobs?: string[];
  /** Reserved for type-specific config (forward-compat with Slice-2 consume/recursive options). */
  config?: Record<string, unknown>;
}

/**
 * A watched-folder `id` MUST be a bare slug — it is consumed directly into filesystem paths (the per-
 * folder dedup ledger `.kb/watch/<id>/seen.json`) and the provenance `surface=watch:<id>`. A traversal
 * id (`../x`) in a hand-/foreign-edited `registry.json` would escape `.kb/watch` and become an
 * arbitrary-write vector — the same #29 class as JOBS-10. Validate at every boundary an id enters.
 */
export function isSafeWatchId(v: unknown): v is string {
  return typeof v === 'string' && /^[a-z0-9][a-z0-9-]*$/i.test(v);
}

export interface LoopGuardResult {
  ok: boolean;
  /** Set when !ok — why the folder is refused (for the audit / the IPC rejection message). */
  reason?: string;
}

/**
 * THE LOOP-GUARD (WATCH-10, security-critical): refuse to watch a folder that would re-ingest the
 * vault's own files into itself — an unbounded capture→source→capture loop. Symlink-safe (realpath both
 * sides so a symlinked folder can't dodge the check). Refuses when the watched folder, resolved:
 *   - IS the vault root, or
 *   - is INSIDE the vault (so `.kb`/`.git`/`sources` etc. can never be watched), or
 *   - is an ANCESTOR of the vault (watching a parent would sweep the vault's own tree → loop).
 * A non-existent folder is also refused (nothing legitimate to watch). `vaultRoot` is the real vault
 * (the Obsidian root / promotion target), not the staging worktree.
 */
export async function checkWatchLoopSafe(vaultRoot: string, folderPath: string): Promise<LoopGuardResult> {
  if (typeof folderPath !== 'string' || folderPath.trim().length === 0) return { ok: false, reason: 'empty folder path' };
  if (!path.isAbsolute(folderPath)) return { ok: false, reason: `folder path must be absolute: ${folderPath}` };
  let vaultReal: string;
  let folderReal: string;
  try {
    vaultReal = await fs.realpath(vaultRoot);
  } catch {
    return { ok: false, reason: 'vault root does not resolve' };
  }
  try {
    folderReal = await fs.realpath(folderPath);
  } catch {
    return { ok: false, reason: `watched folder does not exist: ${folderPath}` };
  }
  let isDir = false;
  try {
    isDir = (await fs.stat(folderReal)).isDirectory();
  } catch {
    isDir = false;
  }
  if (!isDir) return { ok: false, reason: `watched path is not a directory: ${folderPath}` };
  if (folderReal === vaultReal) return { ok: false, reason: 'cannot watch the vault root itself (ingest loop)' };
  if (folderReal.startsWith(vaultReal + path.sep)) return { ok: false, reason: 'cannot watch a folder inside the vault (incl. .kb/.git) — ingest loop' };
  if (vaultReal.startsWith(folderReal + path.sep)) return { ok: false, reason: 'cannot watch an ancestor of the vault — would sweep the vault tree (ingest loop)' };
  return { ok: true };
}

/** Compute a file's content hash (the dedup signal). `sha256:<hex>` — matches CapturedMeta.contentHash. */
export function hashContent(data: Uint8Array): string {
  return 'sha256:' + createHash('sha256').update(data).digest('hex');
}

/**
 * Should this file be ignored (bounds, WATCH-6)? Dotfiles are always skipped (editor temp/lock noise).
 * `ignoreGlobs` match against the basename with a tiny `*`/`?` glob (no full minimatch dep needed for v1).
 */
export function isIgnoredFile(name: string, ignoreGlobs: readonly string[] = []): boolean {
  if (name.startsWith('.')) return true; // dotfiles / editor temp + lock files
  return ignoreGlobs.some((g) => globMatch(g, name));
}

/** Minimal glob: `*` = any run, `?` = one char, anchored to the whole basename. Case-insensitive. */
function globMatch(glob: string, name: string): boolean {
  const re = new RegExp('^' + glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$', 'i');
  return re.test(name);
}

/**
 * Render a watched file into the immutable primary-source body (WATCH-3/Fork#1): a provenance header
 * (watcher id, the original file path, fetched timestamp, and — when this supersedes a prior version of
 * the SAME path — the prior source id, so the new immutable source carries the prior-source link) then
 * a note of the copied artifact. Binary files capture by reference (the copied bytes ride the inbox
 * unit); text content is inlined for downstream Decompose. Body is DATA, never instructions (untrusted).
 */
export function renderWatchSourceBody(
  c: WatchFolderConfig,
  fileName: string,
  fetchedAt: string,
  opts: { textContent?: string; priorSourceId?: string } = {},
): string {
  const lines: string[] = [`# ${fileName}`, ''];
  const prov: string[] = [`Ingested by folder-watch \`${c.id}\` from \`${fileName}\` on ${fetchedAt}.`];
  if (opts.priorSourceId) prov.push(`Supersedes the prior version of this file (source \`${opts.priorSourceId}\`).`);
  lines.push(prov.map((l) => `> ${l}`).join('\n'));
  lines.push('');
  if (opts.textContent !== undefined) lines.push(opts.textContent.trim());
  lines.push('');
  return lines.join('\n');
}
