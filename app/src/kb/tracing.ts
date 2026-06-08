// Latency tracing (SPEC-0030 OBS-12/13/16) — timed, nestable spans that make elapsed pipeline
// time *attributable to where it's spent*. A span is `{spanId, parentSpanId, op, itemId, stage,
// startTs, endTs, durationMs, outcome}`; a stage-run span wraps its Copilot-invocation span (and,
// later, git/worktree spans), so "ingestion→link took 90s" becomes "87s of it was Copilot."
//
// Spans are OPERATIONAL diagnostics, deliberately separate from the knowledge AUDIT (SPEC-0029)
// and complementary to `AgentTrace` (ORCH-16, the audit-side per-decision provenance): a stage
// SYNTHESIZES a `copilot.invoke` span from the `decision.agent` trace it already receives, so the
// thin agents stay untouched — only stages carry a `Tracer` (the same pattern as `DevLog`).
//
// Sink: an append-only `<vault>/.kb/cache/spans.jsonl` (working zone — gitignored, never promoted),
// the queryable source the derived perf index (perfIndex.ts, OBS-14) aggregates. Writing a span
// must NEVER throw into the pipeline: appends serialize on a self-swallowing tail (like devlog).
// A NO-OP tracer (`noopTracer`) is the safe default so stages take an optional `Tracer` with no
// caller/test churn. Each span is also mirrored to the dev log at `debug` (OBS-12 "to the dev log").
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { ulid } from './ulid';
import { noopDevLog, type DevLog } from './devlog';

/** A span's terminal outcome. `ok` = succeeded, `error` = threw, `setaside` = item set aside. */
export type SpanOutcome = 'ok' | 'error' | 'setaside';

/** The op that wraps one stage's per-item processing (its Copilot + git/worktree time). */
export const STAGE_RUN_OP = 'stage.run';
/** The op that times a single Copilot invocation (OBS-13) — the dominant cost. */
export const COPILOT_OP = 'copilot.invoke';

/** A completed timed span (SPEC-0030 OBS-12). Durations are ms; timestamps ISO-8601. */
export interface Span {
  spanId: string;
  /** The enclosing span, when this one nests inside another (e.g. copilot inside a stage run). */
  parentSpanId?: string;
  /** The operation, e.g. `stage.run`, `copilot.invoke` (dotted `scope.verb`). */
  op: string;
  /** The pipeline stage this span belongs to (decompose/connect/claims/archive/job), if any. */
  stage?: string;
  /** The item being processed (sourceId/entityId/…), for per-item end-to-end tracing (OBS-16). */
  itemId?: string;
  startTs: string;
  endTs: string;
  durationMs: number;
  outcome: SpanOutcome;
}

/** Binding carried onto every span a tracer (or active span) emits. */
export interface SpanFields {
  stage?: string;
  itemId?: string;
  parentSpanId?: string;
}

/** A started, not-yet-ended span. `end` stamps the duration + records it; `child` nests under it. */
export interface ActiveSpan {
  readonly id: string;
  /** Start a child span (its `parentSpanId` is this span's id). */
  child(op: string, fields?: Omit<SpanFields, 'parentSpanId'>): ActiveSpan;
  /** Stamp `endTs`/`durationMs` and record the span. Idempotent (a second call is a no-op). */
  end(outcome?: SpanOutcome): void;
}

/** Span context handed to an agent decider so it can time its Copilot call as a CHILD of the
 *  stage's run span (OBS-12 nesting) — without the thin agent needing a `Tracer` of its own. */
export interface SpanCtx {
  span?: ActiveSpan;
}

export interface Tracer {
  /** Begin a span at "now". Inherits `stage`/`itemId` defaults unless overridden in `fields`. */
  start(op: string, fields?: SpanFields): ActiveSpan;
  /** Record a fully-formed span whose timing is already known (e.g. synthesized from an
   *  `AgentTrace`: the agent measured the Copilot call, the stage emits the span). */
  record(span: Span): void;
  /** Await all pending span writes (tests; clean shutdown). */
  flush(): Promise<void>;
}

/** Rotate the active spans file at this many bytes. Default 8 MB — comfortably larger than the
 *  perfIndex recent-window (5000 spans ≈ <2 MB), so the window always fits in the active file. */
export const DEFAULT_SPANS_MAX_BYTES = 8 * 1024 * 1024;
/** Keep this many rotated spans files (`.1`..`.N`); older are dropped. Default 3. */
export const DEFAULT_SPANS_MAX_FILES = 3;

export interface TracerOptions {
  /** Directory the spans file lives in (created on first write). */
  dir: string;
  /** Spans filename. Default `spans.jsonl`. */
  file?: string;
  /** Injectable clock for deterministic timestamps in tests. Default `() => new Date()`. */
  now?: () => Date;
  /** Injectable span-id minter (tests). Default `ulid`. */
  mintId?: () => string;
  /** Dev log to mirror each span to at `debug` (OBS-12 "emit to the dev log"). Default noop. */
  log?: DevLog;
  /** Rotate the active spans file when it would exceed this many bytes. Default 8 MB.
   *  Bounds the file so a long run can't grow it without limit (#256: an unrotated spans file the
   *  status poll fully re-read drove the heap to OOM). 0 disables rotation. */
  maxBytes?: number;
  /** Keep this many rotated files (`.1`..`.N`). Default 3. */
  maxFiles?: number;
}

/** The per-vault spans file: `<vault>/.kb/cache/spans.jsonl` — gitignored, never promoted (OBS-2/12). */
export function vaultSpansPath(vaultPath: string): string {
  return path.join(vaultPath, '.kb', 'cache', 'spans.jsonl');
}

