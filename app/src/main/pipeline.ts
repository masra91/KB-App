// Main-process owner of the active vault's orchestration engine (SPEC-0014 / SPEC-0021).
//
// EVERGREEN MODEL (SPEC-0019/0021): the whole working pipeline runs on a persistent `staging`
// worktree (`.kb/cache/worktrees/staging`), never on the vault root. The stages are
// root-agnostic, so handing them the staging worktree as their "root" makes all their existing
// logic (queues, markers, isolation worktrees, ff-advance) operate on `staging`. The vault
// root stays on `main` for Obsidian; the archivist's `afterDrain` hook runs the promotion gate
// (`promote`) to publish freshly-archived `sources/` from `staging` → `main`. Working state
// (inbox, entities, claims, candidates, the Review queue) lives only on `staging`.
//
// All stages share ONE canonical-writer lock per vault (SPEC-0014 §5): promotion + every stage
// ref-advance serialize through it.
import path from 'node:path';
import simpleGit from 'simple-git';
import { Orchestrator } from '../kb/orchestrator';
import { makeCopilotDecider } from '../kb/copilotAgent';
import { DecomposeStage } from '../kb/decomposeStage';
import { makeDecomposeDecider } from '../kb/decomposeAgent';
import { ClaimsStage } from '../kb/claimsStage';
import { makeClaimsDecider } from '../kb/claimsAgent';
import { ConnectStage } from '../kb/connectStage';
import { makeConnectDecider } from '../kb/connectAgent';
import { Mutex } from '../kb/stageLock';
import { ensureStagingWorktree } from '../kb/stagingWorktree';
import { promote } from '../kb/staging';
import { findOpenReviews, answerReview as answerReviewInVault, type AnswerReviewResult } from '../kb/reviewStore';
import { runFullReplay } from '../kb/replay';
import { JobScheduler } from '../kb/jobScheduler';
import { exampleJobBehavior, EXAMPLE_JOB_TYPE } from '../kb/exampleJob';
import { makeReflectJobBehavior, REFLECT_JOB_TYPE } from '../kb/reflectJob';
import { makeReflectDecider } from '../kb/reflectAgent';
import { readJobRegistry, patchJob, upsertJob, jobRegistryPath } from '../kb/jobRegistry';
import { readJournal } from '../kb/jobStage';
import { JOB_CATALOG, catalogEntry } from '../kb/jobCatalog';
import { buildJobViews, isSchedulePreset, isAutonomyPosture, jobConfigAuditEvents } from '../kb/jobsPanel';
import { appendAuditEvent } from '../kb/audit';
import { DEFAULT_POSTURE, type JobBehavior, type JobConfig, type JournalEntry } from '../kb/jobs';
import type { Review } from '../kb/reviews';
import type { FullReplayResult, JobView, JobConfigPatch, RunJobResult } from '../kb/types';

/** Resolve a registered job's `type` to its behavior (SPEC-0023). v1 ships the deterministic
 *  example job and **Reflect** (SPEC-0024, the first real job); later job types register here as
 *  they land. An unknown type returns null and the scheduler skips it. */
function resolveJobBehavior(type: string): JobBehavior | null {
  if (type === EXAMPLE_JOB_TYPE) return exampleJobBehavior;
  if (type === REFLECT_JOB_TYPE) return makeReflectJobBehavior(makeReflectDecider());
  return null;
}

interface ActivePipeline {
  vaultPath: string; // the vault root — on `main`, what Obsidian sees (promotion target)
  stagingWt: string; // the staging worktree — where every stage operates
  orch: Orchestrator;
  decompose: DecomposeStage;
  connect: ConnectStage;
  claims: ClaimsStage;
  jobs: JobScheduler; // SPEC-0023: wakes autonomous jobs on a schedule (concurrent, single-flight)
  lock: Mutex;
}

let active: ActivePipeline | null = null;

/** Start every active stage's poke/sweep loop. The SINGLE source of truth for "which stages run"
 *  — both `startPipeline` and `fullReplay`'s resume call this, so a replay can never diverge from
 *  normal startup (e.g. start a stage that startup deliberately leaves dormant). */
function startActiveStages(a: ActivePipeline): void {
  a.orch.start();
  a.decompose.start();
  a.connect.start();
  a.claims.start();
  a.jobs.start(); // SPEC-0023: the autonomous-job scheduler tick (named-preset cadence)
}

/** Stop every stage's sweep loop (shutdown, vault switch, or pre-replay pause). */
function stopAllStages(a: ActivePipeline): void {
  a.orch.stop();
  a.decompose.stop();
  a.connect.stop();
  a.claims.stop();
  a.jobs.stop();
}

