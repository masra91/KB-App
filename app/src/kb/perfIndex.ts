// Derived perf index (SPEC-0030 OBS-14/16) — a rebuildable, cached aggregation of the spans
// (tracing.ts) the pipeline emits, mirroring the activity index (SPEC-0029 AUDIT-4): build from
// the on-disk source, cache under the gitignored `.kb/cache/`, serve the cache while fresh.
//
// It answers "where does the time go?": per-stage throughput (items/min) + duration, Copilot-call
// latency (avg/p50/p95 — the dominant cost, OBS-13), a where-time-goes split (Copilot vs other),
// and the recent slow operations (OBS-15). `spansForItem` reads one item's hops end-to-end (OBS-16).
//
// Freshness: spans are NOT git-committed (working zone), so unlike the activity index this can't
// poke git HEAD; it keys on the spans file's size+mtime — a cheap stat — and rebuilds when it grows.
// "Recent window" (OBS-14 open question): aggregate the newest `window` spans, not all history.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { vaultSpansPath, COPILOT_OP, STAGE_RUN_OP, type Span } from './tracing';

// Re-export the span ops so callers that aggregate spans can reference them from one place.
export { COPILOT_OP, STAGE_RUN_OP } from './tracing';

/** Bump when the cached shape changes — an older cache is then discarded. */
export const PERF_INDEX_VERSION = 1;

/** Vault-relative cache location (working zone — gitignored, never promoted). */
export const PERF_INDEX_REL = path.join('.kb', 'cache', 'perf-index.json');

/** Default cap on the most-recent spans aggregated (OBS-14 "recent window"). */
export const DEFAULT_SPAN_WINDOW = 5000;

/** Default count of slow operations surfaced (OBS-15). */
export const DEFAULT_SLOW_COUNT = 10;

/** Copilot-call latency summary (OBS-13/14) — the dominant pipeline cost. */
export interface CopilotLatency {
  count: number;
  avgMs: number;
  p50Ms: number;
  p95Ms: number;
}

/** Per-stage throughput + duration (OBS-14). */
export interface StageThroughput {
  stage: string;
  /** Number of completed `stage.run` spans in the window. */
  runs: number;
  /** Mean stage-run duration (ms). */
  avgMs: number;
  /** Items per minute across the window's wall-clock span for this stage (0 if indeterminate). */
  throughputPerMin: number;
}

/** Where elapsed time goes (OBS-14): Copilot vs everything else, over the stage-run total. */
export interface WhereTimeGoes {
  /** Sum of `stage.run` durations — the wall-clock the pipeline spent processing items. */
  totalMs: number;
  /** Sum of `copilot.invoke` durations. */
  copilotMs: number;
  /** `totalMs - copilotMs` (git/worktree/parse/lock waits), floored at 0. */
  otherMs: number;
  /** `copilotMs / totalMs` in [0,1] (0 when totalMs is 0). */
  copilotPct: number;
}

/** A recent slow operation (OBS-15). */
export interface SlowOp {
  spanId: string;
  op: string;
  stage?: string;
  itemId?: string;
  durationMs: number;
  startTs: string;
}

/** Identity of the spans source a cache was built from, for freshness. */
export interface SpansSource {
  size: number;
  mtimeMs: number;
}

/** The cached, derived perf index. */
export interface PerfIndex {
  version: number;
  builtAt: string;
  /** The spans-file stat this index was built from (null when the file was absent). */
  source: SpansSource | null;
  /** Spans aggregated (after the recent-window cap). */
  spanCount: number;
  /** True when more spans existed than the window and older ones were dropped. */
  truncated: boolean;
  copilot: CopilotLatency;
  stages: StageThroughput[];
  whereTimeGoes: WhereTimeGoes;
  slowest: SlowOp[];
}

export interface BuildPerfOptions {
  /** Cap on most-recent spans aggregated. Default DEFAULT_SPAN_WINDOW. */
  window?: number;
  /** How many slow ops to surface. Default DEFAULT_SLOW_COUNT. */
  slowCount?: number;
  /** Injectable clock for `builtAt` (deterministic tests). */
  now?: () => string;
}

