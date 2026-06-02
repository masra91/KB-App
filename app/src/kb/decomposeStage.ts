// The Decompose stage runtime (SPEC-0015) — the second user of the SPEC-0014 harness:
// the SAME deterministic pattern as the archivist (worktree isolation, fresh disposable
// session per item, orchestrator-owns-effects, ff-advance under the shared canonical-writer
// lock), pointed at a different queue + instruction file (ORCH-9).
//
// Queue model (v1): the archivist does not yet enqueue an Enrich queue, so the durable work
// list is DERIVED — a source is "queued" iff its append-only `audit.jsonl` has no terminal
// `decompose` marker yet. Committing the candidates + the `decomposed` marker in one commit IS
// the commit-to-dequeue (DECOMP-13): next sweep skips it. Idempotent restart for free
// (ORCH-13). A failed attempt appends a `failed` event (durable count); after K it appends a
// terminal `setaside` marker so a poison source never head-of-line-blocks (DECOMP-6/ORCH-12).
//
// Sources are NEVER mutated (DECOMP-8): raw payload + `source.md` identity are untouched; we
// only append to the append-only `audit.jsonl` history (as the archivist already does) and
// write NEW CANDIDATE files under `candidates/`.
//
// CANON-4 / STAGING-5: Decompose does NOT write resolved `entities/` nodes. Each entity MENTION
// the agent finds becomes a per-mention CANDIDATE (`candidates/<dateShard>/<id>.json`, Connect's
// input contract) on the working `staging` branch; `entities/` stays empty until Connect resolves
// (SPEC-0020). Candidates are working state — never promoted to evergreen `main` (STAGING-6).
import { promises as fs } from 'node:fs';
import path from 'node:path';
import simpleGit from 'simple-git';
import { ulid } from './ulid';
import { ensureGitIdentity } from './vault';
import { readCapturedMeta } from './ingest';
import { renderCandidate, candidateFileRel } from './candidateDoc';
import type { Candidate } from './connect';
import { makeDecomposeDecider, type DecomposeDecider, type SourceInput } from './decomposeAgent';
import { Mutex } from './stageLock';
import { epochScopedLines } from './replayEpoch';

const WORKTREE_REL = path.join('.kb', 'cache', 'worktrees', 'decompose');
const WORK_BRANCH = 'kb/decompose-work';
const STAGE = 'decompose';
/** Default attempts before a poison source is set aside (DECOMP-6). */
export const DEFAULT_MAX_ATTEMPTS = 3;

/** A terminal marker means the source has left the derived queue (success or set-aside). */
const TERMINAL_EVENTS = new Set(['decomposed', 'setaside']);

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

/** One parsed line of a source's audit.jsonl that this stage cares about. */
interface AuditLine {
  stage?: string;
  event?: string;
}

/** Read a source dir's decompose audit state from its append-only audit.jsonl. */
async function readDecomposeState(sourceDir: string): Promise<{ terminal: boolean; failures: number }> {
  let raw: string;
  try {
    raw = await fs.readFile(path.join(sourceDir, 'audit.jsonl'), 'utf8');
  } catch {
    return { terminal: false, failures: 0 };
  }
  let terminal = false;
  let failures = 0;
  // Scope to the current replay epoch (REPLAY-6): markers from a superseded generation are
  // ignored, so a replayed source re-enters the decompose queue — without rewriting history.
  for (const line of epochScopedLines(raw)) {
    if (line.trim().length === 0) continue;
    let obj: AuditLine;
    try {
      obj = JSON.parse(line) as AuditLine;
    } catch {
      continue;
    }
    if (obj.stage !== STAGE) continue;
    if (obj.event && TERMINAL_EVENTS.has(obj.event)) terminal = true;
    if (obj.event === 'failed') failures += 1;
  }
  return { terminal, failures };
}

/** Recursively find every archived source directory (one containing a `source.md`). */
export async function findSourceDirs(root: string): Promise<string[]> {
  const sourcesRoot = path.join(path.resolve(root), 'sources');
  const out: string[] = [];
  async function walk(dir: string): Promise<void> {
    let entries: import('node:fs').Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    if (entries.some((e) => e.isFile() && e.name === 'source.md')) {
      out.push(dir);
      return; // a source unit is a leaf; don't descend into it
    }
    for (const e of entries) {
      if (e.isDirectory() && !e.name.startsWith('.')) await walk(path.join(dir, e.name));
    }
  }
  await walk(sourcesRoot);
  return out;
}

