// REGRESSION (#256 / ORCH-26) — a wedged canonical writer must NOT make Decompose retry a source
// FOREVER. The packaged app crashed (V8 worker SIGTRAP / heap exhaustion) after ~2h; the crash-window
// pipeline.log showed a `decompose.failed` cascade + recurring `lock.stuck`. Root cause (confirmed):
// when the shared canonical writer is wedged (e.g. a timed-out boundedGit op leaves a stale root
// `.git/index.lock`, #163), every canonical advance throws → the `failed` marker never reaches
// canonical → the audit-derived `failures` count never advances → the source never sets aside →
// it is re-decomposed (re-emitting OBS spans) on every 30s sweep, forever.
//
// ORCH-26 fixes this by accounting attempts in a DURABLE working-zone ledger that does NOT depend on
// the canonical write: set-aside fires after maxAttempts (PRIMARY) or a resource-independent
// wall-clock ceiling (BACKSTOP), regardless of marker state. (Spans-rotation + tail-bounded readSpans
// — the OOM amplifier — are guarded in tracing.test.ts / perfIndex.test.ts.)
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { makeTempDir, rmTempDir } from '../../test/tempVault';
import { createKb } from './vault';
import { captureToInbox } from './ingest';
import { archiveOne, readQueue } from './orchestrator';
import { deterministicDecider } from './archivist';
import { Mutex } from './stageLock';
import { decomposeOne, readDecomposeQueue, DEFAULT_MAX_ATTEMPTS, DEFAULT_ATTEMPT_CEILING_MS } from './decomposeStage';
import type { DecomposeDecider } from './decomposeAgent';

function gitAvailable(): boolean {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

// A Mutex whose every critical section throws — simulates a WEDGED canonical writer (#163): a
// timed-out boundedGit op leaving a stale root `.git/index.lock` so no canonical advance ever lands.
class WedgedMutex extends Mutex {
  run<T>(_fn: () => Promise<T>, label?: string): Promise<T> {
    return super.run(async (): Promise<T> => {
      throw new Error('canonical writer wedged (simulated)');
    }, label);
  }
}

const oneEntityDecider: DecomposeDecider = async (input) => ({
  sourceId: input.sourceId,
  entities: [{ kind: 'person', name: 'Steve', confidence: 0.8, mentions: ['Steve'] }],
  agent: { via: 'copilot', model: 'test' },
});

async function archiveOneSource(root: string): Promise<string> {
  await captureToInbox(root, 'in-app-panel', [{ kind: 'text', text: 'call Steve re Q3 budget' }]);
  const q = await readQueue(root);
  return archiveOne(root, q[q.length - 1], deterministicDecider); // archive uses its own, un-wedged lock
}

describe.skipIf(!gitAvailable())('crash #256 / ORCH-26 — durable attempt accounting survives a wedged writer', () => {
  it('sets the source aside after maxAttempts even when the canonical writer is wedged (PRIMARY)', async () => {
    const dir = await makeTempDir();
    try {
      const root = path.join(dir, 'vault');
      await createKb({ path: root, initGitIfNeeded: true });
      const srcRel = await archiveOneSource(root);

      const wedged = new WedgedMutex();
      // Each attempt records in the DURABLE ledger before the wedged advance throws (no canonical
      // `failed` marker is ever written). After maxAttempts the ledger must set the source aside.
      for (let i = 0; i < DEFAULT_MAX_ATTEMPTS; i++) {
        await decomposeOne(root, srcRel, oneEntityDecider, wedged, DEFAULT_MAX_ATTEMPTS).catch(() => {});
      }

      // ORCH-26: queue is empty — set aside via the durable ledger despite the wedged writer.
      // FAILS-BEFORE: without the ledger, readDecomposeQueue still lists the source (retry-forever).
      expect(await readDecomposeQueue(root, DEFAULT_MAX_ATTEMPTS)).toHaveLength(0);
    } finally {
      await rmTempDir(dir);
    }
  });

  it('sets the source aside via the wall-clock ceiling even under the attempt cap (BACKSTOP)', async () => {
    const dir = await makeTempDir();
    try {
      const root = path.join(dir, 'vault');
      await createKb({ path: root, initGitIfNeeded: true });
      const srcRel = await archiveOneSource(root);

      // ONE wedged attempt — records attempts=1 (< cap) at ~now.
      await decomposeOne(root, srcRel, oneEntityDecider, new WedgedMutex(), DEFAULT_MAX_ATTEMPTS).catch(() => {});

      // Still queued now (1 attempt < cap, fresh).
      expect((await readDecomposeQueue(root, DEFAULT_MAX_ATTEMPTS)).length).toBeGreaterThan(0);
      // Far past the wall-clock ceiling → set aside even though attempts is under the cap.
      const future = Date.now() + DEFAULT_ATTEMPT_CEILING_MS + 1;
      expect(await readDecomposeQueue(root, DEFAULT_MAX_ATTEMPTS, future)).toHaveLength(0);
    } finally {
      await rmTempDir(dir);
    }
  });

  it('a clean decompose clears the durable record (no false set-aside on a healthy writer)', async () => {
    const dir = await makeTempDir();
    try {
      const root = path.join(dir, 'vault');
      await createKb({ path: root, initGitIfNeeded: true });
      const srcRel = await archiveOneSource(root);

      // Healthy writer (its own lock) → success → the durable record is cleared and the source
      // dequeues normally via the terminal `decomposed` marker (no lingering ledger entry).
      const res = await decomposeOne(root, srcRel, oneEntityDecider);
      expect(res.ok).toBe(true);
      expect(await readDecomposeQueue(root, DEFAULT_MAX_ATTEMPTS)).toHaveLength(0);
    } finally {
      await rmTempDir(dir);
    }
  });
});
