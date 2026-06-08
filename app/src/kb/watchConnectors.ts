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

/** Recursive-watch depth cap (WATCH-12): default levels descended below the root when recursive, and the
 *  hard ceiling a configured cap is clamped to (a pathological deep tree can't be a runaway). depth 0 =
 *  the root's own files (== non-recursive Slice-1 behavior). */
export const DEFAULT_WATCH_MAX_DEPTH = 5;
export const WATCH_MAX_DEPTH_CAP = 32;

/** Consume/move-out archive dir (WATCH-14): a dot-prefixed subfolder of the watched folder, so a moved-out
 *  original is itself never re-ingested (the dotfile/dot-dir skip in `isIgnoredFile` covers it depth-wide). */
export const WATCH_ARCHIVE_DIRNAME = '.kb-processed';

/**
 * The effective recursion depth for a folder (WATCH-12): 0 when not recursive (Slice-1), else the
 * configured `maxDepth` clamped to `[0, WATCH_MAX_DEPTH_CAP]` (default `DEFAULT_WATCH_MAX_DEPTH`). A
 * non-integer/negative cap falls back to the default — never NaN/∞ into the walk.
 */
export function effectiveWatchDepth(c: Pick<WatchFolderConfig, 'recursive' | 'maxDepth'>): number {
  if (!c.recursive) return 0;
  const m = c.maxDepth;
  if (typeof m !== 'number' || !Number.isFinite(m) || m < 0) return DEFAULT_WATCH_MAX_DEPTH;
  return Math.min(Math.floor(m), WATCH_MAX_DEPTH_CAP);
}

/** Absolute archive base for a folder's consume mode (WATCH-14): the configured `archiveDir` (absolute)
 *  or the default `<folderPath>/.kb-processed`. The caller validates it is loop-safe before moving into it. */
export function watchArchiveBase(c: Pick<WatchFolderConfig, 'folderPath' | 'archiveDir'>): string {
  if (typeof c.archiveDir === 'string' && c.archiveDir.trim().length > 0 && path.isAbsolute(c.archiveDir)) {
    return path.resolve(c.archiveDir);
  }
  return path.join(path.resolve(c.folderPath), WATCH_ARCHIVE_DIRNAME);
}

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
  /** Opt-in recursive watch (WATCH-12). Default (absent/false) = non-recursive, Slice-1 behavior. */
  recursive?: boolean;
  /** Depth cap when `recursive` (WATCH-12). Clamped to `[0, WATCH_MAX_DEPTH_CAP]`; default `5`. */
  maxDepth?: number;
  /** Opt-in consume/move-out (WATCH-14): MOVE the original out after a successful, non-destructive ingest. */
  consume?: boolean;
  /** Absolute archive base for consume mode (WATCH-14); default `<folderPath>/.kb-processed`. */
  archiveDir?: string;
  /** Reserved for type-specific config (forward-compat). */
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

/** One scanned file: its path RELATIVE to the watched root (POSIX-joined, the ledger/provenance key) and
 *  its absolute path on disk. */
export interface WatchScanEntry {
  relPath: string;
  absPath: string;
}

/** The result of scanning a watched folder (flat or recursive). */
export interface WatchScanResult {
  /** Regular files to consider for ingest, in deterministic (sorted) order. */
  files: WatchScanEntry[];
  /** Count of entries skipped (symlink, dir at depth cap, ignored, loop-refused subdir, non-regular). */
  skipped: number;
  /** Relative paths of subdirectories the per-descended-path loop-guard REFUSED (WATCH-13) — audited. */
  refusedSubdirs: string[];
}

/**
 * Scan a watched folder for regular files to ingest (WATCH-12). Non-recursive (depth 0) reproduces Slice-1
 * exactly. When recursive, descend up to `maxDepth` levels, and at EVERY descended directory apply the
 * WATCH-6 loop-guard via `checkWatchLoopSafe` (realpath both sides) so a subdir resolving into the
 * vault/`.kb`/`.git`/an-ancestor is skipped, NOT descended (WATCH-13). Symlinks are never followed at any
 * level; dotfiles/dot-dirs and `ignoreGlobs` matches are skipped (bounds, WATCH-6/7). The watched root
 * itself is assumed already loop-guarded by the caller. Deterministic: entries sorted by name per level.
 */
