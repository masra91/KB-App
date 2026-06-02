// SPEC-0030 OBS-14/16 — the derived perf index: aggregate spans into Copilot latency, per-stage
// throughput, where-time-goes, and slow ops; cache + freshness; per-item end-to-end hops.
import { describe, it, expect, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { makeTempDir, rmTempDir } from '../../test/tempVault';
import { vaultSpansPath, type Span } from './tracing';
import {
  buildPerfIndex,
  loadPerfIndex,
  readPerfIndexCache,
  spansForItem,
  PERF_INDEX_REL,
  type PerfIndex,
} from './perfIndex';

function span(p: Partial<Span> & Pick<Span, 'op' | 'durationMs'>): Span {
  return {
    spanId: p.spanId ?? `s-${Math.round(p.durationMs)}`,
    op: p.op,
    startTs: p.startTs ?? '2026-06-02T00:00:00.000Z',
    endTs: p.endTs ?? '2026-06-02T00:00:01.000Z',
    durationMs: p.durationMs,
    outcome: p.outcome ?? 'ok',
    ...(p.parentSpanId !== undefined ? { parentSpanId: p.parentSpanId } : {}),
    ...(p.stage !== undefined ? { stage: p.stage } : {}),
    ...(p.itemId !== undefined ? { itemId: p.itemId } : {}),
  };
}

/** Write spans to <root>/.kb/cache/spans.jsonl (newest-last, as the tracer appends). */
async function writeSpans(root: string, spans: Span[]): Promise<void> {
  const file = vaultSpansPath(root);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, spans.map((s) => JSON.stringify(s)).join('\n') + '\n', 'utf8');
}

const FIXTURE: Span[] = [
  // decompose: 2 stage runs over a 4s wall window (10:00:00→10:00:04)
  span({ op: 'stage.run', stage: 'decompose', itemId: 'SRC1', durationMs: 1000, startTs: '2026-06-02T10:00:00.000Z', endTs: '2026-06-02T10:00:01.000Z' }),
  span({ op: 'stage.run', stage: 'decompose', itemId: 'SRC2', durationMs: 2000, startTs: '2026-06-02T10:00:02.000Z', endTs: '2026-06-02T10:00:04.000Z' }),
  // copilot invocations (the dominant cost): durations 100/200/300/400
  span({ op: 'copilot.invoke', stage: 'decompose', itemId: 'SRC1', durationMs: 100, parentSpanId: 's-1000' }),
  span({ op: 'copilot.invoke', stage: 'decompose', itemId: 'SRC2', durationMs: 200, parentSpanId: 's-2000' }),
  span({ op: 'copilot.invoke', stage: 'connect', itemId: 'E1', durationMs: 300 }),
  span({ op: 'copilot.invoke', stage: 'connect', itemId: 'E1', durationMs: 400 }),
];