/**
 * Start (or reuse) the pipeline for `vaultPath`, replacing any prior one. The stages run on the
 * vault's persistent `staging` worktree; the archivist promotes `sources/` to `main` after each
 * drain. All stages share one canonical-writer lock (§5). Async because it provisions the
 * staging worktree before the stages start.
 */
export async function startPipeline(vaultPath: string): Promise<Orchestrator> {
  if (active?.vaultPath === vaultPath) return active.orch;
  if (active) stopAllStages(active);

  const stagingWt = await ensureStagingWorktree(vaultPath); // working surface (on `staging`)
  const lock = new Mutex(); // the shared serialized canonical writer for this vault (§5)
  // The promotion gate: publish the evergreen subset staging→main, serialized under the lock
  // (SPEC-0021 STAGING-3/4). A stage runs it after a drain that changed an evergreen path
  // (archive→sources; connect→entities), so `main` tracks the resolved graph.
  const promoteEvergreen = async (): Promise<void> => {
    await promote(vaultPath);
  };
  const orch = new Orchestrator(stagingWt, makeCopilotDecider(), lock, promoteEvergreen);
  // The four stages run on the staging worktree (root-agnostic) and serialize their canonical
  // advances through the one shared lock (§5). Pipeline order is Decompose→Connect→Claims
  // (SPEC-0020 reorder): Decompose emits candidates, Connect resolves them into evergreen
  // `entities/` (carrying source-dir provenance Claims can read), Claims attaches claims to the
  // resolved graph. They drain independently; the lock keeps their staging ff-advances from
  // racing. Connect + Claims each carry the promotion gate as their afterDrain so resolved
  // entities and their claims become visible on `main` (the archivist already promotes sources/).
  const decompose = new DecomposeStage(stagingWt, makeDecomposeDecider(), lock);
  const connect = new ConnectStage(stagingWt, makeConnectDecider(), lock, undefined, promoteEvergreen);
  // Claims' afterDrain promotes the new claims, then pokes Connect: now that the entity's claims
  // carry `relatesTo` hints, Connect's link-promotion pass turns them into `[[wikilinks]]`
  // (CONNECT-12) and promotes the linked nodes. (Connect's own 30s sweep is the backstop.)
  const claims = new ClaimsStage(stagingWt, makeClaimsDecider(), lock, undefined, async () => {
    await promoteEvergreen();
    void connect.poke();
  });
  // The autonomous-job scheduler (SPEC-0023): wakes registered jobs on their named-preset cadence,
  // each a bounded, single-flight pass in its own worktree sharing the canonical-writer lock (a
  // job's ff-advance never races a stage's; ORCH-18) and the promotion gate (evergreen job outputs
  // reach `main`). Jobs run concurrently with the live pipeline (ORCH-17) — never blocking
  // capture/Enrich. Inert until the Principal enables a job in the registry.
  const jobs = new JobScheduler(stagingWt, resolveJobBehavior, lock, promoteEvergreen);
  active = { vaultPath, stagingWt, orch, decompose, connect, claims, jobs, lock };
  startActiveStages(active); // single source of truth for which loops run (shared with fullReplay)
  return orch;
}

/** The archivist orchestrator for the loaded KB, or null if none is active. */
export function activePipeline(): Orchestrator | null {
  return active?.orch ?? null;
}

/** The open "needs you" queue (SPEC-0018) — read from `staging`, where review state lives. */
export async function listActiveReviews(): Promise<Review[]> {
  return active ? findOpenReviews(active.stagingWt) : [];
}

/**
 * Answer an open review (REVIEW-6) on `staging`: records the verdict (+ optional note → primary
 * source), supersedes the park, then pokes the owning stage so the parked item resumes.
 */
export async function answerActiveReview(id: string, answerInput: unknown): Promise<AnswerReviewResult> {
  if (!active) return { ok: false, message: 'No active knowledge base.' };
  const result = await answerReviewInVault(active.stagingWt, active.lock, id, answerInput);
  if (result.ok && result.stage === 'claims') void active.claims.poke(); // resume the unparked item
  return result;
}

// --- Control Panel · Jobs (SPEC-0027 PANEL-2/6/7) — read/manage the per-vault job registry ---

/**
 * List the manageable jobs for the active KB (PANEL-2): the known-job catalog merged with the
 * registry, each row carrying its last-run summary from the journal. Reads `staging` (where the
 * registry + journals live). No active KB → empty list (the view degrades gracefully, PANEL-9).
 */