interface Sink {
  dir: string;
  file: string;
  now: () => Date;
  mintId: () => string;
  log: DevLog;
  maxBytes: number;
  maxFiles: number;
  bytes: number | null; // active-file size; null until first stat
  tail: Promise<void>; // serialized, self-swallowing write chain
}

/** Rotate `spans.jsonl` → `.1` → `.2` … dropping the oldest beyond maxFiles (mirrors devlog). The
 *  perfIndex aggregates only the *recent* window, so dropping old rotated spans is by design. */
async function rotateSpans(sink: Sink): Promise<void> {
  const base = path.join(sink.dir, sink.file);
  await fs.rm(`${base}.${sink.maxFiles}`, { force: true });
  for (let i = sink.maxFiles - 1; i >= 1; i--) {
    await fs.rename(`${base}.${i}`, `${base}.${i + 1}`).catch(() => {});
  }
  await fs.rename(base, `${base}.1`).catch(() => {});
  sink.bytes = 0;
}

async function writeSpanLine(sink: Sink, line: string): Promise<void> {
  await fs.mkdir(sink.dir, { recursive: true });
  const p = path.join(sink.dir, sink.file);
  if (sink.bytes === null) {
    sink.bytes = await fs
      .stat(p)
      .then((s) => s.size)
      .catch(() => 0);
  }
  const size = Buffer.byteLength(line);
  // #256: bound the spans file — an unrotated, ever-growing spans.jsonl that the status poll
  // fully re-read (perfIndex.readSpans) drove the heap to OOM over a long run. Rotate like devlog.
  if (sink.maxBytes > 0 && sink.maxFiles > 0 && sink.bytes > 0 && sink.bytes + size > sink.maxBytes) {
    await rotateSpans(sink);
  }
  await fs.appendFile(p, line);
  sink.bytes = (sink.bytes ?? 0) + size;
}

function appendSpan(sink: Sink, span: Span): void {
  const line = JSON.stringify(span) + '\n';
  sink.log.debug('span', { ...span });
  // Serialize + swallow: tracing must never reject into the caller's path.
  sink.tail = sink.tail.then(() => writeSpanLine(sink, line)).catch(() => {});
}

class ActiveSpanImpl implements ActiveSpan {
  readonly id: string;
  private ended = false;
  constructor(
    private readonly sink: Sink,
    private readonly op: string,
    private readonly fields: SpanFields,
    private readonly startTs: string,
  ) {
    this.id = sink.mintId();
  }

  child(op: string, fields: Omit<SpanFields, 'parentSpanId'> = {}): ActiveSpan {
    return new ActiveSpanImpl(
      this.sink,
      op,
      // Inherit the parent's stage + itemId so a copilot child auto-carries them (OBS-16) unless
      // the caller overrides; `parentSpanId` links the nesting (OBS-12).
      { stage: this.fields.stage, itemId: this.fields.itemId, ...fields, parentSpanId: this.id },
      this.sink.now().toISOString(),
    );
  }

  end(outcome: SpanOutcome = 'ok'): void {
    if (this.ended) return;
    this.ended = true;
    const endTs = this.sink.now().toISOString();
    const durationMs = Math.max(0, Date.parse(endTs) - Date.parse(this.startTs));
    appendSpan(this.sink, {
      spanId: this.id,
      ...(this.fields.parentSpanId !== undefined ? { parentSpanId: this.fields.parentSpanId } : {}),
      op: this.op,
      ...(this.fields.stage !== undefined ? { stage: this.fields.stage } : {}),
      ...(this.fields.itemId !== undefined ? { itemId: this.fields.itemId } : {}),
      startTs: this.startTs,
      endTs,
      durationMs,
      outcome,
    });
  }
}

class TracerImpl implements Tracer {
  constructor(private readonly sink: Sink) {}

  start(op: string, fields: SpanFields = {}): ActiveSpan {
    return new ActiveSpanImpl(this.sink, op, fields, this.sink.now().toISOString());
  }

  record(span: Span): void {
    appendSpan(this.sink, span);
  }

  flush(): Promise<void> {
    return this.sink.tail;
  }
}

/** Create a tracer appending spans to `<dir>/<file>` (default `spans.jsonl`). */
export function createTracer(opts: TracerOptions): Tracer {
  const sink: Sink = {
    dir: opts.dir,
    file: opts.file ?? 'spans.jsonl',
    now: opts.now ?? ((): Date => new Date()),
    mintId: opts.mintId ?? ulid,
    log: opts.log ?? noopDevLog,
    maxBytes: opts.maxBytes ?? DEFAULT_SPANS_MAX_BYTES,
    maxFiles: opts.maxFiles ?? DEFAULT_SPANS_MAX_FILES,
    bytes: null,
    tail: Promise.resolve(),
  };
  return new TracerImpl(sink);
}

/** A per-vault tracer writing to `<vault>/.kb/cache/spans.jsonl` (OBS-12). */
export function createVaultTracer(vaultPath: string, opts: Omit<TracerOptions, 'dir' | 'file'> = {}): Tracer {
  return createTracer({ ...opts, dir: path.dirname(vaultSpansPath(vaultPath)), file: path.basename(vaultSpansPath(vaultPath)) });
}

/** A no-op active span — `end`/`child` do nothing. The safe default a stage hands a decider when
 *  no tracer is wired, so the agent's `ctx.span?.child(...)` path stays uniform (tests / standalone). */
export const noopActiveSpan: ActiveSpan = {
  id: '',
  child: () => noopActiveSpan,
  end: () => {},
};

/** A tracer that discards everything — the safe default when no tracer is wired (tests / standalone). */
export const noopTracer: Tracer = {
  start: () => noopActiveSpan,
  record: () => {},
  flush: () => Promise.resolve(),
};
