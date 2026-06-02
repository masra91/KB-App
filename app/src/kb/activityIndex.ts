// The derived, rebuildable activity index (SPEC-0029 AUDIT-4).
//
// Per-item `audit.jsonl` stays the SINGLE SOURCE OF TRUTH (DATA-10). This module aggregates those
// files into one time-ordered stream of canonical `AuditEvent`s (via `audit.ts`'s normalizer) and
// caches it under `.kb/cache/` — the working zone: gitignored (vault `.gitignore` lists
// `.kb/cache/`), never promoted to `main` (not in EVERGREEN_PATHS), and replay-safe because it is
// rebuilt from the audit, never a second source of truth (STAGING-6; realizes the SPEC-0014
// deferred "audit global index" without a double-write).
//
// ROOT-AGNOSTIC, like every stage helper: in production the IPC layer passes the persistent
// `staging` worktree as `root` (where the full working-zone history lives — `.kb/jobs`, `connect/`,
// candidates, plus the evergreen `sources/`), satisfying AUDIT-10. Tests pass a temp vault.
//
// The feed shows the FULL append-only history, window-capped to the recent N events (AUDIT-5 +
// open-Q Q3: cap the index, never the per-item audit; surface truncation — no silent caps).
// `replay-reset` markers ride the stream inline as boundary events, so the timeline stays an honest
// immutable record (AUDIT-3) rather than hiding superseded generations.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import simpleGit from 'simple-git';
import { normalizeAuditLine, type AuditEvent, type AuditActor, type NormalizeContext } from './audit';

/** Bump when the cached shape changes so a stale cache from an older build is discarded. */
export const ACTIVITY_INDEX_VERSION = 1;

/** Default cap on how many (most-recent) events the index holds (open-Q Q3). */
export const DEFAULT_INDEX_WINDOW = 1000;

/** Vault-relative location of the cached index (working zone — gitignored, never promoted). */
export const ACTIVITY_INDEX_REL = path.join('.kb', 'cache', 'activity-index.json');

/** The cached, time-ordered activity index. `events` are newest-first. */
export interface ActivityIndex {
  /** Cache-shape version (see ACTIVITY_INDEX_VERSION). */
  version: number;
  /** When this index was built (ISO-8601; injectable clock in tests). */
  builtAt: string;
  /** The git HEAD of `root` the index was built from, for cheap freshness checks (null if none). */
  head: string | null;
  /** Total conforming events seen across all audit files (before the window cap). */
  total: number;
  /** True when `total` exceeded the window and older events were dropped from THIS index. */
  truncated: boolean;
  /** The events, newest-first, capped to the window. */
  events: AuditEvent[];
}

export interface BuildOptions {
  /** Cap on retained events (newest-first). Defaults to DEFAULT_INDEX_WINDOW. */
  window?: number;
  /** Injectable clock for `builtAt` (deterministic tests). */
  now?: () => string;
}

/** One audit file to read, with the path-derived hints its lines may need. */
interface AuditFile {
  /** Absolute path on disk. */
  abs: string;
  /** Vault-relative path (used as provenance). */
  rel: string;
  /** Source id when under `sources/<shard>/<id>/`. */
  sourceId?: string;
  /** Job id when it is a `.kb/jobs/<jobId>/journal.jsonl`. */
  jobId?: string;
}

/** Recursively collect file paths under `dir` whose basename equals `name`. Missing dir → []. */
async function findFiles(dir: string, name: string): Promise<string[]> {
  let entries: import('node:fs').Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return []; // absent tree — nothing to read
  }
  const out: string[] = [];
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...(await findFiles(p, name)));
    else if (e.isFile() && e.name === name) out.push(p);
  }
  return out;
}

