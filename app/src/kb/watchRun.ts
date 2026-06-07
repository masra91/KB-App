// One folder-watch reconcile pass (SPEC-0037 WATCH-3/4/8/10) — the testable CORE, deliberately
// chokidar-free (the live watcher in watchScheduler just calls this). A pass scans the watched folder's
// current files, and for each non-ignored, non-symlink, regular file whose content is NEW or CHANGED
// (contentHash dedup vs the per-folder ledger) COPIES it into the KB as an immutable PRIMARY source via
// the ingest spine (`surface=watch:<id>`, origin:'external') — non-destructively (the original is never
// touched, WATCH-4). An unchanged file is a no-op; a changed file ingests a new source carrying the
// prior-source link (ratified Fork#1). The loop-guard (WATCH-10) refuses watching the vault/.kb/.git or
// an ancestor before any read. Mirrors intakeRun: failed ≠ empty (a read error is a distinct audited
// `watch-failed`, never a silent no-op; OBS-4); the ledger only advances for files actually ingested.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { appendAuditEvent } from './audit';
import { captureToInbox } from './ingest';
import { checkWatchLoopSafe, hashContent, isIgnoredFile, renderWatchSourceBody, isSafeWatchId, type WatchFolderConfig } from './watchConnectors';

/** Per-folder dedup ledger (WATCH-8): basename → the last-ingested content hash + the source it produced.
 *  Lets an unchanged re-save be a no-op and a changed file link its new source to the prior. */
export type WatchLedger = Record<string, { hash: string; sourceId: string }>;

/** Absolute path to a watched folder's dedup ledger (`.kb/watch/<id>/seen.json`). Id is slug-guarded. */
export function watchLedgerPath(root: string, id: string): string {
  return path.join(path.resolve(root), '.kb', 'watch', id, 'seen.json');
}

export async function readWatchLedger(root: string, id: string): Promise<WatchLedger> {
  try {
    const parsed: unknown = JSON.parse(await fs.readFile(watchLedgerPath(root, id), 'utf8'));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as WatchLedger;
  } catch {
    /* missing/malformed → empty ledger */
  }
  return {};
}

export async function writeWatchLedger(root: string, id: string, ledger: WatchLedger): Promise<void> {
  const p = watchLedgerPath(root, id);
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, JSON.stringify(ledger, null, 2) + '\n', 'utf8');
}

export interface RunWatchDeps {
  /** The REAL vault root (Obsidian/promotion target) — the loop-guard checks the folder against this. */
  vaultRoot: string;
  /** Injectable ISO clock (deterministic tests). */
  now?: () => string;
}

export interface RunWatchResult {
  /** PRIMARY source ids produced this pass. */
  sourceIds: string[];
  /** Files copied in as sources (new or changed). */
  ingested: number;
  /** Files seen but skipped (unchanged, ignored, symlink, or directory). */
  skipped: number;
  /** The loop-guard refused the folder (WATCH-10) — distinct from an empty pass. */
  refused?: boolean;
  /** The pass failed to read the folder (WATCH read error) — distinct from "nothing new" (OBS-4). */
  failed?: boolean;
  error?: string;
  note: string;
}

/** Decode bytes as UTF-8 text iff they carry no NUL in the first 8 KiB (a cheap binary sniff). A text
 *  file ingests as a markdown source (flows into Decompose); a binary copies as a file artifact. */
function asText(data: Uint8Array): string | null {
  const n = Math.min(data.length, 8192);
  for (let i = 0; i < n; i++) if (data[i] === 0) return null;
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(data);
  } catch {
    return null;
  }
}

/**
 * Copy ONE watched file into the KB as a primary source (non-destructive — reads, never moves/deletes).
 * Text files ingest as a rendered markdown source (provenance header + the prior-source link when
 * superseding); binary files ingest as the raw file artifact. Returns the new source id.
 */
export async function ingestWatchedFile(
  root: string,
  c: WatchFolderConfig,
  name: string,
  data: Uint8Array,
  stampMs: number,
  fetchedAt: string,
  priorSourceId?: string,
): Promise<string> {
  const text = asText(data);
  const surface = `watch:${c.id}`;
  const opts = { origin: 'external' as const, scope: c.scope, sensitivity: c.sensitivity };
  const out =
    text !== null
      ? await captureToInbox(root, surface, [{ kind: 'text', text: renderWatchSourceBody(c, name, fetchedAt, { textContent: text, ...(priorSourceId ? { priorSourceId } : {}) }) }], stampMs, opts)
      : await captureToInbox(root, surface, [{ kind: 'file', name, data }], stampMs, opts);
  return out.ids[0];
}

/**
 * Run one reconcile pass over `c.folderPath` (the restart-safe core — a startup reconcile and every live
 * chokidar event both route here). Loop-guarded, non-recursive, never follows symlinks. Returns the pass
 * outcome; always audits (ingested / no-new / refused / failed) so a pass is never silent (AUDIT-2/OBS-4).
 */
