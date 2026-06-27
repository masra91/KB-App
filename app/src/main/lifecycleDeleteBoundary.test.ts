// PANEL-11 lifecycle delete — IPC-boundary proof (SPEC-0027). The end-to-end guarantee that deleting a
// user-added entity (researcher / intake feed) PURGES its config from the registry, AUDITS the removal,
// and RETAINS already-produced ground truth — sources/findings + the prior audit trail are NEVER touched
// (ground truth is sacred). Drives the genuine pipeline fns against a real staging worktree + registry +
// git commit; only the heavy stage/scheduler constructors are stubbed (no real chokidar/cognition).
import { describe, it, expect, vi, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

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
import { readResearcherRegistry } from '../kb/researcherRegistry';
import { readIntakeRegistry } from '../kb/intakeRegistry';
import { readEvents } from '../kb/activityIndex';
import { appendAuditEvent } from '../kb/audit';
import {
  startPipeline,
  stopPipeline,
  setActiveResearcherConfig,
  removeActiveResearcher,
  listResearchersForActive,
  setActiveIntakeConnectorConfig,
  removeActiveIntakeConnector,
  listIntakeConnectorsForActive,
} from './pipeline';

let dir: string | null = null;

afterEach(async () => {
  stopPipeline();
  if (dir) await fs.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  dir = null;
  vi.clearAllMocks();
});

// The pipeline fns read/write the registry + audit on the STAGING worktree, so assertions target staging.
async function openVault(): Promise<{ vault: string; staging: string }> {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'kb-lifecycle-del-'));
  const vault = path.join(dir, 'vault');
  await createKb({ path: vault, initGitIfNeeded: true });
  const staging = await ensureStagingWorktree(vault);
  await startPipeline(vault); // sets `active` (heavy stages + schedulers stubbed)
  return { vault, staging };
}

describe('removeActiveResearcher (PANEL-11) — purge config, RETAIN ground truth', () => {
  it('purges the researcher row + audits the removal, while its produced source + finding audit survive', async () => {
    const { staging } = await openVault();
    // Create a researcher, then simulate ground truth it produced: a source on disk + a `researched`
    // finding event in the audit trail (the lineage that must survive the delete).
    await setActiveResearcherConfig({ id: 'prior-art', template: 'web', egressTier: 'public-web', enabled: false });
    const srcDir = path.join(staging, 'sources', '2026-06-27', 'SRC-FINDING-1');
    await fs.mkdir(srcDir, { recursive: true });
    await fs.writeFile(path.join(srcDir, 'source.md'), '# A finding this researcher brought back\n', 'utf8');
    await appendAuditEvent(staging, {
      actor: 'researcher',
      eventType: 'researched',
      subjects: { researcherId: 'prior-art', sourceId: 'SRC-FINDING-1' },
      payload: { what: 'prior art', citations: ['https://example.com'] },
    });

    // (A default `web` researcher is auto-seeded on pipeline start; assert on OUR entity, not the whole list.)
    expect((await readResearcherRegistry(staging)).some((r) => r.id === 'prior-art')).toBe(true);

    const after = await removeActiveResearcher('prior-art');

    // Config purged (registration gone, not just disabled-forever).
    expect(after.find((r) => r.id === 'prior-art')).toBeUndefined();
    expect((await readResearcherRegistry(staging)).some((r) => r.id === 'prior-art')).toBe(false);

    // Ground truth RETAINED: the produced source file is untouched...
    await expect(fs.access(path.join(srcDir, 'source.md'))).resolves.toBeUndefined();
    // ...and the audit trail still holds BOTH the prior finding AND a new `removed: true` removal event.
    const events = await readEvents(staging, {});
    const finding = events.find((e) => e.eventType === 'researched' && e.subjects.researcherId === 'prior-art');
    expect(finding).toBeDefined();
    expect(finding!.subjects.sourceId).toBe('SRC-FINDING-1');
    const removal = events.find((e) => e.eventType === 'researcher-config-change' && e.subjects.researcherId === 'prior-art' && e.payload.removed === true);
    expect(removal).toBeDefined();
    expect(removal!.actor).toBe('panel');
  });

  it('is a no-op for an absent id (no removal audit emitted)', async () => {
    const { staging } = await openVault();
    await setActiveResearcherConfig({ id: 'keep', template: 'web', enabled: false });
    await removeActiveResearcher('ghost');
    expect((await listResearchersForActive()).some((r) => r.id === 'keep')).toBe(true);
    const removals = (await readEvents(staging, {})).filter((e) => e.eventType === 'researcher-config-change' && e.payload.removed === true);
    expect(removals.length).toBe(0); // absent id → nothing purged, nothing audited
  });

  it('rejects an unsafe id without touching the registry (path-injection guard)', async () => {
    const { staging } = await openVault();
    await setActiveResearcherConfig({ id: 'keep', template: 'web', enabled: false });
    await removeActiveResearcher('../escape'); // guarded no-op (returns the list, never deletes)
    expect((await readResearcherRegistry(staging)).some((r) => r.id === 'keep')).toBe(true);
  });
});

describe('removeActiveIntakeConnector (PANEL-11) — purge config, RETAIN ground truth', () => {
  it('purges the feed row + audits the removal, while its produced source + pull audit survive', async () => {
    const { staging } = await openVault();
    await setActiveIntakeConnectorConfig({ id: 'hn', type: 'rss', feedUrl: 'https://news.example.com/feed.xml', enabled: false });
    const srcDir = path.join(staging, 'sources', '2026-06-27', 'SRC-INTOOK-1');
    await fs.mkdir(srcDir, { recursive: true });
    await fs.writeFile(path.join(srcDir, 'source.md'), '# An item this feed brought in\n', 'utf8');
    await appendAuditEvent(staging, {
      actor: 'intake',
      eventType: 'intook',
      subjects: { intakeId: 'hn', sourceId: 'SRC-INTOOK-1' },
      payload: { count: 1 },
    });

    expect((await readIntakeRegistry(staging)).map((c) => c.id)).toEqual(['hn']);

    const after = await removeActiveIntakeConnector('hn');

    expect(after.find((c) => c.id === 'hn')).toBeUndefined();
    expect((await readIntakeRegistry(staging)).length).toBe(0);

    await expect(fs.access(path.join(srcDir, 'source.md'))).resolves.toBeUndefined();
    const events = await readEvents(staging, {});
    expect(events.find((e) => e.eventType === 'intook' && e.subjects.intakeId === 'hn')).toBeDefined();
    const removal = events.find((e) => e.eventType === 'intake-config-change' && e.subjects.intakeId === 'hn' && e.payload.removed === true);
    expect(removal).toBeDefined();
    expect(removal!.actor).toBe('panel');
  });

  it('is a no-op for an absent id', async () => {
    await openVault();
    await setActiveIntakeConnectorConfig({ id: 'keep', type: 'rss', enabled: false });
    await removeActiveIntakeConnector('ghost');
    expect((await listIntakeConnectorsForActive()).map((c) => c.id)).toEqual(['keep']);
  });
});
