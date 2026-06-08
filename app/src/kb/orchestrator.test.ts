// Orchestration engine tests (SPEC-0014 ORCH-2/3/4/6/11/12/13; SPEC-0013 CAPTURE-9).
// Real FS + real git + real worktrees against a throwaway temp vault (TEST-18). Skips if
// git is absent.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import simpleGit from 'simple-git';
import { createKb } from './vault';
import { captureToInbox, readCapturedMeta } from './ingest';
import { Orchestrator, archiveOne, readQueue, readStatus } from './orchestrator';
import { makeCopilotDecider } from './copilotAgent';
import { dateShard } from './ulid';
import { setSensitivityOverride } from './sensitivityOverride';
import { makeTempDir, rmTempDir, pathExists } from '../../test/tempVault';

function gitInstalledSync(): boolean {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}
const gitAvailable = gitInstalledSync();

describe.skipIf(!gitAvailable)('Orchestration engine (SPEC-0014)', () => {
  let dir: string;
  let vault: string;
  beforeEach(async () => {
    dir = await makeTempDir();
    vault = path.join(dir, 'vault');
    await createKb({ path: vault, initGitIfNeeded: true });
  });
  afterEach(async () => {
    await rmTempDir(dir);
  });

  it('readQueue is empty for a fresh vault', async () => {
    expect(await readQueue(vault)).toEqual([]);
  });

  it('ORCH-3/4 + CAPTURE-9: archiveOne moves a unit into date-sharded sources/ with source.md, committed; root clean', async () => {
    const { ids } = await captureToInbox(vault, 'in-app-panel', [{ kind: 'text', text: 'call Steve re: Q3 budget' }]);
    const id = ids[0];

    const destRel = await archiveOne(vault, id);
    expect(destRel).toBe(path.join('sources', dateShard(id), id));

    const dest = path.join(vault, destRel);
    expect(await fs.readFile(path.join(dest, 'raw.md'), 'utf8')).toBe('call Steve re: Q3 budget');
    const sourceMd = await fs.readFile(path.join(dest, 'source.md'), 'utf8');
    expect(sourceMd).toContain('class: primary');
    expect(sourceMd).toContain('surface: in-app-panel');
    // SENSE-1/2/8 (real path): an un-signalled Principal capture lands at the conservative `internal`
    // default with `by: default` provenance — the label is now real frontmatter, not a hardcoded constant.
    expect(sourceMd).toContain('sensitivity: internal');
    expect(sourceMd).toContain('sensitivityMeta:');
    expect(sourceMd).toContain('  by: default');
    expect(sourceMd.trimEnd().endsWith('call Steve re: Q3 budget')).toBe(true);

    // The inbox unit is gone; the canonical root tree is clean and advanced by a commit.
    expect(await pathExists(path.join(vault, 'inbox', id))).toBe(false);
    const git = simpleGit(vault);
    expect((await git.status()).isClean()).toBe(true);
    expect((await git.log()).latest?.message).toBe(`archive: ${id}`);

    // ORCH-11: the unit carries both a captured and an archived audit event.
    const audit = await fs.readFile(path.join(dest, 'audit.jsonl'), 'utf8');
    const actions = audit.trim().split('\n').map((l) => JSON.parse(l).action);
    expect(actions).toEqual(['captured', 'archived']);
  });

  it('SENSE-5 (real path): a connector-declared sensitivity rides capture → archive into source.md as `by: connector`', async () => {
    // A connector (e.g. an intake feed marked `confidential`) declares its default at capture; that
    // high-confidence signal must survive to the archived source.md, NOT be down-classified to internal.
    const { ids } = await captureToInbox(vault, 'intake:work-mail', [{ kind: 'text', text: 'embargoed deal terms' }], Date.now(), { origin: 'external', sensitivity: 'confidential' });
    const destRel = await archiveOne(vault, ids[0]);
    const sourceMd = await fs.readFile(path.join(vault, destRel, 'source.md'), 'utf8');
    expect(sourceMd).toContain('sensitivity: confidential');
    expect(sourceMd).toContain('  by: connector');

    // SENSE-8: the classification is an audited event recording the signal provenance (by + label).
    const audit = await fs.readFile(path.join(vault, destRel, 'audit.jsonl'), 'utf8');
    const archived = audit.trim().split('\n').map((l) => JSON.parse(l)).find((e) => e.action === 'archived');
    expect(archived.decision.sensitivity).toBe('confidential');
    expect(archived.decision.sensitivityBy).toBe('connector');
  });

  it('SENSE-7 (real path, Replay-sticky): a Principal override wins over the classifier/default at archive — `by: principal`', async () => {
    // Capture (default would be `internal`), then the Principal sets an override BEFORE archive and commits
    // it. archiveOne reads the override from the worktree snapshot — exactly what makes it survive Replay —
    // and re-applies it OVER the decider, so the classifier never overwrites a `by: principal` label.
    const { ids } = await captureToInbox(vault, 'in-app-panel', [{ kind: 'text', text: 'put this in the external deck' }]);
    const id = ids[0];
    await setSensitivityOverride(vault, id, 'shareable', '2026-06-08T09:00:00.000Z');
    const git = simpleGit(vault);
    await git.raw('add', '.kb');
    await git.commit('principal override');

    const destRel = await archiveOne(vault, id);
    const sourceMd = await fs.readFile(path.join(vault, destRel, 'source.md'), 'utf8');
    expect(sourceMd).toContain('sensitivity: shareable'); // override beat the conservative `internal` default
    expect(sourceMd).toContain('  by: principal');
    expect(sourceMd).toContain('  at: 2026-06-08T09:00:00.000Z'); // override time, not archive time

    // The archived audit event records the principal provenance (SENSE-8 override-side).
    const audit = await fs.readFile(path.join(vault, destRel, 'audit.jsonl'), 'utf8');
    const archived = audit.trim().split('\n').map((l) => JSON.parse(l)).find((e) => e.action === 'archived');
    expect(archived.decision.sensitivityBy).toBe('principal');
  });

  it('archives a dropped file: embeds raw in source.md, keeps bytes verbatim', async () => {
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    const { ids } = await captureToInbox(vault, 'in-app-panel', [{ kind: 'file', name: 'shot.png', data: bytes }]);
    const dest = path.join(vault, await archiveOne(vault, ids[0]));

    expect(new Uint8Array(await fs.readFile(path.join(dest, 'raw.png')))).toEqual(bytes);
    expect(await fs.readFile(path.join(dest, 'source.md'), 'utf8')).toContain('![[raw.png]]');
  });

  it('ORCH-4: a full poke() drain empties the inbox into sources/ and writes status', async () => {
    await captureToInbox(vault, 'in-app-panel', [
      { kind: 'text', text: 'one' },
      { kind: 'file', name: 'two.png', data: new Uint8Array([1, 2, 3]) },
    ]);
    const orch = new Orchestrator(vault);
    await orch.poke();

    expect(await readQueue(vault)).toEqual([]);
    const status = await readStatus(vault);
    expect(status.queueDepth).toBe(0);
    expect(status.processing).toBeNull();
    expect(status.lastArchived).not.toBeNull();

    // two source folders now exist under sources/<shard>/
    const shardRoot = path.join(vault, 'sources');
    const found: string[] = [];
    async function walk(p: string): Promise<void> {
      for (const e of await fs.readdir(p, { withFileTypes: true })) {
        if (e.isDirectory()) {
          const child = path.join(p, e.name);
          if (await pathExists(path.join(child, 'source.md'))) found.push(child);
          else await walk(child);
        }
      }
    }
    await walk(shardRoot);
    expect(found).toHaveLength(2);
  });

  it('ORCH-13: idempotent — poke() on an empty queue is a no-op', async () => {
    const orch = new Orchestrator(vault);
    await orch.poke();
    const headBefore = (await simpleGit(vault).log()).latest?.hash;
    await orch.poke();
    expect((await simpleGit(vault).log()).latest?.hash).toBe(headBefore);
  });

  it('ORCH-13: restartable — a new Orchestrator resumes leftover inbox units', async () => {
    await captureToInbox(vault, 'in-app-panel', [{ kind: 'text', text: 'left behind' }]);
    // brand-new instance (simulating a restart) picks up the pending item
    await new Orchestrator(vault).poke();
    expect(await readQueue(vault)).toEqual([]);
  });

  it('CAPTURE-2: capture() preserves then the drain archives it', async () => {
    const orch = new Orchestrator(vault);
    await orch.capture('in-app-panel', [{ kind: 'text', text: 'via capture()' }]);
    await orch.poke(); // join/await the drain to idle
    expect(await readQueue(vault)).toEqual([]);
  });

  it('start()/stop(): the initial poke drains a pending item; the timer is cleared', async () => {
    await captureToInbox(vault, 'in-app-panel', [{ kind: 'text', text: 'pending' }]);
    const orch = new Orchestrator(vault);
    orch.start(60_000); // long interval: the timer won't fire during the test
    await orch.poke(); // joins the initial drain kicked off by start()
    orch.stop();
    expect(await readQueue(vault)).toEqual([]);
  });

  it('ORCH-12: a failing decision leaves the item preserved in the inbox (never lost)', async () => {
    const { ids } = await captureToInbox(vault, 'in-app-panel', [{ kind: 'text', text: 'unprocessable' }]);
    const failing = new Orchestrator(vault, () => {
      throw new Error('decider boom');
    });
    await expect(failing.poke()).resolves.toBeUndefined(); // poke never throws
    expect(await readQueue(vault)).toEqual(ids); // still queued, not dropped
    expect((await readStatus(vault)).processing).toBeNull();
    // and the raw item is still intact
    expect((await readCapturedMeta(path.join(vault, 'inbox', ids[0]))).kind).toBe('text');
  });

  async function collectSourceDocs(vault: string): Promise<string[]> {
    const found: string[] = [];
    async function walk(p: string): Promise<void> {
      let dirents;
      try {
        dirents = await fs.readdir(p, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of dirents) {
        if (!e.isDirectory()) continue;
        const child = path.join(p, e.name);
        if (await pathExists(path.join(child, 'source.md'))) found.push(path.join(child, 'source.md'));
        else await walk(child);
      }
    }
    await walk(path.join(vault, 'sources'));
    return found;
  }

  it('ORCH-14 end-to-end: a loose dropped file is normalized then archived with origin external', async () => {
    await fs.mkdir(path.join(vault, 'inbox'), { recursive: true });
    await fs.writeFile(path.join(vault, 'inbox', 'notes.txt'), 'dropped by another app');

    await new Orchestrator(vault).poke();

    expect(await readQueue(vault)).toEqual([]);
    const docs = await collectSourceDocs(vault);
    expect(docs).toHaveLength(1);
    const md = await fs.readFile(docs[0], 'utf8');
    expect(md).toContain('origin: external');
    expect(md).toContain('surface: folder-drop');
  });

  it('ORCH-8: drains with a Copilot decider (mocked session), one fresh session per item', async () => {
    await captureToInbox(vault, 'in-app-panel', [
      { kind: 'text', text: 'a' },
      { kind: 'text', text: 'b' },
    ]);
    const run = vi.fn(async () => '{"kind":"text","class":"primary","scope":"global","sensitivity":"internal"}');
    await new Orchestrator(vault, makeCopilotDecider({ available: true, run })).poke();

    expect(await readQueue(vault)).toEqual([]);
    expect(run).toHaveBeenCalledTimes(2); // ORCH-5: a disposable session per item

    // ORCH-16: the invocation is recorded in source.md and the archived audit event.
    const docs = await collectSourceDocs(vault);
    expect(await fs.readFile(docs[0], 'utf8')).toContain('archivedBy: copilot (default)');
    const audit = await fs.readFile(path.join(path.dirname(docs[0]), 'audit.jsonl'), 'utf8');
    const archived = audit
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l))
      .find((e) => e.action === 'archived');
    expect(archived.agent).toMatchObject({ via: 'copilot', runtime: 'copilot', model: 'default', ok: true });
  });

  it('archives via ephemeral per-item worktrees, leaving none behind (ORCH-20)', async () => {
    await captureToInbox(vault, 'in-app-panel', [{ kind: 'text', text: 'a' }]);
    await captureToInbox(vault, 'in-app-panel', [{ kind: 'text', text: 'b' }]);
    await new Orchestrator(vault).poke();
    expect(await readQueue(vault)).toEqual([]); // both archived
    // The old persistent `archivist` worktree no longer exists; each item now gets a fresh
    // ephemeral worktree (`archive-<ulid>`) that is torn down after — no leaked worktrees.
    expect(await pathExists(path.join(vault, '.kb', 'cache', 'worktrees', 'archivist'))).toBe(false);
    const wtDir = path.join(vault, '.kb', 'cache', 'worktrees');
    const leftover = (await fs.readdir(wtDir).catch(() => [] as string[])).filter((d) => d.startsWith('archive-'));
    expect(leftover).toEqual([]);
  });
});
