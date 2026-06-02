// The orchestration engine (SPEC-0014 ORCH). A DETERMINISTIC loop that drains the inbox
// queue one item at a time, each archived in an isolated git worktree so the canonical
// vault tree only ever advances by clean, committed work (ORCH-2/3). Per item:
//   sync worktree → decide → move into sources/ + write source.md → commit → ff-advance.
// "Orchestration is deterministic; cognition is disposable" — the per-item decision comes
// from an injected `ArchivistDecider` (v1 = deterministic; Phase B = a Copilot session).
//
// v1 note: the loop runs in-process (serialized by a mutex) rather than a spawned OS
// process; "headless when the window is closed" holds because the main process stays
// alive. The worktree lives under the gitignored `.kb/cache/` (rebuildable) so no
// `.gitignore` churn is needed.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import simpleGit from 'simple-git';
import { dateShard } from './ulid';
import { deterministicDecider, type ArchivistDecider } from './archivist';
import { renderSourceMd, bodyFor } from './sourceDoc';
import { captureToInbox, readCapturedMeta, normalizeInbox, type CapturePayload, type CaptureOutcome } from './ingest';
import { Mutex } from './stageLock';
import { withConcurrentAdvance, DEFAULT_STAGE_CAP, type PrepareContext } from './canonicalAdvance';
import { noopDevLog, type DevLog } from './devlog';

const STATUS_REL = path.join('.kb', 'cache', 'status.json');

export interface PipelineStatusData {
  queueDepth: number;
  processing: string | null;
  lastArchived: string | null;
  updatedAt: string | null;
}

/** The inbox queue: sorted ULID directories (ULIDs sort by capture time). ORCH-4. */
export async function readQueue(root: string): Promise<string[]> {
  const inbox = path.join(path.resolve(root), 'inbox');
  let entries: string[];
  try {
    entries = await fs.readdir(inbox);
  } catch {
    return [];
  }
  const dirs: string[] = [];
  for (const e of entries) {
    try {
      if ((await fs.stat(path.join(inbox, e))).isDirectory()) dirs.push(e);
    } catch {
      /* vanished mid-scan — skip */
    }
  }
  return dirs.sort();
}

/**
 * Archive one inbox unit, returning its new `sources/` path, under optimistic concurrency
 * (SPEC-0014 ORCH-17/18). The move + source.md + audit write happen OFF the lock, synced to a
 * canonical checkpoint; only the ff-advance runs under `lock`. Archive items write disjoint
 * `sources/<id>` paths (unique ULID, ORCH-6) and the archivist is the sole writer of `sources/`
 * on `staging`, so the advance is always a fast-forward or a clean disjoint replay — a collision
 * is not expected, and an (impossible) exhaustion throws so the drain leaves the unit in the inbox
 * (never half-applied, ORCH-12). `lock` defaults to a private mutex so standalone calls serialize.
 */
export async function archiveOne(
  root: string,
  id: string,
  decider: ArchivistDecider = deterministicDecider,
  lock: Mutex = new Mutex(),
): Promise<string> {
  root = path.resolve(root);
  const destRel = path.join('sources', dateShard(id), id);

  const prepare = async ({ wt }: PrepareContext): Promise<boolean> => {
    const wtGit = simpleGit(wt); // the ephemeral per-item worktree, fresh off the checkpoint

    const unitDir = path.join(wt, 'inbox', id);
    const meta = await readCapturedMeta(unitDir);
    const decision = await decider(meta);

    const dest = path.join(wt, destRel);
    await fs.mkdir(path.dirname(dest), { recursive: true });
    await fs.rename(unitDir, dest); // move the raw bytes verbatim — never rewritten (DATA-2)

    const archivedAt = new Date().toISOString();
    const textContent = meta.kind === 'text' ? await fs.readFile(path.join(dest, meta.raw), 'utf8') : null;
    await fs.writeFile(path.join(dest, 'source.md'), renderSourceMd(meta, decision, archivedAt, bodyFor(meta, textContent)), 'utf8');
    // ORCH-16: record the agent invocation (runtime/model/params/outcome) for posterity.
    const { agent, ...coreDecision } = decision;
    await fs.appendFile(
      path.join(dest, 'audit.jsonl'),
      JSON.stringify({ action: 'archived', id, archivedAt, decision: coreDecision, agent: agent ?? { via: 'deterministic' } }) + '\n',
      'utf8',
    );

    await wtGit.raw('add', '-A');
    await wtGit.commit(`archive: ${id}`);
    return true;
  };

  const onExhausted = async (): Promise<void> => {
    // Unreachable in practice (disjoint sources/ paths, sole writer) — if it ever happens, fail so
    // the drain leaves the unit in the inbox for a later sweep rather than half-applying (ORCH-12).
    throw new Error(`archive: ${id} exhausted optimistic-advance retries (unexpected same-path collision)`);
  };

  await withConcurrentAdvance({ root, lock, stage: 'archive' }, prepare, onExhausted);
  return destRel;
}

async function writeStatus(root: string, status: PipelineStatusData): Promise<void> {
  const file = path.join(path.resolve(root), STATUS_REL);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(status, null, 2) + '\n', 'utf8');
}