/**
 * The decompose work queue (DECOMP-13): archived sources with no terminal decompose marker
 * and fewer than `maxAttempts` failures. Returned as repo-relative source dirs, sorted by
 * id (ULID dir name) so drains are deterministic.
 */
export async function readDecomposeQueue(root: string, maxAttempts = DEFAULT_MAX_ATTEMPTS): Promise<string[]> {
  root = path.resolve(root);
  const dirs = await findSourceDirs(root);
  const queued: string[] = [];
  for (const dir of dirs) {
    const { terminal, failures } = await readDecomposeState(dir);
    if (terminal || failures >= maxAttempts) continue;
    queued.push(path.relative(root, dir));
  }
  return queued.sort((a, b) => (path.basename(a) < path.basename(b) ? -1 : 1));
}

/** Ensure a healthy persistent decompose worktree on WORK_BRANCH; recreate if broken. */
async function ensureWorktree(root: string): Promise<{ wt: string; branch: string }> {
  const git = simpleGit(root);
  await ensureGitIdentity(git);
  const branch = (await git.raw('rev-parse', '--abbrev-ref', 'HEAD')).trim();
  const wt = path.join(root, WORKTREE_REL);
  try {
    await git.raw('worktree', 'prune');
  } catch {
    /* none registered yet */
  }
  const healthy =
    (await pathExists(wt)) &&
    (await simpleGit(wt)
      .revparse(['--is-inside-work-tree'])
      .then(() => true)
      .catch(() => false));
  if (!healthy) {
    if (await pathExists(wt)) await fs.rm(wt, { recursive: true, force: true });
    await fs.mkdir(path.dirname(wt), { recursive: true });
    await git.raw('worktree', 'add', '-B', WORK_BRANCH, wt, branch);
  }
  return { wt, branch };
}

/** The rigid audit envelope (SPEC-0015 §3.4) — orchestrator-owned fields wrap freeform payloads. */
function auditLine(fields: Record<string, unknown>): string {
  return JSON.stringify({ ts: new Date().toISOString(), stage: STAGE, ...fields }) + '\n';
}

/** Build the agent's view of a source from its captured meta + raw text (text only in v1). */
async function readSourceInput(sourceDir: string): Promise<SourceInput> {
  const meta = await readCapturedMeta(sourceDir);
  const text = meta.kind === 'text' ? await fs.readFile(path.join(sourceDir, meta.raw), 'utf8') : null;
  return { sourceId: meta.id, kind: meta.kind, originalName: meta.originalName, mimeType: meta.mimeType, text };
}

export interface DecomposeOneResult {
  sourceId: string;
  ok: boolean;
  candidateIds: string[]; // ULIDs of the candidate files written on `staging` (STAGING-5)
  setAside: boolean;
}

/**
 * Decompose ONE source. MUST be called serialized via the shared canonical-writer lock so
 * the canonical branch does not move mid-cycle (the final ff-advance must always apply).
 */
