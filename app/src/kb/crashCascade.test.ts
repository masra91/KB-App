// REGRESSION (#256) — a wedged canonical writer must NOT spin a stage forever. The packaged app
// crashed (V8 worker SIGTRAP / heap exhaustion) after ~2h: the crash-window pipeline.log showed a
// `decompose.failed` cascade + recurring `lock.stuck`. Root cause (confirmed): when the shared
// canonical writer is wedged (e.g. a timed-out boundedGit op leaves a stale root `.git/index.lock`,
// #163), every canonical advance throws → the failed-attempt marker never reaches canonical → the
// set-aside cap (`failures >= maxAttempts`) is never reached → the stage re-runs cognition + emits
// OBS spans on every 30s sweep, forever. The never-rotated spans.jsonl (bounded separately, see
// tracing.test.ts) the status poll fully re-read then drove the heap to OOM.
//
// This guards the stage circuit-breaker: a drain that errors out (wedged writer) backs the stage
// off (exponential, capped) instead of retrying every poke; a clean drain resets it. The queued
// items are NOT set aside — they are recoverable and resume once the writer heals.
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { makeTempDir, rmTempDir } from '../../test/tempVault';
import { createKb } from './vault';
import { captureToInbox } from './ingest';
import { archiveOne, readQueue } from './orchestrator';
import { deterministicDecider } from './archivist';
import { Mutex } from './stageLock';
import { DecomposeStage, readDecomposeQueue } from './decomposeStage';
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

describe.skipIf(!gitAvailable())('crash #256 — wedged-writer circuit-breaker', () => {
  it('DecomposeStage backs off on a wedged writer instead of re-draining every poke (no retry-forever spin)', async () => {
    const dir = await makeTempDir();
    try {
      const root = path.join(dir, 'vault');
      await createKb({ path: root, initGitIfNeeded: true });
      // One source in the decompose queue (archive uses its own, un-wedged lock).
      await captureToInbox(root, 'in-app-panel', [{ kind: 'text', text: 'call Steve re Q3 budget' }]);
      const q = await readQueue(root);
      await archiveOne(root, q[q.length - 1], deterministicDecider);

      // Count attempts: each drain that reaches an item calls the decider once (cognition).
      let deciderCalls = 0;
      const countingDecider: DecomposeDecider = async (input) => {
        deciderCalls += 1;
        return {
          sourceId: input.sourceId,
          entities: [{ kind: 'person', name: 'Steve', confidence: 0.8, mentions: ['Steve'] }],
          agent: { via: 'copilot', model: 'test' },
        };
      };

      // Deterministic clock so the backoff window is exact (base = default sweep 30s).
      let clock = 1_000_000;
      const nowMs = (): number => clock;
      const stage = new DecomposeStage(root, countingDecider, new WedgedMutex(), undefined, undefined, undefined, undefined, nowMs);

      // First drain: reaches the item (decider +1), the wedged advance throws → drain errors → backoff.
      await stage.poke();
      expect(deciderCalls).toBe(1);

      // Many more pokes at the SAME instant — all no-ops while backed off (the bug was: each re-drained).
      for (let i = 0; i < 10; i++) await stage.poke();
      expect(deciderCalls).toBe(1); // FAILS-BEFORE: without the circuit-breaker this is 11 (retry-forever)

      // Past the backoff window → the stage retries once (and would back off again, longer).
      clock += 30_000 + 1;
      await stage.poke();
      expect(deciderCalls).toBe(2);

      // The source is NOT discarded — still queued (recoverable; resumes when the writer heals).
      expect((await readDecomposeQueue(root)).length).toBeGreaterThan(0);
      stage.stop();
    } finally {
      await rmTempDir(dir);
    }
  });
});
