// SPEC-0030 OBS-12/13/16 — the span tracer: nestable timed spans appended to a never-promoted
// spans.jsonl, never throwing into the pipeline.
import { describe, it, expect, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { makeTempDir, rmTempDir, pathExists } from '../../test/tempVault';
import { createTracer, createVaultTracer, vaultSpansPath, noopTracer, type Span } from './tracing';

/** A deterministic clock advancing 1s per call, and a stable id minter. */
function harness() {
  let tick = 0;
  const now = (): Date => new Date(Date.UTC(2026, 5, 2, 0, 0, tick++)); // +1s each call
  let n = 0;
  const mintId = (): string => `span-${n++}`;
  return { now, mintId };
}

async function readSpansFile(dir: string, file = 'spans.jsonl'): Promise<Span[]> {
  const raw = await fs.readFile(path.join(dir, file), 'utf8');
  return raw
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Span);
}

describe('tracing (SPEC-0030 OBS-12/13/16)', () => {
  let root: string | undefined;
  afterEach(async () => {
    if (root) await rmTempDir(root);
    root = undefined;
  });

  it('start→end records a span with a duration to spans.jsonl', async () => {
    root = await makeTempDir('kb-trace-');
    const { now, mintId } = harness();
    const tracer = createTracer({ dir: root, now, mintId });

    const span = tracer.start('stage.run', { stage: 'decompose', itemId: 'SRC1' });
    span.end('ok');
    await tracer.flush();

    const [s] = await readSpansFile(root);
    expect(s).toMatchObject({ spanId: 'span-0', op: 'stage.run', stage: 'decompose', itemId: 'SRC1', outcome: 'ok' });
    expect(s.durationMs).toBe(1000); // start at t=0s, end at t=1s
    expect(s.parentSpanId).toBeUndefined();
  });

  it('child spans nest (parentSpanId) and inherit stage (OBS-12)', async () => {
    root = await makeTempDir('kb-trace-');
    const { now, mintId } = harness();
    const tracer = createTracer({ dir: root, now, mintId });

    const parent = tracer.start('stage.run', { stage: 'connect', itemId: 'E1' });
    const child = parent.child('copilot.invoke');
    child.end('ok');
    parent.end('ok');
    await tracer.flush();

    const spans = await readSpansFile(root);
    const childSpan = spans.find((s) => s.op === 'copilot.invoke')!;
    const parentSpan = spans.find((s) => s.op === 'stage.run')!;
    expect(childSpan.parentSpanId).toBe(parentSpan.spanId);
    expect(childSpan.stage).toBe('connect'); // inherited from parent
  });

  it('end is idempotent — a second call records nothing more', async () => {
    root = await makeTempDir('kb-trace-');
    const tracer = createTracer({ dir: root, now: harness().now, mintId: harness().mintId });
    const span = tracer.start('op');
    span.end('ok');
    span.end('error'); // ignored
    await tracer.flush();
    expect(await readSpansFile(root)).toHaveLength(1);
  });

  it('record() appends a fully-formed span (synthesized from an AgentTrace)', async () => {
    root = await makeTempDir('kb-trace-');
    const tracer = createTracer({ dir: root });
    const span: Span = {
      spanId: 'c1',
      parentSpanId: 'p1',
      op: 'copilot.invoke',
      stage: 'claims',
      itemId: 'E9',
      startTs: '2026-06-02T00:00:00.000Z',
      endTs: '2026-06-02T00:01:27.000Z',
      durationMs: 87_000,
      outcome: 'ok',
    };
    tracer.record(span);
    await tracer.flush();
    expect((await readSpansFile(root))[0]).toEqual(span);
  });

  it('never throws into the caller when the sink is unwritable', async () => {
    root = await makeTempDir('kb-trace-');
    // Make the spans path a FILE so mkdir of its dir fails — the append must be swallowed.
    const badDir = path.join(root, 'blocker');
    await fs.writeFile(badDir, 'x'); // a file where a directory is needed
    const tracer = createTracer({ dir: path.join(badDir, 'sub') });
    expect(() => tracer.start('op').end('ok')).not.toThrow();
    await expect(tracer.flush()).resolves.toBeUndefined();
  });

  it('createVaultTracer writes to <vault>/.kb/cache/spans.jsonl', async () => {
    root = await makeTempDir('kb-trace-');
    const tracer = createVaultTracer(root);
    tracer.start('op', { itemId: 'X' }).end('ok');
    await tracer.flush();
    expect(await pathExists(vaultSpansPath(root))).toBe(true);
  });

  it('noopTracer discards everything', async () => {
    root = await makeTempDir('kb-trace-');
    const span = noopTracer.start('op', { stage: 's', itemId: 'i' });
    span.child('copilot.invoke').end('ok');
    span.end('ok');
    noopTracer.record({
      spanId: 'x', op: 'op', startTs: 't', endTs: 't', durationMs: 0, outcome: 'ok',
    });
    await noopTracer.flush();
    expect(await pathExists(path.join(root, 'spans.jsonl'))).toBe(false);
  });

  // REGRESSION (#256): an unrotated, ever-growing spans.jsonl that the status poll fully re-read
  // (perfIndex.readSpans) drove the heap to OOM over a long run. The spans file MUST rotate (like
  // devlog) so a long run can never grow the active file — and the heap allocation that reads it —
  // without bound. Fails-before (no rotation → the active file grows past maxBytes unboundedly).
  it('rotates the spans file at maxBytes so it stays bounded under a long run (#256)', async () => {
    root = await makeTempDir('kb-trace-');
    const maxBytes = 4 * 1024; // tiny cap for the test
    const maxFiles = 2;
    const tracer = createTracer({ dir: root, maxBytes, maxFiles });
    // Emit far more spans than the cap can hold in one file (simulates a long run's continuous spans).
    for (let i = 0; i < 2000; i++) {
      tracer.record({ spanId: `s${i}`, op: 'stage.run', stage: 'decompose', itemId: `SRC${i}`, startTs: 't', endTs: 't', durationMs: 1, outcome: 'ok' });
    }
    await tracer.flush();

    // The ACTIVE spans file is bounded by the rotation cap (was unbounded before the fix).
    const activeSize = (await fs.stat(path.join(root, 'spans.jsonl'))).size;
    expect(activeSize).toBeLessThanOrEqual(maxBytes);
    // Rotation produced a `.1` history file, and never more than maxFiles rotated files.
    expect(await pathExists(path.join(root, 'spans.jsonl.1'))).toBe(true);
    expect(await pathExists(path.join(root, `spans.jsonl.${maxFiles + 1}`))).toBe(false);
    // The most-recent spans are still readable from the active file (perfIndex's recent window).
    const recent = await readSpansFile(root);
    expect(recent.length).toBeGreaterThan(0);
    expect(recent[recent.length - 1].itemId).toBe('SRC1999');
  });
});