/** Nearest-rank percentile of an ascending-sorted numeric array (q in [0,1]). 0 for empty. */
function percentile(sortedAsc: number[], q: number): number {
  if (sortedAsc.length === 0) return 0;
  const rank = Math.ceil(q * sortedAsc.length);
  const idx = Math.min(sortedAsc.length - 1, Math.max(0, rank - 1));
  return sortedAsc[idx];
}

/** Byte budget for the tail read (OBS-23). Comfortably larger than DEFAULT_SPAN_WINDOW spans (a
 *  span line is a few hundred bytes), so reading only the tail still yields the full recent window. */
export const DEFAULT_SPANS_TAIL_BYTES = 4 * 1024 * 1024;

/**
 * Read + parse the MOST-RECENT spans, newest-last (OBS-23). Reads only the TAIL of the spans file
 * (the last `tailBytes`, covering well over DEFAULT_SPAN_WINDOW spans) rather than the whole file,
 * so a status poll is O(window) regardless of how large `spans.jsonl` has grown. The unbounded
 * whole-file read + per-line parse here was what blew the 8000ms status `loadGuard` and timed out
 * the Status view on a long run (#256). perfIndex only aggregates the recent window, so dropping
 * older spans beyond the tail is by design. Missing/unreadable → [].
 */
export async function readSpans(root: string, opts: { tailBytes?: number } = {}): Promise<Span[]> {
  const file = vaultSpansPath(path.resolve(root));
  const tailBytes = opts.tailBytes ?? DEFAULT_SPANS_TAIL_BYTES;
  let raw: string;
  try {
    const { size } = await fs.stat(file);
    if (size <= tailBytes) {
      raw = await fs.readFile(file, 'utf8');
    } else {
      // Read ONLY the last `tailBytes` — O(window), not O(file). The first line is cut mid-record,
      // so drop everything up to the first newline before parsing.
      const fh = await fs.open(file, 'r');
      try {
        const buf = Buffer.alloc(tailBytes);
        await fh.read(buf, 0, tailBytes, size - tailBytes);
        const tail = buf.toString('utf8');
        const nl = tail.indexOf('\n');
        raw = nl >= 0 ? tail.slice(nl + 1) : '';
      } finally {
        await fh.close();
      }
    }
  } catch {
    return [];
  }
  const out: Span[] = [];
  for (const line of raw.split('\n')) {
    if (line.trim().length === 0) continue;
    try {
      const obj = JSON.parse(line) as Span;
      if (typeof obj.spanId === 'string' && typeof obj.durationMs === 'number') out.push(obj);
    } catch {
      /* a torn/partial line (mid-append) — skip */
    }
  }
  return out;
}

/** Stat the spans file for freshness (size+mtime). Null when absent. */
async function statSpans(root: string): Promise<SpansSource | null> {
  try {
    const s = await fs.stat(vaultSpansPath(path.resolve(root)));
    return { size: s.size, mtimeMs: s.mtimeMs };
  } catch {
    return null;
  }
}