export async function decomposeOne(
  root: string,
  sourceRel: string,
  decider: DecomposeDecider,
  maxAttempts = DEFAULT_MAX_ATTEMPTS,
): Promise<DecomposeOneResult> {
  root = path.resolve(root);
  const { wt, branch } = await ensureWorktree(root);
  const wtGit = simpleGit(wt);
  const rootGit = simpleGit(root);
  await wtGit.raw('reset', '--hard', branch); // sync to canonical HEAD

  const sourceDirWt = path.join(wt, sourceRel);
  const input = await readSourceInput(sourceDirWt);
  const runId = ulid();
  const auditPath = path.join(sourceDirWt, 'audit.jsonl');

  try {
    const decision = await decider(input);
    const model = decision.agent?.model ?? 'default';

    // Mint candidate ULIDs + write candidate files (orchestrator-owned effects; DECOMP-3/5).
    // Each entity MENTION becomes one CANDIDATE on `staging` (STAGING-5 / CANON-4); we write NO
    // `entities/` node — resolution into evergreen entities is Connect's job (SPEC-0020). The
    // candidate's `sourceId` carries provenance back to its source (DECOMP-5; DATA-5).
    const candidateIds: string[] = [];
    for (const entity of decision.entities) {
      const id = ulid();
      const candidate: Candidate = {
        id,
        sourceId: input.sourceId,
        kind: entity.kind,
        name: entity.name,
        confidence: entity.confidence,
        mentions: entity.mentions,
      };
      const dest = path.join(wt, candidateFileRel(id));
      await fs.mkdir(path.dirname(dest), { recursive: true });
      await fs.writeFile(dest, renderCandidate(candidate), 'utf8');
      candidateIds.push(id);
    }

    // Append audit (envelope-wrapped): start, every signal (audit-only; DECOMP-9), terminal
    // `decomposed` marker. Signals NEVER touch candidates or the source raw (DECOMP-8/9).
    let audit = auditLine({ runId, sourceId: input.sourceId, model, event: 'start' });
    for (const sig of decision.signals ?? []) {
      audit += auditLine({ runId, sourceId: input.sourceId, model, event: 'signal', type: sig.type, note: sig.note, refs: sig.refs });
    }
    audit += auditLine({ runId, sourceId: input.sourceId, model, event: 'decomposed', candidates: candidateIds.length });
    await fs.appendFile(auditPath, audit, 'utf8');

    await wtGit.raw('add', '-A');
    await wtGit.commit(`decompose: ${candidateIds.length} candidates from ${input.sourceId}`);
    await rootGit.raw('merge', '--ff-only', WORK_BRANCH); // serialized canonical advance
    return { sourceId: input.sourceId, ok: true, candidateIds, setAside: false };
  } catch (err) {
    // DECOMP-6 / ORCH-12: never lose the source. Record the failed attempt durably; set aside
    // after K so it can't head-of-line-block. No candidates are written on failure.
    const error = err instanceof Error ? err.message : String(err);
    const priorFailures = (await readDecomposeState(sourceDirWt)).failures;
    const attempt = priorFailures + 1;
    const setAside = attempt >= maxAttempts;
    let audit = auditLine({ runId, sourceId: input.sourceId, event: 'failed', attempt, error });
    if (setAside) audit += auditLine({ runId, sourceId: input.sourceId, event: 'setaside', attempts: attempt });
    await fs.appendFile(auditPath, audit, 'utf8');
    await wtGit.raw('add', '-A');
    await wtGit.commit(`decompose: failed ${input.sourceId} (attempt ${attempt}${setAside ? ', set aside' : ''})`);
    await rootGit.raw('merge', '--ff-only', WORK_BRANCH);
    return { sourceId: input.sourceId, ok: false, candidateIds: [], setAside };
  }
}

/**
 * Owns a vault's Decompose stage: a poke/sweep drain loop sharing the canonical-writer lock
 * with the archivist (SPEC-0014 §5). Restartable: re-reads the derived queue and resumes.
 */
export class DecomposeStage {
  private readonly root: string;
  private readonly decider: DecomposeDecider;
  private readonly lock: Mutex;
  private readonly maxAttempts: number;
  private sweepTimer: ReturnType<typeof setInterval> | null = null;
  private draining = false;
  private pending = false;
  private current: Promise<void> | null = null;

  constructor(
    root: string,
    decider: DecomposeDecider = makeDecomposeDecider(),
    lock: Mutex = new Mutex(),
    maxAttempts: number = DEFAULT_MAX_ATTEMPTS,
  ) {
    this.root = path.resolve(root);
    this.decider = decider;
    this.lock = lock;
    this.maxAttempts = maxAttempts;
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

  /** Drain the queue, coalescing concurrent pokes; resolves only once fully idle. */
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
    let queue = await readDecomposeQueue(this.root, this.maxAttempts);
    while (queue.length > 0) {
      const sourceRel = queue[0];
      try {
        await this.lock.run(() => decomposeOne(this.root, sourceRel, this.decider, this.maxAttempts));
      } catch {
        // Unexpected (decomposeOne handles its own failures) — stop this pass; a later
        // poke/sweep retries rather than spinning.
        return;
      }
      queue = await readDecomposeQueue(this.root, this.maxAttempts);
    }
  }
}
