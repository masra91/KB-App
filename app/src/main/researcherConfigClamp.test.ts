// WS3 hardening (RESEARCH-15/18, security boundary RESEARCH-10/11): the END-TO-END clamp-WIRING test.
// `clampToolCalls`/`clampTimeoutMs` are unit-tested in researchers.test.ts, and the IPC-forward is tested
// (mocked) in ipc.test.ts — but nothing asserted that `setActiveResearcherConfig` ACTUALLY APPLIES the
// clamp on the real wired path: a runaway UI value persisting CLAMPED to the per-Instance ceiling. A
// mis-wire (clamp dropped from the pipeline fn) would pass both existing tests yet let a `9999` reads/pass
// reach the registry — exactly the "bug hides between two separately-tested pieces" case (test-the-real-
// wired-path). This drives the genuine pipeline fn against a real staging worktree + registry + git commit;
// only the heavy stage/scheduler constructors are stubbed (we never run cognition here).
//
// Fails-before/passes-after (the CLASS): if `clampToolCalls`/`clampTimeoutMs` were removed from
// `setActiveResearcherConfig`, the `9999 → ceiling` / `99h → 60min` assertions below fail.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { makeTempDir, rmTempDir } from '../../test/tempVault';

// Stub only the heavy stage/scheduler constructors (we just need `.start()`/`.stop()` no-ops) — the
// registry read/write + the canonical-writer git commit run for real. boundedGit stays REAL (the commit
// path); only the boot reap is stubbed.
const h = vi.hoisted(() => {
  class StubStage {
    start(): void {}
    stop(): void {}
    poke(): void {}
  }
  class StubWatch {
    start(): void {}
    stop(): void {}
    async refresh(): Promise<void> {}
    watchingIds(): Set<string> {
      return new Set();
    }
  }
  return { reap: vi.fn(async () => ({ worktrees: 0, branches: 0 })), StubStage, StubWatch };
});
vi.mock('../kb/canonicalAdvance', async (orig) => ({ ...(await orig<typeof import('../kb/canonicalAdvance')>()), reapEphemeralWorktrees: h.reap }));
vi.mock('../kb/orchestrator', async (orig) => ({ ...(await orig<typeof import('../kb/orchestrator')>()), Orchestrator: h.StubStage }));
vi.mock('../kb/decomposeStage', async (orig) => ({ ...(await orig<typeof import('../kb/decomposeStage')>()), DecomposeStage: h.StubStage }));
vi.mock('../kb/connectStage', async (orig) => ({ ...(await orig<typeof import('../kb/connectStage')>()), ConnectStage: h.StubStage }));
vi.mock('../kb/claimsStage', async (orig) => ({ ...(await orig<typeof import('../kb/claimsStage')>()), ClaimsStage: h.StubStage }));
vi.mock('../kb/jobScheduler', async (orig) => ({ ...(await orig<typeof import('../kb/jobScheduler')>()), JobScheduler: h.StubStage }));
vi.mock('../kb/researcherScheduler', async (orig) => ({ ...(await orig<typeof import('../kb/researcherScheduler')>()), ResearcherScheduler: h.StubStage }));
vi.mock('../kb/intakeScheduler', async (orig) => ({ ...(await orig<typeof import('../kb/intakeScheduler')>()), IntakeScheduler: h.StubStage }));
vi.mock('../kb/watchScheduler', async (orig) => ({ ...(await orig<typeof import('../kb/watchScheduler')>()), WatchScheduler: h.StubWatch }));

import { createKb } from '../kb/vault';
import { ensureStagingWorktree } from '../kb/stagingWorktree';
import { writeResearcherRegistry, readResearcherRegistry } from '../kb/researcherRegistry';
import { MAX_TOOL_CALLS, MAX_SESSION_TIMEOUT_MS, MAX_MAX_DEPTH, MAX_ORIENT_BUDGET, type ResearcherConfig } from '../kb/researchers';
import { startPipeline, setActiveResearcherConfig, stopPipeline } from './pipeline';

const seed: ResearcherConfig = {
  id: 'web-1',
  template: 'web',
  prompt: 'find prior art',
  egressTier: 'public-web',
  scope: 'global',
  budget: { maxToolCalls: 8, maxDepth: 2 },
  schedule: 'off',
  posture: 'guarded',
  enabled: false,
};

let vault: string | null = null;

afterEach(async () => {
  stopPipeline();
  if (vault) await rmTempDir(vault);
  vault = null;
  vi.clearAllMocks();
});