/** Enumerate every audit/journal file in the vault, tagged with its path-derived hints. */
async function listAuditFiles(root: string): Promise<AuditFile[]> {
  const files: AuditFile[] = [];

  // sources/<shard>/<id>/audit.jsonl — the source id is the parent dir name.
  for (const abs of await findFiles(path.join(root, 'sources'), 'audit.jsonl')) {
    files.push({ abs, rel: path.relative(root, abs), sourceId: path.basename(path.dirname(abs)) });
  }
  // connect/audit.jsonl — the stage-wide resolve log (no per-item subject from the path).
  const connectAbs = path.join(root, 'connect', 'audit.jsonl');
  if (await fileExists(connectAbs)) files.push({ abs: connectAbs, rel: path.relative(root, connectAbs) });

  // .kb/jobs/<jobId>/journal.jsonl — the job id is the parent dir name.
  for (const abs of await findFiles(path.join(root, '.kb', 'jobs'), 'journal.jsonl')) {
    files.push({ abs, rel: path.relative(root, abs), jobId: path.basename(path.dirname(abs)) });
  }
  // .kb/ask/audit.jsonl — recall transparency log.
  const askAbs = path.join(root, '.kb', 'ask', 'audit.jsonl');
  if (await fileExists(askAbs)) files.push({ abs: askAbs, rel: path.relative(root, askAbs) });

  return files;
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

/** Parse + normalize one audit file's lines into canonical events (skipping malformed/foreign). */
async function readAuditFile(f: AuditFile): Promise<AuditEvent[]> {
  let raw: string;
  try {
    raw = await fs.readFile(f.abs, 'utf8');
  } catch {
    return [];
  }
  const out: AuditEvent[] = [];
  const lines = raw.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    if (t.length === 0) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(t);
    } catch {
      continue; // malformed line — never an event
    }
    const ctx: NormalizeContext = { file: f.rel, line: i, sourceId: f.sourceId, jobId: f.jobId };
    const ev = normalizeAuditLine(parsed, ctx);
    if (ev) out.push(ev);
  }
  return out;
}

/** Read + normalize EVERY conforming audit event in the vault, newest-first. Unbounded — callers
 *  that want the bounded feed use {@link buildActivityIndex}; lineage uses this directly. */
export async function readAllAuditEvents(root: string): Promise<AuditEvent[]> {
  root = path.resolve(root);
  const files = await listAuditFiles(root);
  const all: AuditEvent[] = [];
  for (const f of files) all.push(...(await readAuditFile(f)));
  all.sort(byTsDescending);
  return all;
}

/** Newest-first ordering. Ties broken by file+line so a rebuild is deterministic (AUDIT-4). */
function byTsDescending(a: AuditEvent, b: AuditEvent): number {
  if (a.ts !== b.ts) return a.ts < b.ts ? 1 : -1;
  if (a.provenance.file !== b.provenance.file) return a.provenance.file < b.provenance.file ? 1 : -1;
  return b.provenance.line - a.provenance.line;
}

/** Read the current git HEAD of `root` for the freshness key; null when not a git repo / no commits. */
async function readHead(root: string): Promise<string | null> {
  try {
    return (await simpleGit(root).revparse(['HEAD'])).trim();
  } catch {
    return null;
  }
}

/**
 * Build the activity index from scratch (AUDIT-4) — the always-correct, replay-safe path. Reads
 * every audit file, normalizes, sorts newest-first, and caps to the recent window (surfacing
 * `truncated` + `total` so a capped feed is never silently truncated). Deterministic: same audit
 * on disk → identical index (modulo `builtAt`).
 */
export async function buildActivityIndex(root: string, opts: BuildOptions = {}): Promise<ActivityIndex> {
  root = path.resolve(root);
  const window = opts.window ?? DEFAULT_INDEX_WINDOW;
  const now = opts.now ?? (() => new Date().toISOString());
  const all = await readAllAuditEvents(root);
  const total = all.length;
  const truncated = total > window;
  return {
    version: ACTIVITY_INDEX_VERSION,
    builtAt: now(),
    head: await readHead(root),
    total,
    truncated,
    events: truncated ? all.slice(0, window) : all,
  };
}

