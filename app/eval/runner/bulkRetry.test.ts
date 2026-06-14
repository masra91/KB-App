// SPEC-0049 HEAL-7 — deterministic CI coverage for the bulk-retry harness's pure machinery (no copilot):
// the set-aside scanner (epoch-scoped), the partial-replay re-enqueue (the readers must re-queue a reset
// source), and the report math. The live drive (real deciders + self-repair) is exercised by the opt-in
// bulkRetry.eval.ts; this guards the logic the report's correctness hinges on.
import { describe, it, expect, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { makeTempDir, rmTempDir } from '../../test/tempVault';
import { readDecomposeQueue } from '../../src/kb/decomposeStage';
import { replayResetLine } from '../../src/kb/replayEpoch';
import { findSetAsideSources, reEnqueueSetAside, computeBulkRetryReport, formatBulkRetryReport } from './bulkRetry';
import type { VaultSnapshot } from './snapshot';

const tmpDirs: string[] = [];
afterEach(async () => {
  await Promise.all(tmpDirs.splice(0).map(rmTempDir));
});

/** Write a synthetic archived source dir (`sources/<id>/source.md` + `audit.jsonl`) under `root`. */
async function writeSource(root: string, id: string, auditLines: string[]): Promise<string> {
  const dir = path.join(root, 'sources', id);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'source.md'), `# ${id}\n`, 'utf8');
  await fs.writeFile(path.join(dir, 'audit.jsonl'), auditLines.map((l) => l + '\n').join(''), 'utf8');
  return dir;
}

const line = (event: string, stage = 'decompose') => JSON.stringify({ ts: '2026-01-01T00:00:00.000Z', stage, event });

async function vaultWith(sources: Record<string, string[]>): Promise<string> {
  const root = await makeTempDir('kb-bulkretry-test-');
  tmpDirs.push(root);
  for (const [id, lines] of Object.entries(sources)) await writeSource(root, id, lines);
  return root;
}

function snap(over: Partial<VaultSnapshot> = {}): VaultSnapshot {
  return { root: '/v', entities: [], claims: [], sources: [], outputs: [], recall: null, audit: [], spans: [], devLog: [], ...over };
}
const span = (over: Record<string, unknown> = {}) => ({ spanId: '1', op: 'stage.run', stage: 'decompose', startTs: 't0', endTs: 't1', durationMs: 1, outcome: 'ok', ...over }) as VaultSnapshot['spans'][number];

describe('findSetAsideSources (the toss population)', () => {
  it('counts a terminally set-aside source (setaside, no success) and skips a decomposed one', async () => {
    const root = await vaultWith({
      'aside-1': [line('failed'), line('failed'), line('failed'), line('setaside')],
      'ok-1': [line('decomposed')],
    });
    const found = await findSetAsideSources(root);
    expect(found.map((s) => path.basename(s.dir))).toEqual(['aside-1']);
    expect(found[0].stages).toEqual(['decompose']);
  });

  it('honors the replay epoch: a setaside SUPERSEDED by a later reset is no longer set aside', async () => {
    const root = await vaultWith({
      // set aside, then reset (epoch marker) with nothing after → re-derivable, NOT a residual toss
      'reset-clean': [line('setaside'), replayResetLine('epoch-2', '2026-01-02T00:00:00.000Z').trim()],
      // set aside, reset, then set aside AGAIN in the new epoch → still a toss
      'reset-aside': [line('setaside'), replayResetLine('epoch-2', '2026-01-02T00:00:00.000Z').trim(), line('setaside')],
    });
    const found = await findSetAsideSources(root);
    expect(found.map((s) => path.basename(s.dir))).toEqual(['reset-aside']);
  });

  it('does not count a source that was set aside then succeeded in the same epoch', async () => {
    const root = await vaultWith({ 'aside-then-ok': [line('setaside'), line('decomposed')] });
    expect(await findSetAsideSources(root)).toEqual([]);
  });
});

describe('reEnqueueSetAside (partial replay re-enqueue)', () => {
  it('a set-aside source is EXCLUDED from the decompose queue until re-enqueued, then INCLUDED', async () => {
    const root = await vaultWith({ 'aside-1': [line('failed'), line('failed'), line('failed'), line('setaside')] });
    const dir = path.join(root, 'sources', 'aside-1');

    // before: terminal setaside → not in the queue
    expect(await readDecomposeQueue(root)).not.toContain(path.relative(root, dir));

    const n = await reEnqueueSetAside(root, [dir], { replayId: 'epoch-9' });
    expect(n).toBe(1);

    // after: the epoch marker supersedes the old terminal → the source re-enters the queue
    expect(await readDecomposeQueue(root)).toContain(path.relative(root, dir));
  });

  it('shares one epoch across the batch and appends (non-destructive — history preserved)', async () => {
    const root = await vaultWith({ a: [line('setaside')], b: [line('setaside')] });
    const dirs = ['a', 'b'].map((id) => path.join(root, 'sources', id));
    await reEnqueueSetAside(root, dirs, { replayId: 'epoch-X', ts: '2026-02-02T00:00:00.000Z' });
    for (const d of dirs) {
      const raw = await fs.readFile(path.join(d, 'audit.jsonl'), 'utf8');
      expect(raw).toContain('"event":"setaside"'); // original line still there (append-only)
      expect(raw).toContain('"replayId":"epoch-X"'); // + the shared epoch marker
    }
  });
});

describe('computeBulkRetryReport (the residual math)', () => {
  const sa = (id: string) => ({ dir: `/v/sources/${id}`, stages: ['decompose'] });

  it('derives converged / residual / toss-rate-after + the span cross-check', () => {
    const before = [sa('a'), sa('b'), sa('c')]; // 3 tossed
    const after = [sa('c')]; // 1 still tossed → 2 converged
    const s = snap({ spans: [span({ spanId: '1', outcome: 'ok' }), span({ spanId: '2', outcome: 'ok' }), span({ spanId: '3', outcome: 'setaside' })] });
    const r = computeBulkRetryReport({ before, after, snap: s, replayId: 'e1', model: 'claude-opus-4.8' });
    expect(r).toMatchObject({ beforeSetAside: 3, reEnqueued: 3, converged: 2, residualSetAside: 1, model: 'claude-opus-4.8', replayId: 'e1' });
    expect(r.tossRateAfter).toBeCloseTo(1 / 3);
    expect(r.spanSetAsideRate).toBeCloseTo(1 / 3);
  });

  it('the success case: every set-aside converged → residual 0, toss-rate 0', () => {
    const r = computeBulkRetryReport({
      before: [sa('a'), sa('b')],
      after: [],
      snap: snap({ spans: [span({ spanId: '1', outcome: 'ok' }), span({ spanId: '2', outcome: 'ok' })] }),
      replayId: 'e1',
      model: 'm',
    });
    expect(r.residualSetAside).toBe(0);
    expect(r.tossRateAfter).toBe(0);
    expect(r.spanSetAsideRate).toBe(0);
    expect(formatBulkRetryReport(r)).toContain('toss-rate → 0');
  });

  it('null span cross-check when no decompose stage-run spans were recorded', () => {
    const r = computeBulkRetryReport({ before: [sa('a')], after: [sa('a')], snap: snap({ spans: [] }), replayId: 'e1', model: 'm' });
    expect(r.spanSetAsideRate).toBeNull();
    expect(r.tossRateAfter).toBe(1);
  });
});