export async function collectWatchedFiles(vaultRoot: string, c: WatchFolderConfig): Promise<WatchScanResult> {
  const maxDepth = effectiveWatchDepth(c);
  const files: WatchScanEntry[] = [];
  const refusedSubdirs: string[] = [];
  let skipped = 0;

  async function walk(dirAbs: string, relPrefix: string, depth: number): Promise<void> {
    let entries: import('node:fs').Dirent[];
    try {
      entries = await fs.readdir(dirAbs, { withFileTypes: true });
    } catch (err) {
      // A ROOT read failure is surfaced (failed ≠ empty, OBS-4 — the caller audits watch-failed); an
      // unreadable SUBDIR mid-walk is a bounded skip, not a whole-pass failure.
      if (relPrefix === '') throw err;
      skipped++;
      return;
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)); // deterministic order
    for (const e of entries) {
      const rel = relPrefix === '' ? e.name : `${relPrefix}/${e.name}`;
      if (e.isSymbolicLink()) { skipped++; continue; } // never follow symlinks at ANY level (WATCH-13)
      if (e.isDirectory()) {
        if (depth >= maxDepth) { skipped++; continue; } // depth cap (WATCH-12)
        if (isIgnoredFile(e.name, c.ignoreGlobs)) { skipped++; continue; } // dot-dirs (.kb-processed/.git/…) + globs
        const subAbs = path.join(dirAbs, e.name);
        const guard = await checkWatchLoopSafe(vaultRoot, subAbs); // per-descended-path loop-guard (WATCH-13)
        if (!guard.ok) { refusedSubdirs.push(rel); skipped++; continue; } // skip vault/.kb/.git subdir — don't descend
        await walk(subAbs, rel, depth + 1);
        continue;
      }
      if (!e.isFile()) { skipped++; continue; } // sockets/fifos/etc.
      if (isIgnoredFile(e.name, c.ignoreGlobs)) { skipped++; continue; } // bounds / editor-temp (WATCH-6)
      files.push({ relPath: rel, absPath: path.join(dirAbs, e.name) });
    }
  }

  await walk(path.resolve(c.folderPath), '', 0);
  return { files, skipped, refusedSubdirs };
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
 * Pick an archive target that does NOT already exist (WATCH-14 never-delete ⊇ never-overwrite): if
 * `<base>/<relPath>` is taken, insert `.1`, `.2`, … before the extension until free. A pre-existing
 * archived original is never clobbered. (Bounded probe — a runaway just falls back to a hash-free `.N`.)
 */
async function freeArchiveTarget(candidate: string): Promise<string> {
  const dir = path.dirname(candidate);
  const ext = path.extname(candidate);
  const stem = path.basename(candidate, ext);
  let probe = candidate;
  for (let n = 1; n <= 10000; n++) {
    try {
      await fs.access(probe);
    } catch {
      return probe; // does not exist → free
    }
    probe = path.join(dir, `${stem}.${n}${ext}`);
  }
  return probe;
}

/**
 * Move a successfully-ingested original OUT of the watched folder into the per-folder archive (WATCH-14).
 * Called ONLY after the KB copy is committed, so the source is already preserved; this never deletes (a
 * move, into a never-clobbered target) and is structure-preserving (the relative path is recreated under
 * the archive base). Cross-device (`EXDEV`) falls back to copy-then-unlink — the bytes exist at the
 * destination before the source link is removed. Returns the absolute archived path.
 */
export async function moveOriginalToArchive(absPath: string, archiveBase: string, relPath: string): Promise<string> {
  const target = await freeArchiveTarget(path.join(archiveBase, relPath));
  await fs.mkdir(path.dirname(target), { recursive: true });
  try {
    await fs.rename(absPath, target);
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== 'EXDEV') throw err;
    await fs.copyFile(absPath, target); // copy across devices FIRST…
    await fs.unlink(absPath); // …then drop the original link (bytes already safe at target)
  }
  return target;
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
