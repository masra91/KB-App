// SPEC-0030 OBS-12/13 wiring — proves an agent decider, given a stage's run span via ctx, times
// its Copilot call as a TRUE nested child span (success AND failure), and that the emitted spans
// feed the perf index (OBS-14). This is the end-to-end contract the stages rely on; the stage
// drains open the `stage.run` span and pass it to `decider(input, { span })`.
import { describe, it, expect, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { makeTempDir, rmTempDir } from '../../test/tempVault';
import { createTracer, STAGE_RUN_OP, COPILOT_OP, type Span } from './tracing';
import { buildPerfIndex } from './perfIndex';
import { makeDecomposeDecider, type SourceInput } from './decomposeAgent';

const input = (over: Partial<SourceInput> = {}): SourceInput => ({
  sourceId: 'SRC1',
  kind: 'text',
  text: 'call Steve re: Q3 budget',
  ...over,
});

const GOOD = '{"sourceId":"SRC1","entities":[{"kind":"person","name":"Steve","confidence":0.9,"mentions":["call Steve"]}]}';

async function readSpans(dir: string): Promise<Span[]> {
  const raw = await fs.readFile(path.join(dir, 'spans.jsonl'), 'utf8');
  return raw.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as Span);
}

describe('OBS-12/13 — agent Copilot spans nest under the stage run span', () => {
  let root: string | undefined;
  afterEach(async () => {
    if (root) await rmTempDir(root);
    root = undefined;
  });

  it('a successful decider call emits a copilot.invoke child nested under stage.run', async () => {
    root = await makeTempDir('kb-obs-');
    const tracer = createTracer({ dir: root });
    const decide = makeDecomposeDecider({ available: true, run: async () => GOOD });

    const span = tracer.start(STAGE_RUN_OP, { stage: 'decompose', itemId: 'SRC1' });
    const decision = await decide(input(), { span });
    span.end('ok');
    await tracer.flush();

    expect(decision.entities[0].name).toBe('Steve'); // the decision still flows through unchanged

    const spans = await readSpans(root);
    const stageRun = spans.find((s) => s.op === STAGE_RUN_OP)!;
    const copilot = spans.find((s) => s.op === COPILOT_OP)!;
    expect(copilot.parentSpanId).toBe(stageRun.spanId); // TRUE nesting (OBS-12), not co-keyed siblings
    expect(copilot.stage).toBe('decompose'); // inherited from the parent
    expect(copilot.itemId).toBe('SRC1'); // inherited (OBS-16)
    expect(copilot.outcome).toBe('ok');
  });

  it('a failed Copilot call ends the span `error` and the decider still throws (OBS-13)', async () => {
    root = await makeTempDir('kb-obs-');
    const tracer = createTracer({ dir: root });
    const decide = makeDecomposeDecider({ available: true, run: async () => 'not json' });

    const span = tracer.start(STAGE_RUN_OP, { stage: 'decompose', itemId: 'SRC2' });
    await expect(decide(input({ sourceId: 'SRC2' }), { span })).rejects.toThrow();
    span.end('error');
    await tracer.flush();

    const copilot = (await readSpans(root)).find((s) => s.op === COPILOT_OP)!;
    expect(copilot.outcome).toBe('error'); // failed calls are timed too, not lost
  });

  it('emitted spans feed the perf index (OBS-14 end-to-end)', async () => {
    root = await makeTempDir('kb-obs-');
    // The tracer writes to <root>/.kb/cache/spans.jsonl so buildPerfIndex(root) reads it.
    const tracer = createTracer({ dir: path.join(root, '.kb', 'cache') });

    for (const id of ['SRC1', 'SRC2']) {
      const decide = makeDecomposeDecider({
        available: true,
        run: async () => `{"sourceId":"${id}","entities":[{"kind":"person","name":"Steve","confidence":0.9,"mentions":["call Steve"]}]}`,
      });
      const span = tracer.start(STAGE_RUN_OP, { stage: 'decompose', itemId: id });
      await decide(input({ sourceId: id }), { span });
      span.end('ok');
    }
    await tracer.flush();

    const idx = await buildPerfIndex(root);
    expect(idx.copilot.count).toBe(2); // both decider calls timed as copilot spans
    expect(idx.stages.find((s) => s.stage === 'decompose')?.runs).toBe(2);
    expect(idx.whereTimeGoes.totalMs).toBeGreaterThanOrEqual(0);
  });
});