/** Build the perf index from the spans on disk (always-correct path). */
export async function buildPerfIndex(root: string, opts: BuildPerfOptions = {}): Promise<PerfIndex> {
  root = path.resolve(root);
  const window = opts.window ?? DEFAULT_SPAN_WINDOW;
  const slowCount = opts.slowCount ?? DEFAULT_SLOW_COUNT;
  const now = opts.now ?? ((): string => new Date().toISOString());

  const all = await readSpans(root);
  const truncated = all.length > window;
  const spans = truncated ? all.slice(all.length - window) : all;
  const source = await statSpans(root);

  // Copilot latency (OBS-13/14).
  const copilotDurs = spans.filter((s) => s.op === COPILOT_OP).map((s) => s.durationMs).sort((a, b) => a - b);
  const copilotSum = copilotDurs.reduce((a, b) => a + b, 0);
  const copilot: CopilotLatency = {
    count: copilotDurs.length,
    avgMs: copilotDurs.length ? Math.round(copilotSum / copilotDurs.length) : 0,
    p50Ms: Math.round(percentile(copilotDurs, 0.5)),
    p95Ms: Math.round(percentile(copilotDurs, 0.95)),
  };

  // Per-stage throughput from `stage.run` spans (OBS-14).
  const byStage = new Map<string, Span[]>();
  for (const s of spans) {
    if (s.op !== STAGE_RUN_OP || s.stage === undefined) continue;
    const list = byStage.get(s.stage) ?? [];
    list.push(s);
    byStage.set(s.stage, list);
  }
  const stages: StageThroughput[] = [...byStage.entries()]
    .map(([stage, runs]) => {
      const sum = runs.reduce((a, b) => a + b.durationMs, 0);
      const starts = runs.map((r) => Date.parse(r.startTs)).filter(Number.isFinite);
      const ends = runs.map((r) => Date.parse(r.endTs)).filter(Number.isFinite);
      const wallMs = starts.length && ends.length ? Math.max(...ends) - Math.min(...starts) : 0;
      const throughputPerMin = wallMs > 0 ? (runs.length / wallMs) * 60_000 : 0;
      return {
        stage,
        runs: runs.length,
        avgMs: runs.length ? Math.round(sum / runs.length) : 0,
        throughputPerMin: Math.round(throughputPerMin * 100) / 100,
      };
    })
    .sort((a, b) => (a.stage < b.stage ? -1 : 1));

  // Where time goes (OBS-14): Copilot vs other, over the stage-run total.
  const totalMs = spans.filter((s) => s.op === STAGE_RUN_OP).reduce((a, b) => a + b.durationMs, 0);
  const otherMs = Math.max(0, totalMs - copilotSum);
  const whereTimeGoes: WhereTimeGoes = {
    totalMs,
    copilotMs: copilotSum,
    otherMs,
    copilotPct: totalMs > 0 ? Math.round((copilotSum / totalMs) * 100) / 100 : 0,
  };

  // Recent slow operations (OBS-15).
  const slowest: SlowOp[] = [...spans]
    .sort((a, b) => b.durationMs - a.durationMs)
    .slice(0, slowCount)
    .map((s) => ({
      spanId: s.spanId,
      op: s.op,
      ...(s.stage !== undefined ? { stage: s.stage } : {}),
      ...(s.itemId !== undefined ? { itemId: s.itemId } : {}),
      durationMs: s.durationMs,
      startTs: s.startTs,
    }));

  return {
    version: PERF_INDEX_VERSION,
    builtAt: now(),
    source,
    spanCount: spans.length,
    truncated,
    copilot,
    stages,
    whereTimeGoes,
    slowest,
  };
}

/** Persist the index to the gitignored cache. */
export async function writePerfIndexCache(root: string, index: PerfIndex): Promise<void> {
  const file = path.join(path.resolve(root), PERF_INDEX_REL);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(index), 'utf8');
}

/** Read the cached index, or null when absent/unreadable/stale-shape. */
export async function readPerfIndexCache(root: string): Promise<PerfIndex | null> {
  const file = path.join(path.resolve(root), PERF_INDEX_REL);
  try {
    const parsed = JSON.parse(await fs.readFile(file, 'utf8')) as PerfIndex;
    if (parsed.version !== PERF_INDEX_VERSION) return null;
    return parsed;
  } catch {
    return null;
  }
}

function sameSource(a: SpansSource | null, b: SpansSource | null): boolean {
  if (a === null || b === null) return a === b; // both-absent is fresh; one-absent is not
  return a.size === b.size && a.mtimeMs === b.mtimeMs;
}

/**
 * Load the perf index, rebuilding only when the spans file changed. Freshness keys on the spans
 * file's size+mtime (spans aren't committed, so there's no git HEAD to poke). A full rebuild via
 * {@link buildPerfIndex} is always the fallback.
 */
export async function loadPerfIndex(root: string, opts: BuildPerfOptions = {}): Promise<PerfIndex> {
  root = path.resolve(root);
  const cached = await readPerfIndexCache(root);
  if (cached) {
    const current = await statSpans(root);
    if (sameSource(cached.source, current)) return cached;
  }
  const fresh = await buildPerfIndex(root, opts);
  await writePerfIndexCache(root, fresh).catch(() => {
    /* cache is an optimization; a read-only / racing FS must not fail the read */
  });
  return fresh;
}

/** One item's spans (OBS-16), oldest-first — the end-to-end per-hop trace for `itemId`. */
export async function spansForItem(root: string, itemId: string): Promise<Span[]> {
  const spans = await readSpans(root);
  return spans
    .filter((s) => s.itemId === itemId)
    .sort((a, b) => Date.parse(a.startTs) - Date.parse(b.startTs));
}
