// Diagnostic dev-log (SPEC-0030 OBS-1/2) — a minimal, in-house, leveled + size-rotated JSONL
// logger for OPERATIONAL diagnostics (exceptions/stack traces, subprocess stderr, git/worktree/
// lock detail, timings). Deliberately separate from the knowledge AUDIT (SPEC-0029): audit is
// curated knowledge lineage; this is the verbose cause behind a failure. No dependency (E1) —
// pino/winston would be overkill for an append-only JSONL sink.
//
// Cross-links to the audit by `runId`/`itemId` (OBS-3): bind them via `.child({runId, itemId})`
// so every diagnostic line carries the same ids as the structured audit event it explains.
//
// Logging must NEVER throw into the pipeline: methods return void and enqueue writes on a
// serialized, self-swallowing chain. Tests await `flush()`. A NO-OP logger (`noopDevLog`) is the
// safe default so stages can take an optional `DevLog` without callers/tests changing.
import { promises as fs } from 'node:fs';
import path from 'node:path';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
const RANK: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export const DEFAULT_MAX_BYTES = 5 * 1024 * 1024; // 5 MB
export const DEFAULT_MAX_FILES = 5;
const REDACTED = '[redacted]';

export type Fields = Record<string, unknown> & {
  /** Values here are redacted unless the sink level is `debug` (OBS-10 minimal: captured text, egress payloads). */
  sensitive?: Record<string, unknown>;
  /** An Error (or anything) describing the cause — normalized to {message, stack}. */
  err?: unknown;
};

export interface DevLog {
  debug(event: string, fields?: Fields): void;
  info(event: string, fields?: Fields): void;
  warn(event: string, fields?: Fields): void;
  error(event: string, fields?: Fields): void;
  /** Bind scope + cross-link ids / fields onto every subsequent entry. */
  child(bind: { scope?: string; runId?: string; itemId?: string } & Record<string, unknown>): DevLog;
  /** Await all pending writes (tests; also for clean shutdown). */
  flush(): Promise<void>;
}

export interface DevLogOptions {
  /** Directory the log file lives in (created on first write). */
  dir: string;
  /** Base filename. Default `pipeline.log`; rotated files get `.1`, `.2`, … suffixes. */
  file?: string;
  /** Minimum level written. Default `info`. At `debug`, sensitive fields are included verbatim. */
  level?: LogLevel;
  /** Rotate when the active file would exceed this many bytes. Default 5 MB. */
  maxBytes?: number;
  /** Keep this many rotated files (`.1`..`.N`); older are dropped. Default 5. */
  maxFiles?: number;
  /** Injectable clock for deterministic timestamps in tests. */
  now?: () => string;
}

/** Shared, mutable sink state (one per file; children share it). */
interface Sink {
  dir: string;
  file: string;
  level: LogLevel;
  maxBytes: number;
  maxFiles: number;
  now: () => string;
  bytes: number | null; // current active-file size; null until first stat
  tail: Promise<void>; // serialized write chain
}

function normalizeErr(err: unknown): { message: string; stack?: string } | undefined {
  if (err === undefined) return undefined;
  if (err instanceof Error) return { message: err.message, stack: err.stack };
  return { message: typeof err === 'string' ? err : JSON.stringify(err) };
}

function redactSensitive(sensitive: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(sensitive)) out[k] = REDACTED;
  return out;
}

async function activePath(sink: Sink): Promise<string> {
  return path.join(sink.dir, sink.file);
}

/** Rotate `pipeline.log` → `.1` → `.2` … dropping the oldest beyond maxFiles. Best-effort. */
async function rotate(sink: Sink): Promise<void> {
  const base = path.join(sink.dir, sink.file);
  // Drop the oldest, then shift each down by one.
  await fs.rm(`${base}.${sink.maxFiles}`, { force: true });
  for (let i = sink.maxFiles - 1; i >= 1; i--) {
    await fs.rename(`${base}.${i}`, `${base}.${i + 1}`).catch(() => {});
  }
  await fs.rename(base, `${base}.1`).catch(() => {});
  sink.bytes = 0;
}

async function writeLine(sink: Sink, line: string): Promise<void> {
  await fs.mkdir(sink.dir, { recursive: true });
  const p = await activePath(sink);
  if (sink.bytes === null) {
    sink.bytes = await fs
      .stat(p)
      .then((s) => s.size)
      .catch(() => 0);
  }
  const size = Buffer.byteLength(line);
  if (sink.maxFiles > 0 && sink.bytes > 0 && sink.bytes + size > sink.maxBytes) {
    await rotate(sink);
  }
  await fs.appendFile(p, line);
  sink.bytes = (sink.bytes ?? 0) + size;
}

class DevLogImpl implements DevLog {
  constructor(
    private readonly sink: Sink,
    private readonly bound: Record<string, unknown>,
  ) {}

  private emit(level: LogLevel, event: string, fields: Fields = {}): void {
    if (RANK[level] < RANK[this.sink.level]) return;
    const { sensitive, err, ...rest } = fields;
    const entry: Record<string, unknown> = {
      ts: this.sink.now(),
      level,
      ...this.bound,
      event,
      ...rest,
    };
    if (sensitive && Object.keys(sensitive).length > 0) {
      entry.sensitive = this.sink.level === 'debug' ? sensitive : redactSensitive(sensitive);
    }
    const normalized = normalizeErr(err);
    if (normalized) entry.err = normalized;

    const line = JSON.stringify(entry) + '\n';
    // Serialize + swallow: logging must never reject into the caller's catch block.
    this.sink.tail = this.sink.tail.then(() => writeLine(this.sink, line)).catch(() => {});
  }

  debug(event: string, fields?: Fields): void {
    this.emit('debug', event, fields);
  }
  info(event: string, fields?: Fields): void {
    this.emit('info', event, fields);
  }
  warn(event: string, fields?: Fields): void {
    this.emit('warn', event, fields);
  }
  error(event: string, fields?: Fields): void {
    this.emit('error', event, fields);
  }

  child(bind: { scope?: string; runId?: string; itemId?: string } & Record<string, unknown>): DevLog {
    const merged = { ...this.bound, ...bind };
    return new DevLogImpl(this.sink, merged);
  }

  flush(): Promise<void> {
    return this.sink.tail;
  }
}

/** Create a dev-log writing leveled JSONL to `<dir>/<file>` with size-based rotation (OBS-1/2). */
export function createDevLog(opts: DevLogOptions): DevLog {
  const sink: Sink = {
    dir: opts.dir,
    file: opts.file ?? 'pipeline.log',
    level: opts.level ?? 'info',
    maxBytes: opts.maxBytes ?? DEFAULT_MAX_BYTES,
    maxFiles: opts.maxFiles ?? DEFAULT_MAX_FILES,
    now: opts.now ?? ((): string => new Date().toISOString()),
    bytes: null,
    tail: Promise.resolve(),
  };
  return new DevLogImpl(sink, {});
}

/** A logger that discards everything — the safe default when no dev-log is wired (tests / standalone stages). */
export const noopDevLog: DevLog = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => noopDevLog,
  flush: () => Promise.resolve(),
};