/** Open a fresh KB with `seed` already registered, and activate the pipeline. Returns the staging root. */
async function openWithSeededResearcher(): Promise<string> {
  vault = await makeTempDir('kb-ws3-clamp-');
  await createKb({ path: vault, initGitIfNeeded: true });
  const staging = await ensureStagingWorktree(vault);
  await writeResearcherRegistry(staging, [seed]);
  await startPipeline(vault); // sets `active` (heavy stages stubbed); active.stagingWt === staging
  return staging;
}

async function persistedResearcher(staging: string): Promise<ResearcherConfig> {
  const r = (await readResearcherRegistry(staging)).find((x) => x.id === 'web-1');
  if (!r) throw new Error('seeded researcher vanished');
  return r;
}

describe('setActiveResearcherConfig — end-to-end clamp wiring (WS3 / RESEARCH-10/11 ceiling invariant)', () => {
  it('CLAMPS a runaway maxToolCalls to the per-Instance ceiling on persist (9999 → 100)', async () => {
    const staging = await openWithSeededResearcher();
    await setActiveResearcherConfig({ id: 'web-1', maxToolCalls: 9999 });
    expect((await persistedResearcher(staging)).budget.maxToolCalls).toBe(MAX_TOOL_CALLS); // 100, NOT 9999
  });

  it('CLAMPS a runaway timeout to the 60-min ceiling on persist (99h → 60min)', async () => {
    const staging = await openWithSeededResearcher();
    await setActiveResearcherConfig({ id: 'web-1', timeoutMs: 99 * 60 * 60_000 });
    expect((await persistedResearcher(staging)).timeoutMs).toBe(MAX_SESSION_TIMEOUT_MS); // 60min cap
  });

  it('persists a valid in-range maxToolCalls unchanged (42 → 42), preserving the unset maxDepth', async () => {
    const staging = await openWithSeededResearcher();
    await setActiveResearcherConfig({ id: 'web-1', maxToolCalls: 42 });
    const r = await persistedResearcher(staging);
    expect(r.budget.maxToolCalls).toBe(42);
    expect(r.budget.maxDepth).toBe(2); // maxDepth NOT in this patch → preserved from the seed
  });

  it('REJECTS a garbage maxToolCalls (leaves the field unchanged — fail-safe, never bypasses the gate)', async () => {
    const staging = await openWithSeededResearcher();
    await setActiveResearcherConfig({ id: 'web-1', maxToolCalls: -5 });
    expect((await persistedResearcher(staging)).budget.maxToolCalls).toBe(8); // unchanged from the seed
  });

  // WS3 Slice-2: maxDepth editable — the #245-lesson end-to-end clamp-wiring proof on the real path.
  it('CLAMPS a runaway maxDepth to the chain-depth cap on persist (99 → 10), preserving maxToolCalls', async () => {
    const staging = await openWithSeededResearcher();
    await setActiveResearcherConfig({ id: 'web-1', maxDepth: 99 });
    const r = await persistedResearcher(staging);
    expect(r.budget.maxDepth).toBe(MAX_MAX_DEPTH); // 10, NOT 99
    expect(r.budget.maxToolCalls).toBe(8); // the other budget field is preserved through the merge
  });

  it('persists a valid in-range maxDepth (4 → 4) and REJECTS a garbage maxDepth (fail-safe, unchanged)', async () => {
    const staging = await openWithSeededResearcher();
    await setActiveResearcherConfig({ id: 'web-1', maxDepth: 4 });
    expect((await persistedResearcher(staging)).budget.maxDepth).toBe(4);
    await setActiveResearcherConfig({ id: 'web-1', maxDepth: -1 });
    expect((await persistedResearcher(staging)).budget.maxDepth).toBe(4); // garbage dropped → unchanged
  });

  // Warm-start (RESEARCH-22): orientBudget editable — the #245-lesson end-to-end clamp-wiring + persist-on-read.
  it('CLAMPS a runaway orientBudget to the cap on persist (99 → 20) and it SURVIVES a re-read', async () => {
    const staging = await openWithSeededResearcher();
    await setActiveResearcherConfig({ id: 'web-1', orientBudget: 99 });
    expect((await persistedResearcher(staging)).orientBudget).toBe(MAX_ORIENT_BUDGET); // 20, NOT 99 — and read back (no #245 drop)
  });

  it('persists a valid in-range orientBudget (8 → 8) and REJECTS a garbage one (fail-safe, unchanged)', async () => {
    const staging = await openWithSeededResearcher();
    await setActiveResearcherConfig({ id: 'web-1', orientBudget: 8 });
    expect((await persistedResearcher(staging)).orientBudget).toBe(8);
    await setActiveResearcherConfig({ id: 'web-1', orientBudget: -1 });
    expect((await persistedResearcher(staging)).orientBudget).toBe(8); // garbage dropped → unchanged
  });
});