export async function listJobsForActive(): Promise<JobView[]> {
  if (!active) return [];
  const root = active.stagingWt;
  const registry = await readJobRegistry(root);
  // Gather the newest journal entry for every job we will show (catalog types ∪ registered ids).
  const ids = new Set<string>([...JOB_CATALOG.map((c) => c.type), ...registry.map((j) => j.id)]);
  const lastEntryByJobId: Record<string, JournalEntry | undefined> = {};
  for (const id of ids) {
    const journal = await readJournal(root, id);
    lastEntryByJobId[id] = journal[journal.length - 1];
  }
  return buildJobViews(JOB_CATALOG, registry, lastEntryByJobId);
}

/**
 * Apply a Jobs-view config change (PANEL-2/6) and return the refreshed list. A catalog-only job is
 * seeded into the registry on first edit. The registry write + git commit run under the shared
 * canonical-writer lock so they never race a stage's ff-advance — the commit is the durable record
 * that survives a staging reset. After the write, a **conforming `panel` audit event** is emitted per
 * changed field (PANEL-7 / AUDIT-2/11 — carries field/from/to + the why, via the SPEC-0029 writer
 * which enforces actor registration at emit). The scheduler reads the registry fresh each tick and
 * rebuilds a job's runner when its config signature changes, so the edit takes effect with no
 * restart (PANEL-6).
 *
 * Untrusted IPC input is validated at this trust boundary: id/type required, `schedule`/`posture`
 * are dropped unless they are known enum values (the existing `isSchedulePreset`/`isAutonomyPosture`
 * validators), and an unknown job (not in the catalog and not already registered) is refused — never
 * create a job for an arbitrary/unresolvable type.
 */
export async function setActiveJobConfig(patch: JobConfigPatch): Promise<JobView[]> {
  if (!active) return [];
  const root = active.stagingWt;
  if (typeof patch.id !== 'string' || patch.id.length === 0 || typeof patch.type !== 'string' || patch.type.length === 0) {
    return listJobsForActive();
  }
  // Sanitize: keep only valid enum fields (fail-safe — drop anything unrecognized).
  const clean: JobConfigPatch = { id: patch.id, type: patch.type };
  if (typeof patch.enabled === 'boolean') clean.enabled = patch.enabled;
  if (isSchedulePreset(patch.schedule)) clean.schedule = patch.schedule;
  if (isAutonomyPosture(patch.posture)) clean.posture = patch.posture;

  let prior: JobConfig | undefined;
  let applied = false;
  await active.lock.run(async () => {
    const registry = await readJobRegistry(root);
    prior = registry.find((j) => j.id === clean.id);
    // Refuse an unknown job (not in the catalog and not already registered) from untrusted input.
    if (!prior && catalogEntry(clean.type) === undefined) return;
    applied = true;
    if (prior) {
      await patchJob(root, clean.id, {
        ...(clean.enabled !== undefined ? { enabled: clean.enabled } : {}),
        ...(clean.schedule !== undefined ? { schedule: clean.schedule } : {}),
        ...(clean.posture !== undefined ? { posture: clean.posture } : {}),
      });
    } else {
      await upsertJob(root, {
        id: clean.id,
        type: clean.type,
        enabled: clean.enabled ?? false,
        schedule: clean.schedule ?? 'off',
        posture: clean.posture ?? DEFAULT_POSTURE,
      });
    }
    await commitRegistryChange(root, summarizeJobChange(clean));
  });
  if (applied) {
    // Conforming audit (PANEL-7 / AUDIT-2/11): one `panel` event per changed field, carrying the why.
    // Appends to the gitignored `.kb/audit.jsonl` (not canonical) — fine outside the lock.
    for (const event of jobConfigAuditEvents(prior, clean)) await appendAuditEvent(root, event);
  }
  return listJobsForActive();
}

/**
 * Manual "Run now" for one job (PANEL-2; JOBS-11) — one bounded pass on demand, respecting
 * single-flight. Run-now is independent of enable/schedule, so a catalog-only job is seeded
 * (off/guarded) and committed before running, letting the Principal test a job without turning it on.
 * The Principal's trigger is itself audited as a `panel` event (PANEL-7); the run's own work is
 * audited by the job journal (actor `job`).
 */
