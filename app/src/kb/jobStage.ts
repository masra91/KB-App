// The Job runtime (SPEC-0023 JOBS) — a FIFTH user of the SPEC-0014 harness, generalized from
// "react to one new source" to "wake on a schedule, do one bounded pass." Like the Enrich stages
// it runs an agent in a disposable worktree synced to a canonical checkpoint, then advances the
// canonical under the shared lock via the optimistic-concurrency helper (ORCH-17/18/19) — so a job
// NEVER blocks live capture/Enrich (JOBS-3/5). It is single-flight (JOBS-6), keeps a per-job journal
// (JOBS-7), audits richly (JOBS-8), routes findings by disposition+posture (JOBS-9/15), and takes no
// external side-effecting action (JOBS-10 — behaviors are pure cognition; the runner owns all writes).
import { promises as fs } from 'node:fs';
import path from 'node:path';
import simpleGit from 'simple-git';
import { ulid } from './ulid';
import { ensureGitIdentity } from './vault';
import { Mutex } from './stageLock';
import { withOptimisticAdvance, advanceOrCollide, canonicalHead, DEFAULT_MAX_COLLISION_RETRIES } from './canonicalAdvance';
import { reviewRel, writeReviewFile } from './reviewStore';
import type { Review } from './reviews';
import {
  effectiveDisposition,
  type JobConfig,
  type JobBehavior,
  type JournalEntry,
  type AuditedFinding,
} from './jobs';