/** Persist the index to the gitignored cache. Best-effort callers should catch; we surface errors. */
export async function writeActivityIndexCache(root: string, index: ActivityIndex): Promise<void> {
  const file = path.join(path.resolve(root), ACTIVITY_INDEX_REL);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(index), 'utf8');
}

/** Read the cached index, or null when absent/unreadable/stale-shape. */
export async function readActivityIndexCache(root: string): Promise<ActivityIndex | null> {
  const file = path.join(path.resolve(root), ACTIVITY_INDEX_REL);
  try {
    const parsed = JSON.parse(await fs.readFile(file, 'utf8')) as ActivityIndex;
    if (parsed.version !== ACTIVITY_INDEX_VERSION) return null; // shape changed — discard
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Load the index, rebuilding only when stale (AUDIT-4 freshness; open-Q Q2 "HEAD-poke + full
 * rebuild"). The cache is fresh iff its `head` equals `root`'s current git HEAD AND its window is
 * at least the requested one — a HEAD-poke is cheap and mirrors ORCH-15. A full rebuild is always
 * available via {@link buildActivityIndex} and is the fallback whenever HEAD is unavailable.
 */
export async function loadActivityIndex(root: string, opts: BuildOptions = {}): Promise<ActivityIndex> {
  root = path.resolve(root);
  const window = opts.window ?? DEFAULT_INDEX_WINDOW;
  const cached = await readActivityIndexCache(root);
  if (cached) {
    const head = await readHead(root);
    // Fresh only when we have a real HEAD that matches, and the cache isn't narrower than asked.
    const windowOk = cached.events.length >= window || !cached.truncated;
    if (head !== null && cached.head === head && windowOk) return cached;
  }
  const fresh = await buildActivityIndex(root, opts);
  await writeActivityIndexCache(root, fresh).catch(() => {
    /* cache is an optimization; a read-only / racing FS must not fail the read */
  });
  return fresh;
}

// ── Filter / search (AUDIT-7) ──────────────────────────────────────────────────────────────────

export interface ActivityFilter {
  /** Restrict to these actors (any-of). */
  actors?: readonly AuditActor[];
  /** Restrict to these event-types (any-of). */
  eventTypes?: readonly string[];
  /** Match events touching this subject id (any subject field). */
  subjectId?: string;
  /** Inclusive lower bound on `ts` (ISO-8601). */
  since?: string;
  /** Inclusive upper bound on `ts` (ISO-8601). */
  until?: string;
  /** Case-insensitive free-text over actor, event-type, subjects, model, and payload. */
  text?: string;
}

/** True if `event` has `id` in any of its subject fields. */
function touchesSubject(event: AuditEvent, id: string): boolean {
  return Object.values(event.subjects).some((v) => v === id);
}

/** Lowercased haystack of an event's searchable text. */
function haystack(event: AuditEvent): string {
  return [event.actor, event.eventType, event.model ?? '', event.runId ?? '', Object.values(event.subjects).join(' '), JSON.stringify(event.payload)]
    .join(' ')
    .toLowerCase();
}

/** Apply a filter to an event stream (AUDIT-7). Pure; preserves input order. */
export function filterEvents(events: readonly AuditEvent[], filter: ActivityFilter = {}): AuditEvent[] {
  const text = filter.text?.trim().toLowerCase();
  return events.filter((e) => {
    if (filter.actors && filter.actors.length > 0 && !filter.actors.includes(e.actor)) return false;
    if (filter.eventTypes && filter.eventTypes.length > 0 && !filter.eventTypes.includes(e.eventType)) return false;
    if (filter.subjectId && !touchesSubject(e, filter.subjectId)) return false;
    if (filter.since && e.ts < filter.since) return false;
    if (filter.until && e.ts > filter.until) return false;
    if (text && !haystack(e).includes(text)) return false;
    return true;
  });
}
