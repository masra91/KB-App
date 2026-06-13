// SPEC-0042 EVAL Slice-1 — vault state snapshot (EVAL-3 input). After the action script drains, the
// runner captures the resulting KB state into a plain VaultSnapshot the deterministic validators read.
// This is the DURABLE HOME (KB-Lead affirmation) for the state-reading the enrichE2eDogfood dogfood did
// hand-wired (walk entities/claims/sources + read the recall result + audit) — consolidated, not forked.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { readEvents } from '../../src/kb/activityIndex';
import type { AuditEvent } from '../../src/kb/audit';
import type { AskResult } from '../../src/kb/recall';
import { vaultSpansPath, type Span } from '../../src/kb/tracing';
import { readRecentDevLogEntries, type DevLogEntry } from '../../src/kb/devlog';

/** One markdown file in the vault (its repo-relative path + raw body). */
export interface VaultFile {
  /** Path relative to the vault root, e.g. `entities/person/grace-hopper.md`. */
  path: string;
  body: string;
}

/** The captured post-drain state a scenario's deterministic validators assert over (EVAL-3). */
export interface VaultSnapshot {
  root: string;
  entities: VaultFile[];
  claims: VaultFile[];
  sources: VaultFile[];
  /** Evergreen job/researcher artifacts (e.g. the example job's census note) promoted to `outputs/`
   *  (Slice-3, for jobs scenarios). Missing dir → []. */
  outputs: VaultFile[];
  /** The most recent `ask` result in the action script (if any), for recall validators. */
  recall: AskResult | null;
  /** The vault's audit events (newest-first), for audit/span validators. */
  audit: AuditEvent[];
  /** Operational spans (`.kb/cache/spans.jsonl`) — `outcome` includes `setaside`/`error`, so a
   *  robustness scenario can assert a corrupted item was gracefully set aside (not a fatal crash).
   *  Empty unless the driver wired a tracer (EVAL robustness, SPEC-0042). */
  spans: Span[];
  /** Recent dev-log entries (the vault `pipeline.log`), warn+ — an `error` entry carries the failure
   *  MESSAGE, so a scenario can assert a failure was SURFACED in telemetry (not swallowed silently).
   *  Empty unless the driver wired a dev-log. */
  devLog: DevLogEntry[];
}

/** Read + parse the spans JSONL (`.kb/cache/spans.jsonl`); missing/empty → []. Lines that don't parse
 *  are skipped (the file is append-only + self-swallowing, so a torn tail line is possible). */
async function readSpans(root: string): Promise<Span[]> {
  let raw: string;
  try {
    raw = await fs.readFile(vaultSpansPath(root), 'utf8');
  } catch {
    return [];
  }
  const out: Span[] = [];
  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (t.length === 0) continue;
    try {
      out.push(JSON.parse(t) as Span);
    } catch {
      /* torn/partial line — skip */
    }
  }
  return out;
}

/** Recursively collect `.md` files under `<root>/<sub>` as repo-relative VaultFiles (missing dir → []). */
async function readTree(root: string, sub: string): Promise<VaultFile[]> {
  const out: VaultFile[] = [];
  async function walk(dir: string): Promise<void> {
    let entries: import('node:fs').Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return; // missing subtree (e.g. no claims yet) → no files, not an error
    }
    for (const e of entries) {
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) await walk(abs);
      else if (e.isFile() && e.name.endsWith('.md')) out.push({ path: path.relative(root, abs), body: await fs.readFile(abs, 'utf8') });
    }
  }
  await walk(path.join(root, sub));
  return out;
}

/** Capture the post-drain vault state (entities/claims/sources + the last recall + audit) for validation. */
export async function captureSnapshot(root: string, opts: { recall?: AskResult | null } = {}): Promise<VaultSnapshot> {
  const [entities, claims, sources, outputs] = await Promise.all([readTree(root, 'entities'), readTree(root, 'claims'), readTree(root, 'sources'), readTree(root, 'outputs')]);
  let audit: AuditEvent[] = [];
  try {
    audit = await readEvents(root, {});
  } catch {
    audit = [];
  }
  const spans = await readSpans(root);
  // Capture warn+ telemetry; a robustness scenario asserts an `error` entry (the surfaced failure
  // message) + a `setaside` span. Limit generously so a whole drain's telemetry is in-frame.
  let devLog: DevLogEntry[] = [];
  try {
    devLog = await readRecentDevLogEntries(root, { minLevel: 'warn', limit: 1000 });
  } catch {
    devLog = [];
  }
  return { root, entities, claims, sources, outputs, recall: opts.recall ?? null, audit, spans, devLog };
}