export async function reconcileWatchFolder(root: string, c: WatchFolderConfig, deps: RunWatchDeps): Promise<RunWatchResult> {
  if (!isSafeWatchId(c.id)) throw new Error(`reconcileWatchFolder: refusing unsafe watch id ${JSON.stringify(c.id)}`);
  const now = deps.now ?? (() => new Date().toISOString());

  // WATCH-10 loop-guard: refuse before any read (the vault/.kb/.git or an ancestor → ingest loop).
  const guard = await checkWatchLoopSafe(deps.vaultRoot, c.folderPath);
  if (!guard.ok) {
    await appendAuditEvent(root, { actor: 'watch', eventType: 'watch-refused', ts: now(), subjects: { watchId: c.id }, payload: { folderPath: c.folderPath, reason: guard.reason, why: 'folder-watch loop-guard (WATCH-10)' } });
    return { sourceIds: [], ingested: 0, skipped: 0, refused: true, note: `refused: ${guard.reason}` };
  }

  let entries: import('node:fs').Dirent[];
  try {
    entries = await fs.readdir(c.folderPath, { withFileTypes: true }); // non-recursive (WATCH-6)
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    await appendAuditEvent(root, { actor: 'watch', eventType: 'watch-failed', ts: now(), subjects: { watchId: c.id }, payload: { folderPath: c.folderPath, error, why: 'folder-watch read failed' } });
    return { sourceIds: [], ingested: 0, skipped: 0, failed: true, error, note: `watch failed: ${error}` };
  }

  const ledger = await readWatchLedger(root, c.id);
  const sourceIds: string[] = [];
  const ingestedNames: Array<{ name: string; sourceId: string; priorSourceId?: string }> = [];
  let skipped = 0;
  let failure: string | undefined;

  try {
    for (const e of entries) {
      if (e.isSymbolicLink()) { skipped++; continue; } // never follow symlinks (WATCH-3, scope-escape)
      if (!e.isFile()) { skipped++; continue; } // non-recursive: subdirectories are not descended
      if (isIgnoredFile(e.name, c.ignoreGlobs)) { skipped++; continue; } // bounds / editor-temp (WATCH-6)

      const data = new Uint8Array(await fs.readFile(path.join(c.folderPath, e.name)));
      const hash = hashContent(data);
      const prior = ledger[e.name];
      if (prior && prior.hash === hash) { skipped++; continue; } // unchanged re-save → no-op (WATCH-8)

      const fetchedAt = now();
      const stampMs = Date.parse(fetchedAt) || Date.now();
      const sourceId = await ingestWatchedFile(root, c, e.name, data, stampMs, fetchedAt, prior?.sourceId);
      ledger[e.name] = { hash, sourceId };
      sourceIds.push(sourceId);
      ingestedNames.push({ name: e.name, sourceId, ...(prior ? { priorSourceId: prior.sourceId } : {}) });
    }
  } catch (err) {
    // A copy/capture failed mid-pass (WATCH/INTAKE-12 parity): already-committed sources stay; record
    // the partial outcome + error, and only successfully-ingested files advance the ledger.
    failure = err instanceof Error ? err.message : String(err);
  }

  if (ingestedNames.length > 0) await writeWatchLedger(root, c.id, ledger);

  if (ingestedNames.length === 0 && !failure) {
    await appendAuditEvent(root, { actor: 'watch', eventType: 'watch-no-new', ts: now(), subjects: { watchId: c.id }, payload: { folderPath: c.folderPath, skipped, why: 'folder-watch pass — no new/changed files' } });
    return { sourceIds, ingested: 0, skipped, note: 'no new files' };
  }

  await appendAuditEvent(root, {
    actor: 'watch',
    eventType: 'watch-ingested',
    ts: now(),
    subjects: { watchId: c.id, ...(sourceIds[0] ? { sourceId: sourceIds[0] } : {}) },
    payload: {
      folderPath: c.folderPath,
      files: ingestedNames.map((f) => f.name),
      sourceIds,
      // carry the prior-source link for each changed (superseding) file (ratified Fork#1)
      supersedes: ingestedNames.filter((f) => f.priorSourceId).map((f) => ({ name: f.name, priorSourceId: f.priorSourceId, sourceId: f.sourceId })),
      ...(failure ? { partialFailure: failure } : {}),
      why: 'folder-watch arrival (non-destructive copy → primary source)',
    },
  });

  return {
    sourceIds,
    ingested: ingestedNames.length,
    skipped,
    ...(failure ? { failed: true, error: failure } : {}),
    note: `${ingestedNames.length} ingested, ${skipped} skipped${failure ? ` (partial: ${failure})` : ''}`,
  };
}