export async function runActiveJobNow(id: string): Promise<RunJobResult> {
  if (!active) return { ran: false, reason: 'no-kb' };
  const root = active.stagingWt;
  const registry = await readJobRegistry(root);
  if (!registry.some((j) => j.id === id)) {
    const entry = catalogEntry(id); // v1: catalog id === type
    if (!entry) return { ran: false, reason: 'not-found' };
    await active.lock.run(async () => {
      await upsertJob(root, { id, type: entry.type, enabled: false, schedule: 'off', posture: DEFAULT_POSTURE });
      await commitRegistryChange(root, `seed job ${id} for run-now`);
    });
  }
  const res = await active.jobs.runNow(id);
  const outcome = res === 'skipped' || res === 'not-found' || res === 'unknown-type' ? res : res.outcome;
  // Audit the Principal-initiated trigger (PANEL-7) — the trigger happened regardless of outcome.
  await appendAuditEvent(root, {
    actor: 'panel',
    eventType: 'job-run-now',
    subjects: { jobId: id },
    payload: { outcome, why: 'Principal manual run via Control Panel' },
  });
  if (res === 'skipped' || res === 'not-found' || res === 'unknown-type') return { ran: false, reason: res };
  return { ran: true, outcome: res.outcome, applied: res.applied, deferred: res.deferred };
}

/** A short, human commit summary of a job-config change (the conforming audit event carries from/to). */
function summarizeJobChange(patch: JobConfigPatch): string {
  const parts: string[] = [];
  if (patch.enabled !== undefined) parts.push(`enabled=${patch.enabled}`);
  if (patch.schedule !== undefined) parts.push(`schedule=${patch.schedule}`);
  if (patch.posture !== undefined) parts.push(`posture=${patch.posture}`);
  return `job ${patch.id}${parts.length ? ` set ${parts.join(', ')}` : ' config change'}`;
}

/**
 * Commit a job-registry change on the `staging` root — the **durability record**: the registry lives
 * under `.kb/jobs/`, tracked on `staging` and never promoted, so a commit is durable and protects the
 * file from a stray staging reset (the *conforming* audit is the separate `panel` event emitted by
 * the caller). MUST be called inside `lock.run` (it advances the canonical branch directly; under the
 * lock it is just another linear advance that stages cherry-pick their disjoint work onto). A no-op
 * write (identical bytes) commits nothing.
 */
async function commitRegistryChange(root: string, message: string): Promise<void> {
  const git = simpleGit(root);
  const rel = path.relative(root, jobRegistryPath(root));
  await git.add(rel);
  const staged = (await git.diff(['--cached', '--name-only'])).trim();
  if (staged.length === 0) return; // nothing actually changed
  await git.commit(`control-panel: ${message}`);
}

/** Stop and clear the active pipeline (used on shutdown / vault switch). */
export function stopPipeline(): void {
  if (active) stopAllStages(active);
  active = null;
}

let replaying = false;

/**
 * Full Replay (SPEC-0022 REPLAY): clean & rebuild the active KB. Principal-initiated only —
 * the IPC layer surfaces it behind a confirm dialog (REPLAY-1/2). Pauses the stage sweeps so
 * nothing re-derives mid-purge (an in-flight item's commit lands under the shared lock, then the
 * purge runs), performs the purge + epoch reset + promotion on `staging`→`main` (REPLAY-4/6/8),
 * then resumes the sweeps so the pipeline re-derives every Source from the start (REPLAY-9).
 * A second concurrent replay is refused (REPLAY-12).
 */
export async function fullReplay(): Promise<FullReplayResult> {
  if (!active) return { ok: false, message: 'No active knowledge base.' };
  if (replaying) return { ok: false, message: 'A replay is already in progress.' };
  replaying = true;
  const { vaultPath, stagingWt, lock } = active;
  // Pause every sweep before the purge; the in-flight commit (if any) drains as we take the lock.
  stopAllStages(active);
  try {
    const counts = await runFullReplay(vaultPath, stagingWt, lock);
    return {
      ok: true,
      replayId: counts.replayId,
      sourcesReset: counts.sourcesReset,
      purgedTrees: counts.purgedTrees,
      message:
        counts.sourcesReset > 0
          ? `Cleaning & rebuilding — reset ${counts.sourcesReset} source(s) for reprocessing.`
          : 'Nothing to rebuild — the KB has no sources yet.',
    };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  } finally {
    // Auto-resume (REPLAY-9): restart the sweeps whether the replay succeeded or failed, so the
    // pipeline is never left paused. Uses the SAME startActiveStages() as startPipeline, so the
    // post-replay stage set always mirrors normal startup (no dormant-stage divergence).
    if (active) startActiveStages(active);
    replaying = false;
  }
}
