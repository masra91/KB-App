// Regression (#205 follow-up): startup must make the Jobs/read IPC live BEFORE the boot-time
// `reapEphemeralWorktrees` cleanup runs — never after it.
//
// The reap removes leaked `<stage>-<ULID>` worktrees + `kb/*-work-*` branches one git-spawn at a
// time, so its cost is O(leaked-N): on a vault with a crash-leak backlog it takes seconds. It used
// to be `await`ed BEFORE `active` was set, so `listJobs` (and every read IPC) returned empty until
// the whole reap finished — the Jobs view sat on "Loading…"/"No jobs" for the full reap. The fix
// sets `active` first (read path live in ~100ms) and runs the reap after, still before the live
// stages start (so a fresh stage can't race the sweep). This pins that ordering: at the instant the
// reap runs, `listJobsForActive()` already returns the job catalog (active is set).
//
// The heavy stage/orchestrator/scheduler constructors are stubbed (we only need their `.start()`
// no-ops for startActiveStages); the real job read-path (registry/journal/catalog) runs against a
// temp staging dir and degrades to the catalog when empty — exactly what a freshly-opened vault sees.
import { describe, it, expect, vi } from 'vitest';
import { makeTempDir } from '../../test/tempVault';

const h = vi.hoisted(() => {
  // Heavy collaborators' constructors are stubbed — startActiveStages just calls `.start()` on each.
  class StubStage {
    start(): void {}
    stop(): void {}
  }
  return { reap: vi.fn(async () => ({ worktrees: 0, branches: 0 })), StubStage };
});

// Make the boot reap observable + controllable; keep every other canonicalAdvance export real.
vi.mock('../kb/canonicalAdvance', async (orig) => ({
  ...(await orig<typeof import('../kb/canonicalAdvance')>()),
  reapEphemeralWorktrees: h.reap,
}));

vi.mock('../kb/orchestrator', async (orig) => ({ ...(await orig<typeof import('../kb/orchestrator')>()), Orchestrator: h.StubStage }));
vi.mock('../kb/decomposeStage', async (orig) => ({ ...(await orig<typeof import('../kb/decomposeStage')>()), DecomposeStage: h.StubStage }));
vi.mock('../kb/connectStage', async (orig) => ({ ...(await orig<typeof import('../kb/connectStage')>()), ConnectStage: h.StubStage }));
vi.mock('../kb/claimsStage', async (orig) => ({ ...(await orig<typeof import('../kb/claimsStage')>()), ClaimsStage: h.StubStage }));
vi.mock('../kb/jobScheduler', async (orig) => ({ ...(await orig<typeof import('../kb/jobScheduler')>()), JobScheduler: h.StubStage }));
vi.mock('../kb/researcherScheduler', async (orig) => ({ ...(await orig<typeof import('../kb/researcherScheduler')>()), ResearcherScheduler: h.StubStage }));

import { startPipeline, listJobsForActive } from './pipeline';
import { ensureStagingWorktree } from '../kb/stagingWorktree';

vi.mock('../kb/stagingWorktree', async (orig) => ({
  ...(await orig<typeof import('../kb/stagingWorktree')>()),
  ensureStagingWorktree: vi.fn(),
}));

describe('startPipeline startup ordering (#205 regression)', () => {
  it('makes the Jobs read-path live before the boot-time worktree reap runs', async () => {
    const vault = await makeTempDir();
    const staging = await makeTempDir();
    vi.mocked(ensureStagingWorktree).mockResolvedValue(staging);

    // Capture the Jobs read-path state at the exact moment the reap is invoked.
    let jobsWhenReapRan: Awaited<ReturnType<typeof listJobsForActive>> | null = null;
    h.reap.mockImplementation(async () => {
      jobsWhenReapRan = await listJobsForActive();
      return { worktrees: 0, branches: 0 };
    });

    await startPipeline(vault);

    expect(h.reap).toHaveBeenCalledTimes(1); // the reap still runs at startup
    expect(jobsWhenReapRan).not.toBeNull(); // …and it ran
    // The invariant: active was already set when the reap ran, so the read-path returns the job
    // catalog (non-empty) — not the `!active → []` empty list that stranded the Jobs view before.
    expect((jobsWhenReapRan ?? []).length).toBeGreaterThan(0);
  });
});