/** Per-job disposable worktree + work branch (kept distinct per job id so jobs never collide). */
function worktreeRel(jobId: string): string {
  return path.join('.kb', 'cache', 'worktrees', `job-${jobId}`);
}
function workBranch(jobId: string): string {
  return `kb/job-${jobId}-work`;
}
/** Per-job run-state journal (JOBS-7): tracked on `staging`, never promoted (not in EVERGREEN_PATHS). */
export function journalRel(jobId: string): string {
  return path.join('.kb', 'jobs', jobId, 'journal.jsonl');
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Knowledge roots a job's auto-applied writes may target (SPEC-0023 JOBS-10 sink guard). DERIVED
 * knowledge only — entities/claims/outputs — never `sources/` (immutable ground truth, the forward
 * pipeline's domain; DECOMP-8/DATA-2) and never config/engine/repo paths. A DISTINCT constant from
 * `EVERGREEN_PATHS` (which includes `sources`): jobs READ evergreen but must never WRITE ground truth.
 */
export const JOB_WRITE_PATHS = ['entities', 'claims', 'outputs'] as const;

/** Realpath the deepest EXISTING ancestor of `target` and re-append the non-existent tail, so a
 *  symlink anywhere in the existing portion is resolved (the target file itself may not exist yet).
 *  This is what makes containment symlink-safe — lexical `path.resolve` alone would let a committed
 *  symlink (`entities/x -> ../../sources`) appear contained while the write follows it out. */
async function resolveSymlinkSafe(target: string): Promise<string> {
  let existing = target;
  const tail: string[] = [];
  while (!(await pathExists(existing))) {
    tail.unshift(path.basename(existing));
    const parent = path.dirname(existing);
    if (parent === existing) return target; // hit the fs root without an existing ancestor
    existing = parent;
  }
  const realBase = await fs.realpath(existing);
  return tail.length > 0 ? path.join(realBase, ...tail) : realBase;
}

/**
 * Sink-side containment for an agent-emitted write set (JOBS-10) — defense-in-depth, independent of
 * disposition/posture, because `rel` is LLM output (a prompt-injection surface via node excerpts).
 * Returns a rejection reason for the FIRST offending write, or null if every write is safe. Both
 * checks run on the **symlink-resolved** path (not the raw string), so `..` traversal, absolute
 * paths, `entities/../sources/x`, and symlink escapes are all caught:
 *  - **containment:** the resolved real path must stay strictly within the worktree's real path;
 *  - **allowlist:** its top-level dir must be a JOB_WRITE_PATHS root (blocks `.git/`, `.kb/`, `app/`,
 *    repo-root files, AND `sources/`).
 * The caller treats any rejection as atomic over the whole finding (no partial writes).
 */
export async function validateWrites(wt: string, writes: readonly { rel: string; content: string }[]): Promise<string | null> {
  const wtReal = await fs.realpath(wt);
  for (const w of writes) {
    const resolved = await resolveSymlinkSafe(path.resolve(wt, w.rel));
    if (resolved === wtReal || !resolved.startsWith(wtReal + path.sep)) return `write escapes the worktree: ${w.rel}`;
    const top = path.relative(wtReal, resolved).split(path.sep)[0];
    if (!(JOB_WRITE_PATHS as readonly string[]).includes(top)) {
      return `write outside the knowledge roots (${JOB_WRITE_PATHS.join('/')}): ${w.rel}`;
    }
  }
  return null;
}

/** Read a job's journal (JOBS-7) from `root` (a worktree or vault root), oldest→newest. Missing → []. */
export async function readJournal(root: string, jobId: string): Promise<JournalEntry[]> {
  let raw: string;
  try {
    raw = await fs.readFile(path.join(path.resolve(root), journalRel(jobId)), 'utf8');
  } catch {
    return [];
  }
  const out: JournalEntry[] = [];
  for (const line of raw.split('\n')) {
    if (line.trim().length === 0) continue;
    try {
      out.push(JSON.parse(line) as JournalEntry);
    } catch {
      /* skip a malformed line — never crash continuity on a bad journal entry */
    }
  }
  return out;
}

/** Ensure a healthy per-job worktree on the job's work branch; recreate if broken (mirrors the stages). */
async function ensureJobWorktree(root: string, jobId: string): Promise<string> {
  const git = simpleGit(root);
  await ensureGitIdentity(git);
  const branch = (await git.raw('rev-parse', '--abbrev-ref', 'HEAD')).trim();
  const wt = path.join(root, worktreeRel(jobId));
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
    await git.raw('worktree', 'add', '-B', workBranch(jobId), wt, branch);
  }
  return wt;
}

export interface JobRunResult {
  jobId: string;
  runId: string;
  outcome: 'advanced' | 'noop' | 'setaside';
  inspected: string;
  applied: number; // findings auto-applied
  deferred: number; // findings routed to Review
}

/**
 * Run ONE bounded pass of `job` under optimistic concurrency (JOBS-3/4/5). The behavior's cognition
 * + all writes happen OFF the lock (synced to a canonical checkpoint); only the canonical ff-advance
 * runs under `lock`. A pass ALWAYS commits at least its journal/audit line, so it always advances
 * (records that it ran — even a no-find run, JOBS-7/8). Disjoint job writes (unique ULID paths +
 * the per-job journal) replay cleanly onto a moved canonical; a same-path collision retries against
 * the fresh canonical and, on exhaustion, records a set-aside (ORCH-19) — never half-applied.
 */
export async function runJobOnce(
  root: string,
  job: JobConfig,
  behavior: JobBehavior,
  lock: Mutex = new Mutex(),
): Promise<JobRunResult> {
  root = path.resolve(root);
  const runId = ulid();
  const branch = workBranch(job.id);
  let result: JobRunResult = { jobId: job.id, runId, outcome: 'noop', inspected: '', applied: 0, deferred: 0 };

  const prepare = async (base: string): Promise<boolean> => {
    const wt = await ensureJobWorktree(root, job.id);
    const wtGit = simpleGit(wt);
    await wtGit.raw('reset', '--hard', base); // sync to the canonical checkpoint (ORCH-17)

    const journal = await readJournal(wt, job.id);
    const pass = await behavior({ root: wt, posture: job.posture, config: job.config, journal });

    const audited: AuditedFinding[] = [];
    let applied = 0;
    let deferred = 0;
    const now = new Date().toISOString();
    for (const finding of pass.findings) {
      const posed = effectiveDisposition(finding, job.posture);
      const writes = finding.writes ?? [];
      // Sink guard (JOBS-10): even an auto disposition only applies if EVERY write is contained +
      // allowlisted. A rejection forces the WHOLE finding to Review (atomic — no partial writes).
      const rejection = posed === 'auto' ? await validateWrites(wt, writes) : null;
      const disposition: typeof posed = rejection ? 'review' : posed;
      const rec: AuditedFinding = { summary: finding.summary, kind: finding.kind, confidence: finding.confidence, disposition };
      if (disposition === 'auto') {
        // Additive, high-confidence, contained → apply the writes on `staging`, audited.
        for (const w of writes) {
          const dest = path.join(wt, w.rel);
          await fs.mkdir(path.dirname(dest), { recursive: true });
          await fs.writeFile(dest, w.content, 'utf8');
        }
        applied += 1;
      } else {
        // Destructive / low-confidence / sink-rejected → raise a Review (SPEC-0018), apply NO
        // effect (JOBS-9/10). A sink rejection records the reason in the audit (no silent drop).
        const id = ulid();
        const review: Review = {
          id,
          status: 'open',
          question: rejection ? `Job write rejected — needs review: ${finding.summary}` : finding.review?.question ?? finding.summary,
          detail: rejection ? `${finding.summary} — rejected: ${rejection}` : finding.review?.detail ?? finding.summary,
          raisedBy: {
            stage: `job:${job.id}`,
            runId,
            item: { kind: 'job', ref: journalRel(job.id) },
            auditRel: journalRel(job.id),
            markerKey: { jobId: job.id, runId },
          },
          subject: {},
          createdAt: now,
        };
        await writeReviewFile(path.join(wt, reviewRel(id)), review);
        rec.reviewId = id;
        if (rejection) rec.rejection = rejection;
        deferred += 1;
      }
      audited.push(rec);
    }

    // Append the rich journal/audit line for this run (JOBS-7/8) — always, even a no-find run.
    const entry: JournalEntry = {
      ts: now,
      runId,
      inspected: pass.inspected,
      applied,
      deferred,
      ...(audited.length > 0 ? { findings: audited } : {}),
      ...(pass.cursor ? { cursor: pass.cursor } : {}),
    };
    const journalPath = path.join(wt, journalRel(job.id));
    await fs.mkdir(path.dirname(journalPath), { recursive: true });
    await fs.appendFile(journalPath, JSON.stringify(entry) + '\n', 'utf8');

    await wtGit.raw('add', '-A');
    await wtGit.commit(`job ${job.id}: run ${runId} (${applied} applied, ${deferred} deferred)`);
    result = { jobId: job.id, runId, outcome: 'advanced', inspected: pass.inspected, applied, deferred };
    return true;
  };

  // Same-path collision exhaustion (ORCH-19): record a set-aside journal line, never half-apply.
  // The set-aside advance is itself bounded-retried against a moving canonical (mirrors #47's
  // hardened Connect path) so it can't be silently dropped — though for a job it's effectively
  // always ff/replay (the per-job journal path is disjoint + single-flight).
  const onExhausted = async (): Promise<void> => {
    for (let attempt = 0; attempt <= DEFAULT_MAX_COLLISION_RETRIES; attempt++) {
      const wt = await ensureJobWorktree(root, job.id);
      const wtGit = simpleGit(wt);
      const base = await canonicalHead(root);
      await wtGit.raw('reset', '--hard', base);
      const entry: JournalEntry = { ts: new Date().toISOString(), runId, inspected: result.inspected, applied: 0, deferred: 0, note: 'collision-exhausted' };
      const journalPath = path.join(wt, journalRel(job.id));
      await fs.mkdir(path.dirname(journalPath), { recursive: true });
      await fs.appendFile(journalPath, JSON.stringify(entry) + '\n', 'utf8');
      await wtGit.raw('add', '-A');
      await wtGit.commit(`job ${job.id}: set aside run ${runId} (collision-exhausted)`);
      if ((await lock.run(() => advanceOrCollide(root, branch, base))) === 'advanced') break;
      // The set-aside advance itself collided — re-sync to the moved canonical and retry (bounded).
    }
    result = { ...result, outcome: 'setaside' };
  };

  await withOptimisticAdvance({ root, lock, workBranch: branch }, prepare, onExhausted);
  return result;
}

/**
 * Owns one job's execution with **single-flight** (JOBS-6): a scheduled fire (or "run now",
 * JOBS-11) while a run is in progress is skipped, not stacked. After a run advances `staging`, the
 * optional `afterRun` hook publishes evergreen findings to `main` via the promotion gate (JOBS-12);
 * it is a no-op when the run only touched the (non-evergreen) journal.
 */
export class JobRunner {
  private readonly root: string;
  readonly job: JobConfig;
  private readonly behavior: JobBehavior;
  private readonly lock: Mutex;
  private readonly afterRun?: () => Promise<void>;
  private running = false;

  constructor(root: string, job: JobConfig, behavior: JobBehavior, lock: Mutex = new Mutex(), afterRun?: () => Promise<void>) {
    this.root = path.resolve(root);
    this.job = job;
    this.behavior = behavior;
    this.lock = lock;
    this.afterRun = afterRun;
  }

  /** True while a run is in flight (single-flight guard). */
  get inFlight(): boolean {
    return this.running;
  }

  /**
   * Run one bounded pass now (scheduled tick or manual "run now"), respecting single-flight: a call
   * while a run is in progress returns `'skipped'` (JOBS-6/11). Resolves with the run outcome.
   */
  async runNow(): Promise<JobRunResult | 'skipped'> {
    if (this.running) return 'skipped';
    this.running = true;
    try {
      const res = await runJobOnce(this.root, this.job, this.behavior, this.lock);
      if (this.afterRun) await this.afterRun(); // promote evergreen findings → main (no-op if journal-only)
      return res;
    } finally {
      this.running = false;
    }
  }
}