/** Live status for the UI: queue depth from the filesystem, the rest from `status.json`. */
export async function readStatus(root: string): Promise<PipelineStatusData> {
  const queueDepth = (await readQueue(root)).length;
  let saved: Partial<PipelineStatusData> = {};
  try {
    saved = JSON.parse(await fs.readFile(path.join(path.resolve(root), STATUS_REL), 'utf8')) as Partial<PipelineStatusData>;
  } catch {
    /* no status yet */
  }
  return {
    queueDepth,
    processing: saved.processing ?? null,
    lastArchived: saved.lastArchived ?? null,
    updatedAt: saved.updatedAt ?? null,
  };
}

/**
 * Owns one vault's pipeline: capture (under the lock) + a poke/sweep drain loop. Capture
 * and archiving share the mutex, so the canonical repo is never written by two paths at
 * once. Restartable: a new instance re-reads the inbox and resumes (ORCH-13).
 */
export class Orchestrator {
  private readonly root: string;
  private readonly decider: ArchivistDecider;
  private readonly lock: Mutex;
  private readonly afterDrain?: () => Promise<void>;
  private readonly cap: number;
  private readonly log: DevLog;
  private sweepTimer: ReturnType<typeof setInterval> | null = null;
  private draining = false;
  private pending = false;
  private current: Promise<void> | null = null;
  private lastArchived: string | null = null;

  /**
   * @param lock the shared per-vault canonical-writer lock (SPEC-0014 §5). Pass the SAME
   *   instance to every stage of a vault so their canonical-ref advances serialize. Defaults
   *   to a private lock for standalone use (e.g. tests with only the archivist).
   * @param afterDrain optional hook run (serialized under the lock) after a drain settles —
   *   used by the staging pipeline to promote freshly-archived sources to `main` (SPEC-0021).
   */
  constructor(
    root: string,
    decider: ArchivistDecider = deterministicDecider,
    lock: Mutex = new Mutex(),
    afterDrain?: () => Promise<void>,
    cap: number = DEFAULT_STAGE_CAP,
    log: DevLog = noopDevLog,
  ) {
    this.root = path.resolve(root);
    this.decider = decider;
    this.lock = lock;
    this.afterDrain = afterDrain;
    this.cap = cap;
    this.log = log.child({ scope: 'archive' });
  }

  /** Initial drain + a periodic safety-net sweep (ORCH-15: poke + sweep). */
  start(sweepMs = 30_000): void {
    void this.poke();
    if (this.sweepTimer == null) {
      this.sweepTimer = setInterval(() => void this.poke(), sweepMs);
      this.sweepTimer.unref?.();
    }
  }

  stop(): void {
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
  }

  /** Fire-and-forget capture (CAPTURE-2): preserve+commit under the lock, then poke. */
  async capture(surface: string, payloads: CapturePayload[]): Promise<CaptureOutcome> {
    const res = await this.lock.run(() => captureToInbox(this.root, surface, payloads));
    void this.poke();
    return res;
  }

  status(): Promise<PipelineStatusData> {
    return readStatus(this.root);
  }

  /**
   * Drain the queue. Coalesces concurrent pokes: a poke during an active drain re-runs the
   * loop, and the returned promise resolves only once the pipeline is fully idle — so
   * callers (and tests) can deterministically await all pending work.
   */
  poke(): Promise<void> {
    this.pending = true;
    if (!this.draining) {
      this.draining = true;
      this.current = this.runDrains();
    }
    return this.current ?? Promise.resolve();
  }

  private async runDrains(): Promise<void> {
    try {
      while (this.pending) {
        this.pending = false;
        await this.drainOnce();
      }
    } finally {
      this.draining = false;
      this.current = null;
    }
  }

  private async drainOnce(): Promise<void> {
    // ORCH-14: adopt any foreign drops into canonical units before draining.
    await this.lock.run(() => normalizeInbox(this.root));
    let queue = await readQueue(this.root);
    await this.updateStatus(queue.length, null);
    while (queue.length > 0) {
      // ORCH-17/18/20: archive up to `cap` items concurrently — each prepares OFF the lock in its own
      // ephemeral worktree, advances UNDER the shared lock (cap=1 ⇒ serial). A failing item throws and
      // stays in the inbox (ORCH-12); the batch's other items still land, and a later sweep retries.
      const batch = queue.slice(0, this.cap);
      await this.updateStatus(queue.length, batch[0]);
      try {
        await Promise.all(batch.map((id) => archiveOne(this.root, id, this.decider, this.lock)));
        this.lastArchived = batch[batch.length - 1];
      } catch (err) {
        // OBS-4: archive failed — the item stays in the inbox (ORCH-12). Surface the cause so this
        // is never a silent "N in queue, nothing happened" stall (the bug that motivated SPEC-0030).
        this.log.error('archive.drain-error', { itemId: batch[0], err });
        await this.updateStatus(queue.length, null);
        return;
      }
      queue = await readQueue(this.root);
    }
    await this.updateStatus(0, null);
    // SPEC-0021: publish freshly-archived evergreen sources from `staging` to `main`,
    // serialized under the shared lock so it never races a stage's ref advance.
    if (this.afterDrain) await this.lock.run(() => this.afterDrain!());
  }

  private async updateStatus(queueDepth: number, processing: string | null): Promise<void> {
    await writeStatus(this.root, {
      queueDepth,
      processing,
      lastArchived: this.lastArchived,
      updatedAt: new Date().toISOString(),
    });
  }
}
