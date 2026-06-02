// The autonomous-job scheduler (SPEC-0023 JOBS-2/6/11). A periodic tick reads the per-vault job
// registry and, for each enabled job whose named-preset cadence is due, wakes one bounded pass via
// its JobRunner (single-flight). Cadence is coarse (named presets, JOBS-2); "due" is derived from
// the job's own journal (last-run timestamp), so it survives restarts (JOBS-13) with no separate
// timer state. A manual "run now" (JOBS-11) reuses the same path + single-flight. The scheduler
// owns no canonical writes — JobRunner/runJobOnce do, under the shared lock.
import { PRESET_INTERVAL_MS, type JobConfig, type JobBehavior } from './jobs';
import { readJobRegistry } from './jobRegistry';
import { JobRunner, readJournal, type JobRunResult } from './jobStage';
import { Mutex } from './stageLock';
import { noopDevLog, type DevLog } from './devlog';

/** Resolve a job `type` to its behavior (pluggable). Returns null for an unknown/not-yet-built type
 *  (e.g. `reflect` before SPEC-0024 lands) — such jobs are skipped, not errored. */
export type BehaviorResolver = (type: string) => JobBehavior | null;

/** Is a job due to run now, given its last journal entry? Never-run → due; else last + interval ≤ now. */
export async function isJobDue(root: string, job: JobConfig, now: number): Promise<boolean> {
  if (!job.enabled || job.schedule === 'off') return false;
  const interval = PRESET_INTERVAL_MS[job.schedule];
  const journal = await readJournal(root, job.id);
  const last = journal[journal.length - 1];
  if (!last) return true; // never run → due immediately
  const lastMs = Date.parse(last.ts);
  return !Number.isFinite(lastMs) || now - lastMs >= interval;
}

export class JobScheduler {
  private readonly root: string;
  private readonly resolve: BehaviorResolver;
  private readonly lock: Mutex;
  private readonly afterRun?: () => Promise<void>;
  private readonly log: DevLog;
  // Persistent runner per job id so single-flight (JOBS-6) holds ACROSS ticks; refreshed (when idle)
  // if the job's config changed in the registry. `sig` is the config snapshot the runner was built on.
  private readonly runners = new Map<string, { runner: JobRunner; sig: string }>();
  private tickTimer: ReturnType<typeof setInterval> | null = null;
  private ticking = false;

  /** `root` is the staging worktree (where the pipeline operates + the journal lives). */
  constructor(root: string, resolve: BehaviorResolver, lock: Mutex = new Mutex(), afterRun?: () => Promise<void>, log: DevLog = noopDevLog) {
    this.root = root;
    this.resolve = resolve;
    this.lock = lock;
    this.afterRun = afterRun;
    this.log = log;
  }

  /** Start the periodic tick (default 1 min; coarse presets mean most ticks are no-ops). */
  start(tickMs = 60_000): void {
    void this.tick();
    if (this.tickTimer == null) {
      this.tickTimer = setInterval(() => void this.tick(), tickMs);
      this.tickTimer.unref?.();
    }
  }

  stop(): void {
    if (this.tickTimer) {
      clearInterval(this.tickTimer);
      this.tickTimer = null;
    }
  }

  /** One scheduler tick: run every enabled+due job whose type resolves, **serially** (v1 runs jobs
   *  serially under the shared lock — SPEC-0023 §2), each single-flight (JOBS-6). Ticks never
   *  overlap (`ticking` guard). Returns the ids it fired (for observability/tests). */
  async tick(now: number = Date.now()): Promise<string[]> {
    if (this.ticking) return [];
    this.ticking = true;
    const fired: string[] = [];
    try {
      const jobs = await readJobRegistry(this.root);
      for (const job of jobs) {
        const behavior = this.resolve(job.type);
        if (!behavior) continue; // unknown/not-yet-built type → skip
        if (!(await isJobDue(this.root, job, now))) continue;
        fired.push(job.id);
        await this.runnerFor(job, behavior).runNow();
      }
    } finally {
      this.ticking = false;
    }
    return fired;
  }

  /** Manual "run now" for one job (JOBS-11): one bounded pass on demand, same single-flight + rules.
   *  Returns the run outcome, `'skipped'` (already in flight), or a reason it couldn't run. */
  async runNow(jobId: string): Promise<JobRunResult | 'skipped' | 'not-found' | 'unknown-type'> {
    const jobs = await readJobRegistry(this.root);
    const job = jobs.find((j) => j.id === jobId);
    if (!job) return 'not-found';
    const behavior = this.resolve(job.type);
    if (!behavior) return 'unknown-type';
    return this.runnerFor(job, behavior).runNow();
  }

  /** Get-or-(re)build the persistent runner for a job, preserving its single-flight guard. The
   *  runner is rebuilt only when the job's config changed AND it isn't mid-run. */
  private runnerFor(job: JobConfig, behavior: JobBehavior): JobRunner {
    const sig = JSON.stringify(job);
    const existing = this.runners.get(job.id);
    if (existing && (existing.sig === sig || existing.runner.inFlight)) return existing.runner;
    const runner = new JobRunner(this.root, job, behavior, this.lock, this.afterRun, this.log);
    this.runners.set(job.id, { runner, sig });
    return runner;
  }
}