describe('perf index (SPEC-0030 OBS-14/16)', () => {
  let root: string | undefined;
  afterEach(async () => {
    if (root) await rmTempDir(root);
    root = undefined;
  });

  it('aggregates Copilot latency avg/p50/p95 (OBS-13/14)', async () => {
    root = await makeTempDir('kb-perf-');
    await writeSpans(root, FIXTURE);
    const idx = await buildPerfIndex(root, { now: () => 'T' });
    expect(idx.copilot.count).toBe(4);
    expect(idx.copilot.avgMs).toBe(250); // (100+200+300+400)/4
    expect(idx.copilot.p50Ms).toBe(200); // nearest-rank q=.5 over [100,200,300,400]
    expect(idx.copilot.p95Ms).toBe(400);
  });

  it('computes per-stage throughput from stage.run spans (OBS-14)', async () => {
    root = await makeTempDir('kb-perf-');
    await writeSpans(root, FIXTURE);
    const idx = await buildPerfIndex(root);
    const decompose = idx.stages.find((s) => s.stage === 'decompose')!;
    expect(decompose.runs).toBe(2);
    expect(decompose.avgMs).toBe(1500); // (1000+2000)/2
    expect(decompose.throughputPerMin).toBe(30); // 2 runs / 4000ms * 60000
    // connect has no stage.run spans here → not present in the throughput table
    expect(idx.stages.find((s) => s.stage === 'connect')).toBeUndefined();
  });

  it('splits where-time-goes (Copilot vs other) over the stage-run total (OBS-14)', async () => {
    root = await makeTempDir('kb-perf-');
    await writeSpans(root, FIXTURE);
    const idx = await buildPerfIndex(root);
    expect(idx.whereTimeGoes.totalMs).toBe(3000); // 1000 + 2000 stage runs
    expect(idx.whereTimeGoes.copilotMs).toBe(1000); // 100+200+300+400
    expect(idx.whereTimeGoes.otherMs).toBe(2000);
    expect(idx.whereTimeGoes.copilotPct).toBe(0.33); // round(1000/3000)
  });

  it('surfaces the slowest operations (OBS-15)', async () => {
    root = await makeTempDir('kb-perf-');
    await writeSpans(root, FIXTURE);
    const idx = await buildPerfIndex(root, { slowCount: 3 });
    expect(idx.slowest.map((s) => s.durationMs)).toEqual([2000, 1000, 400]);
  });

  it('caches and rebuilds only when the spans file changes (freshness)', async () => {
    root = await makeTempDir('kb-perf-');
    await writeSpans(root, FIXTURE);
    const first = await loadPerfIndex(root, { now: () => 'BUILD-1' });
    expect(first.spanCount).toBe(6);
    expect(await readPerfIndexCache(root)).not.toBeNull();

    // Unchanged spans file → served from cache (same builtAt).
    const cached = await loadPerfIndex(root, { now: () => 'BUILD-2' });
    expect(cached.builtAt).toBe('BUILD-1');

    // Append a span → file grows → rebuild picks it up.
    await fs.appendFile(vaultSpansPath(root), JSON.stringify(span({ op: 'copilot.invoke', durationMs: 50 })) + '\n');
    const rebuilt = await loadPerfIndex(root, { now: () => 'BUILD-3' });
    expect(rebuilt.builtAt).toBe('BUILD-3');
    expect(rebuilt.spanCount).toBe(7);
  });

  it('caps to the recent window and marks truncated', async () => {
    root = await makeTempDir('kb-perf-');
    const many = Array.from({ length: 10 }, (_v, i) => span({ op: 'copilot.invoke', durationMs: i + 1 }));
    await writeSpans(root, many);
    const idx = await buildPerfIndex(root, { window: 4 });
    expect(idx.truncated).toBe(true);
    expect(idx.spanCount).toBe(4);
    expect(idx.copilot.count).toBe(4); // only the newest 4
  });

  it('spansForItem returns one item end-to-end, oldest-first (OBS-16)', async () => {
    root = await makeTempDir('kb-perf-');
    await writeSpans(root, FIXTURE);
    const hops = await spansForItem(root, 'SRC1');
    expect(hops).toHaveLength(2); // stage.run + copilot.invoke for SRC1
    expect(hops.every((s) => s.itemId === 'SRC1')).toBe(true);
    expect(hops[0].startTs <= hops[1].startTs).toBe(true);
  });

  it('an absent spans file yields an empty, well-formed index', async () => {
    root = await makeTempDir('kb-perf-');
    const idx: PerfIndex = await buildPerfIndex(root);
    expect(idx.spanCount).toBe(0);
    expect(idx.copilot).toEqual({ count: 0, avgMs: 0, p50Ms: 0, p95Ms: 0 });
    expect(idx.stages).toEqual([]);
    expect(idx.source).toBeNull();
    expect(PERF_INDEX_REL.startsWith(path.join('.kb', 'cache'))).toBe(true);
  });
});
