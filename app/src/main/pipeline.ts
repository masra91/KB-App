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
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { Orchestrator, readQueue } from '../kb/orchestrator';
import { makeCopilotDecider } from '../kb/copilotAgent';
import { DecomposeStage, readDecomposeQueue } from '../kb/decomposeStage';
import { makeDecomposeDecider } from '../kb/decomposeAgent';
import { ClaimsStage, readClaimsQueue, listSetAsideItems, retryClaimsItem, dismissClaimsItem } from '../kb/claimsStage';
import { makeClaimsDecider } from '../kb/claimsAgent';
import { ConnectStage, readConnectQueue, listConnectSetAsideItems, retryConnectItem, dismissConnectItem } from '../kb/connectStage';
import { makeConnectDecider } from '../kb/connectAgent';
import { Mutex } from '../kb/stageLock';
import { createVaultDevLog, readRecentDevLogEntries, type DevLog } from '../kb/devlog';
import { breadcrumbObserver } from '../kb/activityBreadcrumb';
import { telemetryHealth } from './telemetry';
import { researchDepsOptions } from './researchWiring';
import { selectResearchFn } from '../kb/researchInline';
import { createVaultTracer } from '../kb/tracing';
import { loadPerfIndex } from '../kb/perfIndex';
import { assemblePipelineStatus, toSetAsideViews, deriveStageError, buildInFlightRoster, type PipelineStatusView, type StageInput, type RecentError, type WorktreeInfo } from '../kb/pipelineStatusView';
import { planSetAsideAction, type SetAsideTarget } from '../kb/pipelineControl';
import { readConversionCounts } from '../kb/conversionCounts';
import { ensureStagingWorktree } from '../kb/stagingWorktree';
import { reapEphemeralWorktrees, boundedGit } from '../kb/canonicalAdvance';
import { reconcileStaleIndexLock, hasLiveIndexHolder } from '../kb/canonicalLockHeal';
import { promote } from '../kb/staging';
import { findOpenReviews, answerReview as answerReviewInVault, type AnswerReviewResult } from '../kb/reviewStore';
import { executeApprovedConsolidation } from '../kb/executeApprovedConsolidation';
import { reviewResumeStage } from '../kb/reviewResume';
import { resumeApprovedResearchEscalation } from '../kb/researchResume';
import { runFullReplay } from '../kb/replay';
import { JobScheduler } from '../kb/jobScheduler';
import { exampleJobBehavior, EXAMPLE_JOB_TYPE } from '../kb/exampleJob';
import { makeReflectJobBehavior, REFLECT_JOB_TYPE } from '../kb/reflectJob';
import { makeReflectDecider } from '../kb/reflectAgent';
import { readJobRegistry, patchJob, upsertJob, jobRegistryPath } from '../kb/jobRegistry';
import { readJournal } from '../kb/jobStage';
import { JOB_CATALOG, catalogEntry } from '../kb/jobCatalog';
import { buildJobViews, isSchedulePreset, isAutonomyPosture, jobConfigAuditEvents } from '../kb/jobsPanel';
import { readInstanceConfig, writeInstanceConfig, instanceConfigPath, resolveJobPosture, defaultInstanceConfig, DEV_LOG_LEVELS, DEFAULT_DEV_LOG_LEVEL, DEFAULT_QUICK_CAPTURE_ACCELERATOR, type DevLogLevel } from '../kb/instanceConfig';
import { getQuickCaptureAgent } from './quickCaptureService';
import { AGENT_CATALOG, buildAgentViews } from '../kb/agentCatalog';
import { appendAuditEvent } from '../kb/audit';
import { readEvents } from '../kb/activityIndex';
import { readResearcherRegistry, upsertResearcher, patchResearcher, researcherRegistryPath } from '../kb/researcherRegistry';
import { buildResearcherViews, isEgressTier, isResearcherTemplate, defaultEgressFor, researcherConfigAuditEvents } from '../kb/researchersPanel';
import { runResearcher } from '../kb/researchRun';
import { ResearcherScheduler } from '../kb/researcherScheduler';
import { IntakeScheduler, selectIntakeFn } from '../kb/intakeScheduler';
import { WatchScheduler } from '../kb/watchScheduler';
import { readWatchRegistry, writeWatchRegistry, upsertWatchFolder, patchWatchFolder, watchRegistryPath } from '../kb/watchRegistry';
import { checkWatchLoopSafe, isSafeWatchId, DEFAULT_WATCH_SCOPE, DEFAULT_WATCH_SENSITIVITY, WATCH_MAX_DEPTH_CAP } from '../kb/watchConnectors';
import { buildWatchFolderViews } from '../kb/watchPanel';
import { readIntakeRegistry, upsertIntakeConnector, patchIntakeConnector, intakeRegistryPath } from '../kb/intakeRegistry';
import { runIntakeConnector } from '../kb/intakeRun';
import { DEFAULT_INTAKE_SCOPE, DEFAULT_INTAKE_SENSITIVITY, type IntakeConnectorConfig } from '../kb/intakeConnectors';
import { buildIntakeConnectorViews, isIntakeConnectorType, clampMaxItems, intakeConfigAuditEvents } from '../kb/intakeSourcingPanel';
import type { WatchFolderView, WatchFolderPatch, IntakeConnectorView, IntakeConnectorConfigPatch, RunIntakeConnectorResult } from '../kb/types';
import { isSafeGhRepo } from '../kb/ghRead';
import { DEFAULT_RESEARCHER_BUDGET, dedupKeyFor, researchWhatFor, clampToolCalls, clampTimeoutMs, clampMaxDepth, clampOrientBudget, type ResearchRequest, type ResearcherConfig } from '../kb/researchers';
import { ulid, dateShard, isUlid } from '../kb/ulid';
import { setSensitivityOverride, sensitivityOverridesPath } from '../kb/sensitivityOverride';
import { readSourceSensitivities, type SourceSensitivity } from '../kb/sensitivityRead';
import { applySensitivityOverrideToSourceMd } from '../kb/sourceDoc';
import { buildRecallOutput } from '../kb/outputDoc';
import { DEFAULT_POSTURE, type JobBehavior, type JobConfig, type JournalEntry } from '../kb/jobs';
import type { Review } from '../kb/reviews';
import type { AuditEvent } from '../kb/audit';
import type { AskResult } from '../kb/recall';
import type { FullReplayResult, JobView, JobConfigPatch, RunJobResult, InstanceSettings, AgentView, ResearcherView, ResearcherConfigPatch, ResearcherLastRun, RunResearcherResult, SaveRecallOutputResult, PipelineControlRequest, PipelineControlResult } from '../kb/types';
import { lastRunFromEvent } from '../kb/researchersPanel';

/** Per-drain concurrency cap for decompose + claims (ORCH-17/18). Connect + archive stay cap=1.
 *  Module-scoped so the Status roster (SPEC-0032 VIZ-2) can mark the active draining batch. */
const STAGE_CAP = 3;

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
  researchers: ResearcherScheduler; // SPEC-0028: wakes scheduled researchers (standing passes via ingest)
  intake: IntakeScheduler; // SPEC-0041: wakes proactive-intake connectors (feed pulls → primary sources)
  watch: WatchScheduler; // SPEC-0037: live folder watchers (stable files → primary sources, non-destructive)
  lock: Mutex;
  log: DevLog; // the vault dev-log — reused by Run-now so a researcher failure is logged (#160)
}

let active: ActivePipeline | null = null;

/** The active vault's `.kb/cache` dir — where OBS-21 writes a heap snapshot (gitignored), or null
 *  when no vault is open (the sampler then skips the snapshot). Passed to the telemetry glue. */
export function activeSnapshotDir(): string | null {
  return active ? path.join(active.vaultPath, '.kb', 'cache') : null;
}

/** Start every active stage's poke/sweep loop. The SINGLE source of truth for "which stages run"
 *  — both `startPipeline` and `fullReplay`'s resume call this, so a replay can never diverge from
 *  normal startup (e.g. start a stage that startup deliberately leaves dormant). */
function startActiveStages(a: ActivePipeline): void {
  a.orch.start();
  a.decompose.start();
  a.connect.start();
  a.claims.start();
  a.jobs.start(); // SPEC-0023: the autonomous-job scheduler tick (named-preset cadence)
  a.researchers.start(); // SPEC-0028: the scheduled-researcher tick (standing external research)
  a.intake.start(); // SPEC-0041: the proactive-intake tick (scheduled feed pulls → primary sources)
  a.watch.start(); // SPEC-0037: live folder watchers (startup reconcile + chokidar stable-file events)
}

/** Stop every stage's sweep loop (shutdown, vault switch, or pre-replay pause). */
function stopAllStages(a: ActivePipeline): void {
  a.orch.stop();
  a.decompose.stop();
  a.connect.stop();
  a.claims.stop();
  a.jobs.stop();
  a.researchers.stop();
  a.intake.stop();
  a.watch.stop(); // SPEC-0037: close all live folder watchers
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

  // OBS-1/2: per-vault diagnostic dev-log (<vault>/.kb/cache/logs/, gitignored, never promoted).
  // Passed to every stage so failures land here with their cause (OBS-3/4); also captures the
  // worktree-provision failure below — the silent-stall cause that motivated SPEC-0030.
  // OBS-10: verbosity comes from the Instance config (Settings; default info, debug to troubleshoot).
  // The config lives on the persistent `staging` worktree; read best-effort (absent first-run → info).
  // A level change applies on the next pipeline start (vault switch / app restart).
  const stagingInstance = await readInstanceConfig(path.join(vaultPath, '.kb', 'cache', 'worktrees', 'staging'));
  // OBS-18: the breadcrumb observer records the last {stage,runId,itemId} a pipeline line carried, so
  // a crash handler can name what we were mid-flight on. Best-effort + never throws into logging.
  const log = createVaultDevLog(vaultPath, { level: stagingInstance.devLogLevel, onEmit: breadcrumbObserver });
  // OBS-12/13: per-vault latency tracer (<vault>/.kb/cache/spans.jsonl, never promoted). Threaded
  // into every stage so each per-item `stage.run` span + its `copilot.invoke` child are recorded;
  // the perf index (perfIndex.ts) aggregates them. Spans also mirror to the dev log at `debug`.
  const tracer = createVaultTracer(vaultPath, { log });
  const startedAt = Date.now();
  let stagingWt: string;
  try {
    stagingWt = await ensureStagingWorktree(vaultPath); // working surface (on `staging`)
  } catch (err) {
    log.child({ scope: 'pipeline' }).error('startup.worktree-provision-failed', { itemId: vaultPath, err });
    throw err; // unchanged behavior — but no longer silent
  }
  // ORCH-27 STARTUP-RECONCILE: heal a STALE canonical `index.lock` left by a prior crash/timed-out op
  // BEFORE any stage drains — otherwise that orphaned lock makes every advance fatal (the #256 wedge).
  // At startup no advance is in flight, so a present lock is never our live op; the triple-gate still
  // refuses to clear a genuinely-live external lock (fail safe). Best-effort: a heal failure (or a
  // kept live lock) must never block startup — the draining advance will surface a still-held lock.
  await reconcileStaleIndexLock(stagingWt, {
    isLiveInProcHolder: () => hasLiveIndexHolder(stagingWt),
    log: log.child({ scope: 'lock' }),
  }).catch((err) => log.child({ scope: 'lock' }).error('startup.lock-reconcile-failed', { itemId: vaultPath, err }));
  // The shared serialized canonical writer for this vault (§5). The watchdog logs a loud `lock.stuck`
  // (scope `lock`) + flips the OBS-7 `stuck` flag if any section is held past the threshold — so a
  // deadlocked/hung critical section surfaces (named by its label) instead of silently wedging (#163).
  const lock = new Mutex({ log: log.child({ scope: 'lock' }) });
  // The promotion gate: publish the evergreen subset staging→main, serialized under the lock
  // (SPEC-0021 STAGING-3/4). A stage runs it after a drain that changed an evergreen path
  // (archive→sources; connect→entities), so `main` tracks the resolved graph.
  const promoteEvergreen = async (): Promise<void> => {
    await promote(vaultPath);
  };
  const orch = new Orchestrator(stagingWt, makeCopilotDecider(), lock, promoteEvergreen, undefined, log, tracer);
  // The four stages run on the staging worktree (root-agnostic) and serialize their canonical
  // advances through the one shared lock (§5). Pipeline order is Decompose→Connect→Claims
  // (SPEC-0020 reorder): Decompose emits candidates, Connect resolves them into evergreen
  // `entities/` (carrying source-dir provenance Claims can read), Claims attaches claims to the
  // resolved graph. They drain independently; the lock keeps their staging ff-advances from
  // racing. Connect + Claims each carry the promotion gate as their afterDrain so resolved
  // entities and their claims become visible on `main` (the archivist already promotes sources/).
  // Per-stage concurrency cap (ORCH-20 / dogfood #4): >1 lets a stage run that many items' cognition
  // concurrently, cutting wall-time on a backlog (claims/decompose dominate it). The process-wide
  // `copilotConcurrency` semaphore bounds the TOTAL in-flight copilot subprocesses across all stages
  // + jobs + researchers, so a higher cap can never fan out past the global ceiling. Hardcoded for
  // now; a per-Instance setting is the tracked fast-follow (Control Panel / instance.json). Connect
  // stays cap=1 until its ephemeral-worktree migration (Phase 2). (STAGE_CAP is module-scoped.)
  const decompose = new DecomposeStage(stagingWt, makeDecomposeDecider(), lock, undefined, STAGE_CAP, log, tracer);
  const connect = new ConnectStage(stagingWt, makeConnectDecider(), lock, undefined, promoteEvergreen, log, tracer);
  // Claims' afterDrain promotes the new claims, then pokes Connect: now that the entity's claims
  // carry `relatesTo` hints, Connect's link-promotion pass turns them into `[[wikilinks]]`
  // (CONNECT-12) and promotes the linked nodes. (Connect's own 30s sweep is the backstop.)
  const claims = new ClaimsStage(
    stagingWt,
    makeClaimsDecider(),
    lock,
    undefined,
    async () => {
      await promoteEvergreen();
      void connect.poke();
    },
    STAGE_CAP,
    log,
    tracer,
  );
  // The autonomous-job scheduler (SPEC-0023): wakes registered jobs on their named-preset cadence,
  // each a bounded, single-flight pass in its own worktree sharing the canonical-writer lock (a
  // job's ff-advance never races a stage's; ORCH-18) and the promotion gate (evergreen job outputs
  // reach `main`). Jobs run concurrently with the live pipeline (ORCH-17) — never blocking
  // capture/Enrich. Inert until the Principal enables a job in the registry.
  const jobs = new JobScheduler(stagingWt, resolveJobBehavior, lock, promoteEvergreen, log);
  // SPEC-0028 RESEARCH-2/3: the researcher tick. Each tick first runs an inline sweep (routes any
  // pending `research-request` signals a stage emitted through the dedup dispatcher), then a standing
  // pass for every due scheduled researcher. Both execute via runResearcher — output is a cited
  // secondary source via the ingest path (NOT the JobBehavior write-sink — Option (a), JOBS-10
  // intact). The cognition is the Web SDK adapter behind the seam (egress-gated + SSRF-safe), wired
  // with the resolved BYOA copilot cliPath so it runs in the packaged app, and the dev-log so a
  // session failure is logged + surfaced as `research-failed` (#160), not a silent no-finding.
  // Reaching outside the KB is read-only-world (AUTO-6).
  // Wire the resolved BYOA copilot cliPath + the dev-log into BOTH researcher entry points via the one
  // shared seam (#160 / BUG #65): without cliPath the packaged app can't spawn copilot → the SDK throws.
  const researchers = new ResearcherScheduler(stagingWt, researchDepsOptions(log), lock, log);
  // SPEC-0041 INTAKE: the proactive-intake tick. Each tick pulls every due connector's feed (RSS in
  // Slice 1; M365-mail in Slice 2) and writes new items as immutable PRIMARY sources via the ingest
  // path (origin:'external') — reusing the JOBS scheduling shape but NOT the JobBehavior write-sink
  // (the researcherScheduler seam; JOBS-10 intact). Read-only w.r.t. the world (INTAKE-7). Inert
  // until the Principal registers + enables a connector in `.kb/intake/registry.json`.
  const intake = new IntakeScheduler(stagingWt, {}, log);
  // SPEC-0037 WATCH: live folder watchers. Each enabled, loop-safe folder gets a startup reconcile +
  // a chokidar watcher whose stable-file events drive a non-destructive copy → INGEST. The loop-guard
  // checks watched folders against the REAL vault root (vaultPath), never staging. Inert until the
  // Principal registers + enables a folder in `.kb/watch/registry.json`.
  const watch = new WatchScheduler(stagingWt, vaultPath, log);
  active = { vaultPath, stagingWt, orch, decompose, connect, claims, jobs, researchers, intake, watch, lock, log };
  const readyMs = Date.now() - startedAt; // when the Jobs/read IPC went live — independent of the reap
  // #135 cascade recovery: at boot no ephemeral per-item worktree is legitimately in flight, so reap
  // any leaked `<stage>-<ULID>` worktrees + their `kb/*-work-*` branches left by a crash/kill (the
  // poison-loop's leak that degraded staging + wedged the Jobs UI). Best-effort. Runs AFTER `active`
  // is set — so the read-only IPC (listJobs, getState) is live immediately and the reap no longer
  // strands the Jobs UI behind an O(leaked-N) sequence of git spawns — but BEFORE startActiveStages,
  // so live stages can't race the cleanup by spawning fresh ephemeral worktrees mid-sweep.
  const reapStartedAt = Date.now();
  const reaped = await reapEphemeralWorktrees(stagingWt, log.child({ scope: 'pipeline' })).catch((err) => {
    log.child({ scope: 'pipeline' }).warn('startup.worktree-reap-failed', { itemId: vaultPath, err });
    return { worktrees: 0, branches: 0 };
  });
  // OBS: startup latency, split so a slow reap (its O(leaked-N) git spawns) is attributable and never
  // misread as a slow vault open. `readyMs` is the UI-live time; `reapMs` is the off-UI-path cleanup.
  log.child({ scope: 'pipeline' }).info('startup.ready', {
    itemId: vaultPath,
    readyMs,
    reapMs: Date.now() - reapStartedAt,
    reapedWorktrees: reaped.worktrees,
    reapedBranches: reaped.branches,
  });
  startActiveStages(active); // single source of truth for which loops run (shared with fullReplay)
  return orch;
}

/** The archivist orchestrator for the loaded KB, or null if none is active. */
export function activePipeline(): Orchestrator | null {
  return active?.orch ?? null;
}

/** The active vault's `staging` worktree — where the full working-zone audit lives (per-item
 *  audit.jsonl, connect/, .kb/jobs, .kb/cache/ask, .kb/audit.jsonl), a superset of the evergreen archive
 *  promoted to `main`. The read root for the Audit & Activity views (SPEC-0029). Null if no active KB. */
export function activeStagingRoot(): string | null {
  return active?.stagingWt ?? null;
}

/** Newest of a set of ISO timestamps (ignoring undefined/unparseable). Undefined if none. */
function newestTs(candidates: Array<string | undefined>): string | undefined {
  let best: string | undefined;
  let bestMs = -Infinity;
  for (const ts of candidates) {
    if (!ts) continue;
    const ms = Date.parse(ts);
    if (Number.isFinite(ms) && ms > bestMs) {
      bestMs = ms;
      best = ts;
    }
  }
  return best;
}

/** List the live worktrees under `<vault>/.kb/cache/worktrees/` + the branch each is on (OBS-7). */
async function listWorktrees(vaultPath: string): Promise<WorktreeInfo[]> {
  const root = path.join(vaultPath, '.kb', 'cache', 'worktrees');
  let entries: import('node:fs').Dirent[];
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: WorktreeInfo[] = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const wt = path.join(root, e.name);
    let branch: string | undefined;
    try {
      // #135 cascade: time-bounded so a broken/leaked worktree can't hang the read-only status path.
      branch = (await boundedGit(wt).revparse(['--abbrev-ref', 'HEAD'])).trim();
    } catch {
      /* not a worktree / detached / timed-out — leave branch undefined */
    }
    out.push({ path: path.join('.kb', 'cache', 'worktrees', e.name), ...(branch ? { branch } : {}) });
  }
  return out;
}

/**
 * Assemble the live Pipeline Status view-model for the active KB (SPEC-0030 OBS-5/6/7/11/15), or
 * null when no KB is open. Read-only (OBS-9): gathers per-stage queue depths + busy flags, the
 * canonical-writer lock state, recent dev-log errors, the perf index, and the worktrees, then hands
 * them to the pure {@link assemblePipelineStatus}. Queues + perf read the `staging` worktree (where
 * the pipeline operates); the dev log + worktrees read the vault path.
 */
export async function pipelineStatusForActive(): Promise<PipelineStatusView | null> {
  if (!active) return null;
  const { vaultPath, stagingWt, lock, orch, decompose, connect, claims } = active;
  const [archiveQ, decompQ, connectQ, claimsQ, archiveStatus, recentRaw, perf, worktrees, claimsSetAside, connectSetAside, conversion] = await Promise.all([
    readQueue(stagingWt),
    readDecomposeQueue(stagingWt),
    readConnectQueue(stagingWt),
    readClaimsQueue(stagingWt),
    orch.status(),
    readRecentDevLogEntries(vaultPath, { limit: 25 }),
    loadPerfIndex(stagingWt),
    listWorktrees(vaultPath),
    listSetAsideItems(stagingWt), // OBS-17: claims poison items (canonical claims-path reader, CLAIMS-20)
    listConnectSetAsideItems(stagingWt), // OBS-17: connect poison blocks (CLAIMS-20 connect twin, #157)
    readConversionCounts(stagingWt, vaultPath), // SPEC-0032 VIZ-3: funnel counts (staging state + promoted on main)
  ]);
  // Union every stage's set-aside items into the view (claims + connect; future stages append here).
  // Each stage maps its item to the generic {itemId, name, failures, rounds} source shape.
  const setAsideItems = [
    ...toSetAsideViews(claimsSetAside.map((i) => ({ itemId: i.entityId, name: i.name, failures: i.failures, rounds: i.rounds })), 'claims'),
    ...toSetAsideViews(connectSetAside.map((i) => ({ itemId: i.blockKey, name: i.name, failures: i.failures, rounds: i.rounds })), 'connect'),
  ];

  const recentErrors: RecentError[] = recentRaw.map((e) => ({
    ts: e.ts,
    level: e.level,
    event: e.event,
    ...(typeof e.scope === 'string' ? { stage: e.scope } : {}),
    ...(typeof e.itemId === 'string' ? { itemId: e.itemId } : {}),
    ...(typeof e.runId === 'string' ? { runId: e.runId } : {}),
    ...(e.err?.message ? { message: e.err.message } : {}),
  }));
  const setAsideFor = (stage: string): number =>
    recentErrors.filter((e) => e.stage === stage && e.event.includes('setaside')).length;
  // #163: a stage is errored only if it has a FRESH error — a recovered stage's error ages out
  // (was unbounded: any error in the last-N log lines kept the badge red forever).
  const nowMs = Date.now();
  const hasErrorFor = (stage: string): boolean => deriveStageError(recentErrors, stage, nowMs);

  const stages: StageInput[] = [
    { stage: 'archive', queueDepth: archiveQ.length, setAside: setAsideFor('archive'), busy: orch.busy(), hasError: hasErrorFor('archive'), ...(archiveStatus.processing ? { currentItem: archiveStatus.processing } : {}) },
    { stage: 'decompose', queueDepth: decompQ.length, setAside: setAsideFor('decompose'), busy: decompose.busy(), hasError: hasErrorFor('decompose') },
    { stage: 'connect', queueDepth: connectQ.length, setAside: setAsideFor('connect'), busy: connect.busy(), hasError: hasErrorFor('connect') },
    { stage: 'claims', queueDepth: claimsQ.length, setAside: setAsideFor('claims'), busy: claims.busy(), hasError: hasErrorFor('claims') },
  ];

  // SPEC-0032 VIZ-2: in-flight carriages — each stage's queue items, `active` = the draining batch
  // (`busy && index < cap`; the drain processes `queue[0..cap)`). Archive's active item is its
  // `processing` (prepended; cap=1); connect drains 1 block at a time (cap=1); decompose/claims = STAGE_CAP.
  const inFlight = buildInFlightRoster([
    {
      stage: 'archive',
      items: [...(archiveStatus.processing ? [{ id: archiveStatus.processing }] : []), ...archiveQ.map((id) => ({ id }))],
      busy: orch.busy(), cap: 1, since: archiveStatus.updatedAt ?? null,
    },
    { stage: 'decompose', items: decompQ.map((id) => ({ id })), busy: decompose.busy(), cap: STAGE_CAP, since: decompose.currentSince() },
    { stage: 'connect', items: connectQ.map((cs) => ({ id: cs.blockKey })), busy: connect.busy(), cap: 1, since: connect.currentSince() },
    { stage: 'claims', items: claimsQ.map((rel) => ({ id: path.basename(rel, '.md') })), busy: claims.busy(), cap: STAGE_CAP, since: claims.currentSince() },
  ]);

  // Last activity: the newest of the archivist status, the spans-file mtime (any stage's last span),
  // and the newest dev-log entry — so a quietly-working pipeline isn't mistaken for stalled (OBS-11).
  const spansMtime = perf.source ? new Date(perf.source.mtimeMs).toISOString() : undefined;
  const lastActivity = newestTs([archiveStatus.updatedAt ?? undefined, spansMtime, recentErrors[0]?.ts]);

  // OBS-22: the memory/health readout (current RSS/heap + leak trend + last crash breadcrumb).
  const health = await telemetryHealth();

  return assemblePipelineStatus({ stages, lock: lock.state(), recentErrors, worktrees, perf, setAsideItems, conversion, inFlight, health, ...(lastActivity ? { lastActivity } : {}) });
}

/**
 * OBS-17 — act on a set-aside (poison) item from the Status view: **retry** (re-enqueue to re-derive)
 * or **dismiss** (retire from the recoverable list). Stage-dispatched (claims + connect today); a new
 * stage is one more branch here — the planner + view stay stage-agnostic. Each branch builds the
 * stage's *live* `{id, handle, label}` list (the `handle` is **server-derived**, never the renderer's
 * `itemId` — the #153/#157 trust boundary) and binds the stage-owned primitives, which write under
 * the shared canonical-writer lock. Retry pokes the stage drain so the item re-processes promptly.
 * Best-effort + honest: a stale/already-recovered item returns `{ok:false}` with a reason, never throws.
 */
export async function pipelineControlForActive(req: PipelineControlRequest): Promise<PipelineControlResult> {
  const a = active;
  if (!a) return { ok: false, message: 'No knowledge base open.' };
  try {
    let targets: SetAsideTarget[];
    let doRetry: (handle: string) => Promise<void>;
    let doDismiss: (handle: string) => Promise<void>;
    let pokeAfterRetry: () => void;
    if (req.stage === 'claims') {
      targets = (await listSetAsideItems(a.stagingWt)).map((i) => ({ id: i.entityId, handle: i.entityRel, label: i.name || i.entityId }));
      doRetry = (h) => retryClaimsItem(a.stagingWt, h, a.lock);
      doDismiss = (h) => dismissClaimsItem(a.stagingWt, h, a.lock);
      pokeAfterRetry = () => void a.claims.poke();
    } else if (req.stage === 'connect') {
      targets = (await listConnectSetAsideItems(a.stagingWt)).map((i) => ({ id: i.blockKey, handle: i.blockKey, label: i.name || i.blockKey }));
      doRetry = (h) => retryConnectItem(a.stagingWt, h, a.lock);
      doDismiss = (h) => dismissConnectItem(a.stagingWt, h, a.lock);
      pokeAfterRetry = () => void a.connect.poke();
    } else {
      return { ok: false, message: `Recovery for the “${req.stage}” stage isn’t supported yet.` };
    }
    // Plan against the live list (pure): validate the action + resolve itemId→handle, or a no-op reason.
    const plan = planSetAsideAction(targets, req);
    if ('error' in plan) return { ok: false, message: plan.error };
    if (req.action === 'retry') {
      await doRetry(plan.handle);
      pokeAfterRetry(); // re-drain promptly (don't wait for the periodic sweep)
      return { ok: true, message: `Retrying ${plan.label}.` };
    }
    await doDismiss(plan.handle);
    return { ok: true, message: `Dismissed ${plan.label}.` };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
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
  // Resume the parked item PROMPTLY (REVIEW-6) by poking the stage that raised the review (#46).
  if (result.ok) {
    const resume = reviewResumeStage(result.stage);
    if (resume === 'claims') void active.claims.poke();
    else if (resume === 'connect') void active.connect.poke();
  }
  // SPEC-0024 REFLECT-5/7: if this Review was a Reflect-proposed consolidation that the Principal
  // just APPROVED, execute the merge now — the ONLY point a Reflect destructive merge ever runs
  // (never autonomously). `executeApprovedConsolidation` self-gates (a safe no-op for any non-
  // approved / non-consolidation review), so calling it for every answered review is correct; we
  // promote ONLY when it actually merged, so the loser-node deletions mirror to `main` via the
  // deletion-aware gate (STAGING-10). Promote under the shared lock, like the stages' afterDrain.
  if (result.ok) {
    const consolidation = await executeApprovedConsolidation(active.stagingWt, id, active.lock);
    if (consolidation.executed) await active.lock.run(() => promote(active.vaultPath), 'consolidation:promote');
  }
  // SPEC-0028 RESEARCH-11 (D7 fast-follow): if this Review was a CONFIRMED research depth-limit
  // escalation, continue the chain one level deeper now — so the "Continue researching X?" control
  // actually continues (no dead affordance). Self-gating (no-op for any other review), so it's safe to
  // call unconditionally. Uses the same cliPath+dev-log wiring as the scheduler/Run-now (#160).
  if (result.ok) {
    const resumed = await resumeApprovedResearchEscalation(active.stagingWt, id, researchDepsOptions(active.log));
    if (resumed.resumed) active.log.child({ scope: 'research' }).info('research.resumed-after-confirm', { reviewId: id, sources: resumed.sourceIds?.length ?? 0 });
  }
  return result;
}

/**
 * Save a grounded recall answer as a KB Output (SPEC-0026 ASK-6). Writes `outputs/recall/<ulid>.md`
 * on the `staging` worktree, commits + promotes to `main` under the canonical-writer lock (the
 * evergreen gate — never the vault root directly), then emits a conforming `output` audit event
 * (AUDIT-2/11 — a Principal-initiated mutation). The Output is **inert** (F2): it lives in `outputs/`
 * with `generated: recall`, so the autonomous stages (which queue off `sources/`) never re-enrich it.
 * An ungrounded answer is allowed (F4) — the doc carries `grounded:false` + a prominent banner.
 */
export async function saveRecallOutput(result: AskResult): Promise<SaveRecallOutputResult> {
  const a = active;
  if (!a) return { ok: false, message: 'No active knowledge base.' };
  if (typeof result?.answer !== 'string' || result.answer.trim().length === 0) {
    return { ok: false, message: 'Nothing to save — the answer is empty.' };
  }
  const root = a.stagingWt;
  const id = ulid();
  const built = buildRecallOutput(result, id, new Date().toISOString());
  await a.lock.run(async () => {
    const abs = path.join(root, built.rel);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, built.markdown, 'utf8');
    const git = boundedGit(root); // #163: bounded — runs under the canonical-writer lock
    await git.add(built.rel);
    await git.commit(`recall: save output ${id}`);
    await promote(a.vaultPath); // mirror the new outputs/ note to main (evergreen, deletion-aware gate)
  }, 'recall-output:save');
  // Conforming audit — appends to the gitignored cross-cutting control log (not canonical); fine off-lock.
  await appendAuditEvent(root, {
    actor: 'output',
    eventType: 'recall-output-saved',
    subjects: {},
    payload: { rel: built.rel, question: result.question, grounded: result.grounded, citations: result.citations.length, why: 'Principal saved a recall answer' },
  });
  return { ok: true, rel: built.rel, message: `Saved to ${built.rel}` };
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
  const instance = await readInstanceConfig(root); // a catalog-only job displays its inherited posture
  // Gather the newest journal entry for every job we will show (catalog types ∪ registered ids).
  const ids = new Set<string>([...JOB_CATALOG.map((c) => c.type), ...registry.map((j) => j.id)]);
  const lastEntryByJobId: Record<string, JournalEntry | undefined> = {};
  for (const id of ids) {
    const journal = await readJournal(root, id);
    lastEntryByJobId[id] = journal[journal.length - 1];
  }
  return buildJobViews(JOB_CATALOG, registry, lastEntryByJobId, instance.autonomyDefault);
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
      // New job: an explicit per-job posture wins; otherwise inherit the Instance default (AUTO-12
      // cascade — `resolveJobPosture` is the single swap point if the ruling lands differently).
      const instanceCfg = await readInstanceConfig(root);
      await upsertJob(root, {
        id: clean.id,
        type: clean.type,
        enabled: clean.enabled ?? false,
        schedule: clean.schedule ?? 'off',
        posture: resolveJobPosture(instanceCfg.autonomyDefault, clean.posture),
      });
    }
    await commitRegistryChange(root, summarizeJobChange(clean));
  }, 'job-config:write');
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
      const instanceCfg = await readInstanceConfig(root);
      await upsertJob(root, { id, type: entry.type, enabled: false, schedule: 'off', posture: resolveJobPosture(instanceCfg.autonomyDefault, undefined) });
      await commitRegistryChange(root, `seed job ${id} for run-now`);
    }, 'job:seed-for-run-now');
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

// --- Control Panel · Settings + Agents (SPEC-0027 PANEL-3/5) ---

/** The per-Instance settings for the active KB (PANEL-5). No active KB → safe defaults. */
export async function getActiveInstanceSettings(): Promise<InstanceSettings> {
  if (!active) return defaultInstanceConfig();
  return readInstanceConfig(active.stagingWt);
}

/**
 * Persist the per-Instance settings (PANEL-5/6): write `.kb/instance.json` + git-commit on `staging`
 * under the lock (durability), then emit a conforming `panel` audit event when the autonomy default
 * changed (PANEL-7 / AUDIT-2/11 — `→ Autonomous` is a risky, audited change). An invalid posture is
 * refused (fail-safe). Takes effect immediately (new jobs inherit it via `resolveJobPosture`).
 */
export async function setActiveInstanceSettings(settings: InstanceSettings): Promise<InstanceSettings> {
  if (!active) return defaultInstanceConfig();
  const root = active.stagingWt;
  if (!isAutonomyPosture(settings.autonomyDefault)) return readInstanceConfig(root); // reject invalid
  let prior: InstanceSettings = defaultInstanceConfig();
  let devLogLevel: DevLogLevel = DEFAULT_DEV_LOG_LEVEL;
  let quickCaptureAccelerator: string = DEFAULT_QUICK_CAPTURE_ACCELERATOR;
  await active.lock.run(async () => {
    prior = await readInstanceConfig(root);
    // OBS-10: keep a valid level. Server-side merge (QA-2 hardening / the #102 lesson): an
    // omitted/invalid level PRESERVES the prior — no caller can clobber a field by omission.
    devLogLevel = (DEV_LOG_LEVELS as readonly string[]).includes(settings.devLogLevel) ? settings.devLogLevel : prior.devLogLevel;
    // QCAP-6: preserve-on-omission (the #102 merge lesson) — an empty/omitted accelerator keeps prior.
    quickCaptureAccelerator =
      typeof settings.quickCaptureAccelerator === 'string' && settings.quickCaptureAccelerator.trim().length > 0
        ? settings.quickCaptureAccelerator
        : prior.quickCaptureAccelerator;
    await writeInstanceConfig(root, { autonomyDefault: settings.autonomyDefault, devLogLevel, quickCaptureAccelerator });
    await commitControlFile(root, instanceConfigPath(root), `instance autonomyDefault=${settings.autonomyDefault} devLogLevel=${devLogLevel} quickCaptureAccelerator=${quickCaptureAccelerator}`);
  }, 'instance-settings:write');
  // QCAP-6: apply a changed hotkey live (no restart) — conflict-aware via the agent; degrades to the
  // menubar if the new accelerator clashes (QCAP-9). No-op when running headless without an agent.
  if (prior.quickCaptureAccelerator !== quickCaptureAccelerator) {
    getQuickCaptureAgent()?.setAccelerator(quickCaptureAccelerator);
    await appendAuditEvent(root, {
      actor: 'panel',
      eventType: 'instance-config-change',
      subjects: {},
      payload: { field: 'quickCaptureAccelerator', from: prior.quickCaptureAccelerator, to: quickCaptureAccelerator, why: 'Principal change via Control Panel' },
    });
  }
  if (prior.autonomyDefault !== settings.autonomyDefault) {
    await appendAuditEvent(root, {
      actor: 'panel',
      eventType: 'instance-config-change',
      subjects: {},
      payload: { field: 'autonomyDefault', from: prior.autonomyDefault, to: settings.autonomyDefault, why: 'Principal change via Control Panel' },
    });
  }
  // OBS-10 + AUDIT-2: audit a verbosity change too — `→ debug` is security-relevant (it logs
  // redaction-protected `sensitive` fields verbatim), so it's never silent (QA-2 #2).
  if (prior.devLogLevel !== devLogLevel) {
    await appendAuditEvent(root, {
      actor: 'panel',
      eventType: 'instance-config-change',
      subjects: {},
      payload: { field: 'devLogLevel', from: prior.devLogLevel, to: devLogLevel, why: 'Principal change via Control Panel' },
    });
  }
  return readInstanceConfig(root);
}

/** The librarian/stage agents for observe-only display (PANEL-3): the static catalog overlaid with
 *  the resolved model (env-requested or Copilot default) + live running/idle status (PANEL-9). */
export async function listAgentsForActive(): Promise<AgentView[]> {
  return buildAgentViews(AGENT_CATALOG, {
    requestedModel: process.env.KB_COPILOT_MODEL || undefined,
    pipelineActive: active !== null,
  });
}

// --- Control Panel · Watched folders (SPEC-0037 WATCH-9; over the watch registry) ---

/** List the active KB's watched folders for the unified Sources view (WATCH-9): config + the live
 *  `watching` flag (from the scheduler) + each folder's newest `watch` audit folded as `lastEvent`.
 *  Reads `staging` (registry + audit live there). No active KB → empty (PANEL-9 degrade). */
export async function listWatchFoldersForActive(): Promise<WatchFolderView[]> {
  if (!active) return [];
  const root = active.stagingWt;
  const registry = await readWatchRegistry(root, active.log);
  const events = await readEvents(root, { actors: ['watch'] }); // newest-first
  const lastByWatch: Record<string, (typeof events)[number] | undefined> = {};
  for (const f of registry) lastByWatch[f.id] = events.find((e) => e.subjects.watchId === f.id);
  return buildWatchFolderViews(registry, active.watch.watchingIds(), lastByWatch);
}

/**
 * Apply a Sources-view edit to a watched folder (WATCH-9) + return the refreshed list. Untrusted IPC
 * input is validated at this boundary; a `folderPath` being set/changed is **loop-guarded** against the
 * REAL vault (WATCH-10) — a loop-unsafe folder (the vault/.kb/.git or an ancestor) is REFUSED and never
 * persisted (the change is dropped, fail-safe). The write + git commit run under the shared lock
 * (durability); a conforming `panel` audit records the change (AUDIT-2); then the scheduler re-syncs so a
 * newly-enabled folder starts watching (and a disabled one stops).
 */
export async function setActiveWatchFolder(patch: WatchFolderPatch): Promise<WatchFolderView[]> {
  if (!active) return [];
  const root = active.stagingWt;
  if (typeof patch.id !== 'string' || patch.id.length === 0) return listWatchFoldersForActive();

  const clean: WatchFolderPatch = { id: patch.id };
  if (typeof patch.enabled === 'boolean') clean.enabled = patch.enabled;
  if (typeof patch.scope === 'string' && patch.scope.trim()) clean.scope = patch.scope.trim();
  if (typeof patch.sensitivity === 'string' && patch.sensitivity.trim()) clean.sensitivity = patch.sensitivity.trim();
  if (typeof patch.label === 'string') clean.label = patch.label;
  if (Array.isArray(patch.ignoreGlobs)) clean.ignoreGlobs = patch.ignoreGlobs.filter((g): g is string => typeof g === 'string');
  if (typeof patch.folderPath === 'string' && patch.folderPath.trim()) clean.folderPath = patch.folderPath.trim();
  // Slice-2 opt-ins (WATCH-12/14): coerce to safe values at the boundary — maxDepth clamped to [0, cap].
  if (typeof patch.recursive === 'boolean') clean.recursive = patch.recursive;
  if (typeof patch.maxDepth === 'number' && Number.isFinite(patch.maxDepth)) clean.maxDepth = Math.min(Math.max(0, Math.floor(patch.maxDepth)), WATCH_MAX_DEPTH_CAP);
  if (typeof patch.consume === 'boolean') clean.consume = patch.consume;

  // WATCH-10 loop-guard at the IPC boundary: a folderPath set/change must be loop-safe vs the REAL vault,
  // else REFUSE the whole change (never persist a folder that would re-ingest the vault into itself).
  if (clean.folderPath !== undefined) {
    const guard = await checkWatchLoopSafe(active.vaultPath, clean.folderPath);
    if (!guard.ok) {
      active.log.child({ scope: 'watch' }).warn('watch.config-refused', { watchId: clean.id, folderPath: clean.folderPath, reason: guard.reason });
      await appendAuditEvent(root, { actor: 'panel', eventType: 'watch-config-change', subjects: { watchId: clean.id }, payload: { refused: true, folderPath: clean.folderPath, reason: guard.reason, why: 'folder-watch loop-guard refused the folder (WATCH-10)' } });
      return listWatchFoldersForActive(); // fail-safe: nothing persisted
    }
  }

  let applied = false;
  await active.lock.run(async () => {
    const existing = (await readWatchRegistry(root)).find((f) => f.id === clean.id);
    if (existing) {
      await patchWatchFolder(root, clean.id, {
        ...(clean.enabled !== undefined ? { enabled: clean.enabled } : {}),
        ...(clean.folderPath !== undefined ? { folderPath: clean.folderPath } : {}),
        ...(clean.scope !== undefined ? { scope: clean.scope } : {}),
        ...(clean.sensitivity !== undefined ? { sensitivity: clean.sensitivity } : {}),
        ...(clean.label !== undefined ? { label: clean.label } : {}),
        ...(clean.ignoreGlobs !== undefined ? { ignoreGlobs: clean.ignoreGlobs } : {}),
        ...(clean.recursive !== undefined ? { recursive: clean.recursive } : {}),
        ...(clean.maxDepth !== undefined ? { maxDepth: clean.maxDepth } : {}),
        ...(clean.consume !== undefined ? { consume: clean.consume } : {}),
      });
    } else {
      // New watched folder requires a folderPath (already loop-guarded above).
      if (clean.folderPath === undefined) return;
      await upsertWatchFolder(root, {
        id: clean.id,
        folderPath: clean.folderPath,
        enabled: clean.enabled ?? false,
        scope: clean.scope ?? DEFAULT_WATCH_SCOPE,
        sensitivity: clean.sensitivity ?? DEFAULT_WATCH_SENSITIVITY,
        ...(clean.label !== undefined ? { label: clean.label } : {}),
        ...(clean.ignoreGlobs !== undefined ? { ignoreGlobs: clean.ignoreGlobs } : {}),
        ...(clean.recursive !== undefined ? { recursive: clean.recursive } : {}),
        ...(clean.maxDepth !== undefined ? { maxDepth: clean.maxDepth } : {}),
        ...(clean.consume !== undefined ? { consume: clean.consume } : {}),
      });
    }
    applied = true;
    await commitControlFile(root, watchRegistryPath(root), `watch ${clean.id} config change`);
  }, 'watch-config:write');

  if (applied) {
    await appendAuditEvent(root, { actor: 'panel', eventType: 'watch-config-change', subjects: { watchId: clean.id }, payload: { ...(clean.enabled !== undefined ? { enabled: clean.enabled } : {}), ...(clean.folderPath !== undefined ? { folderPath: clean.folderPath } : {}), ...(clean.recursive !== undefined ? { recursive: clean.recursive } : {}), ...(clean.maxDepth !== undefined ? { maxDepth: clean.maxDepth } : {}), ...(clean.consume !== undefined ? { consume: clean.consume } : {}), why: 'Principal edited a watched folder via Control Panel' } });
    await active.watch.refresh(); // start/stop live watchers to match the new config
  }
  return listWatchFoldersForActive();
}

/** Remove a watched folder (WATCH-9): drop it from the registry, audit the removal, and stop its live
 *  watcher. An unsafe id is a no-op (the registry guard would reject it anyway). */
export async function removeActiveWatchFolder(id: string): Promise<WatchFolderView[]> {
  if (!active) return [];
  if (!isSafeWatchId(id)) return listWatchFoldersForActive();
  const root = active.stagingWt;
  let removed = false;
  await active.lock.run(async () => {
    const folders = await readWatchRegistry(root);
    if (!folders.some((f) => f.id === id)) return;
    await writeWatchRegistry(root, folders.filter((f) => f.id !== id));
    removed = true;
    await commitControlFile(root, watchRegistryPath(root), `watch ${id} removed`);
  }, 'watch-config:remove');
  if (removed) {
    await appendAuditEvent(root, { actor: 'panel', eventType: 'watch-config-change', subjects: { watchId: id }, payload: { removed: true, why: 'Principal removed a watched folder via Control Panel' } });
    await active.watch.refresh(); // tear down the removed folder's live watcher
  }
  return listWatchFoldersForActive();
}

// --- Control Panel · Researchers (SPEC-0028 RESEARCH-15; over the researcher registry) ---

/** List the active KB's researchers with each one's last-run (from its newest `researcher` audit
 *  event). Reads `staging` (registry + audit live there). No active KB → empty (PANEL-9 degrade). */
export async function listResearchersForActive(): Promise<ResearcherView[]> {
  if (!active) return [];
  const root = active.stagingWt;
  const registry = await readResearcherRegistry(root);
  const events = await readEvents(root, { actors: ['researcher'] }); // newest-first
  const lastByResearcher: Record<string, AuditEvent | undefined> = {};
  for (const r of registry) lastByResearcher[r.id] = events.find((e) => e.subjects.researcherId === r.id);
  return buildResearcherViews(registry, lastByResearcher);
}

/**
 * Apply a Researchers-view config change (RESEARCH-15) + return the refreshed list. Untrusted IPC
 * input is validated at this boundary (template/egress/schedule/posture dropped unless known enums;
 * an unsafe `id` is rejected by the registry guard). The write + git commit run under the shared
 * lock (durability); then a conforming `panel` audit event records the change (PANEL-7-style).
 */
export async function setActiveResearcherConfig(patch: ResearcherConfigPatch): Promise<ResearcherView[]> {
  if (!active) return [];
  const root = active.stagingWt;
  if (typeof patch.id !== 'string' || patch.id.length === 0) return listResearchersForActive();

  // Validate untrusted IPC input into a `clean` patch (drop unknown enums; the rest is fail-safe).
  // apply + audit both use `clean`, so a dropped-invalid field is never recorded as applied
  // (QA-2 #81 follow-up — audit accuracy matters for the egress-relevant fields).
  const clean: ResearcherConfigPatch = { id: patch.id };
  if (typeof patch.enabled === 'boolean') clean.enabled = patch.enabled;
  if (isSchedulePreset(patch.schedule)) clean.schedule = patch.schedule;
  if (isAutonomyPosture(patch.posture)) clean.posture = patch.posture;
  if (isEgressTier(patch.egressTier)) clean.egressTier = patch.egressTier;
  if (isResearcherTemplate(patch.template)) clean.template = patch.template;
  if (typeof patch.label === 'string') clean.label = patch.label;
  if (typeof patch.prompt === 'string' && patch.prompt.trim()) clean.prompt = patch.prompt;
  if (typeof patch.scope === 'string' && patch.scope.trim()) clean.scope = patch.scope;
  if (typeof patch.repoPath === 'string' && patch.repoPath.trim()) clean.repoPath = patch.repoPath.trim();
  if (typeof patch.tenantId === 'string' && patch.tenantId.trim()) clean.tenantId = patch.tenantId.trim();
  // prRepo is owner/name — validated at the boundary (drop a flag-like/garbage value, never store it).
  if (typeof patch.prRepo === 'string' && isSafeGhRepo(patch.prRepo.trim())) clean.prRepo = patch.prRepo.trim();
  if (Array.isArray(patch.topics)) clean.topics = patch.topics;
  // Editable budget/timeout (RESEARCH-15/18, WS3): clamp valid numbers to the sane range; reject garbage
  // (non-numeric / ≤0 / non-integer calls) by dropping it (field unchanged). The allowlist is NOT editable.
  const cleanMaxCalls = clampToolCalls(patch.maxToolCalls);
  if (cleanMaxCalls !== undefined) clean.maxToolCalls = cleanMaxCalls;
  const cleanTimeout = clampTimeoutMs(patch.timeoutMs);
  if (cleanTimeout !== undefined) clean.timeoutMs = cleanTimeout;
  const cleanMaxDepth = clampMaxDepth(patch.maxDepth); // WS3 Slice-2: the chain-depth safety bound (RESEARCH-11)
  if (cleanMaxDepth !== undefined) clean.maxDepth = cleanMaxDepth;
  const cleanOrient = clampOrientBudget(patch.orientBudget); // RESEARCH-22 warm-start: non-egress awareness cap
  if (cleanOrient !== undefined) clean.orientBudget = cleanOrient;

  let prior: ResearcherConfig | undefined;
  let applied = false;
  await active.lock.run(async () => {
    const registry = await readResearcherRegistry(root);
    prior = registry.find((r) => r.id === clean.id);
    if (prior) {
      await patchResearcher(root, clean.id, {
        ...(clean.enabled !== undefined ? { enabled: clean.enabled } : {}),
        ...(clean.schedule !== undefined ? { schedule: clean.schedule } : {}),
        ...(clean.posture !== undefined ? { posture: clean.posture } : {}),
        ...(clean.egressTier !== undefined ? { egressTier: clean.egressTier } : {}),
        ...(clean.prompt !== undefined ? { prompt: clean.prompt } : {}),
        ...(clean.scope !== undefined ? { scope: clean.scope } : {}),
        ...(clean.topics !== undefined ? { topics: clean.topics } : {}),
        // WS3: maxToolCalls + maxDepth (Slice-2) merge into the existing budget (each preserved if unset);
        // timeoutMs is top-level.
        ...(clean.maxToolCalls !== undefined || clean.maxDepth !== undefined
          ? {
              budget: {
                ...prior.budget,
                ...(clean.maxToolCalls !== undefined ? { maxToolCalls: clean.maxToolCalls } : {}),
                ...(clean.maxDepth !== undefined ? { maxDepth: clean.maxDepth } : {}),
              },
            }
          : {}),
        ...(clean.timeoutMs !== undefined ? { timeoutMs: clean.timeoutMs } : {}),
        ...(clean.orientBudget !== undefined ? { orientBudget: clean.orientBudget } : {}), // RESEARCH-22 warm-start (top-level)
        // Template config: merge repoPath (Code) / tenantId (M365) into the existing config,
        // preserving other config keys.
        ...(clean.repoPath !== undefined || clean.tenantId !== undefined || clean.prRepo !== undefined
          ? {
              config: {
                ...(prior.config ?? {}),
                ...(clean.repoPath !== undefined ? { repoPath: clean.repoPath } : {}),
                ...(clean.tenantId !== undefined ? { tenantId: clean.tenantId } : {}),
                ...(clean.prRepo !== undefined ? { prRepo: clean.prRepo } : {}),
              },
            }
          : {}),
      });
    } else {
      // New researcher: derive a safe config from the (validated) template + defaults.
      const template = clean.template ?? 'custom';
      const egressTier = clean.egressTier ?? defaultEgressFor(template);
      clean.egressTier = egressTier; // record the actual created egress in the audit (from local-only)
      await upsertResearcher(root, {
        id: clean.id,
        template,
        label: clean.label,
        prompt: clean.prompt ?? `Research ${template} sources relevant to the request.`,
        egressTier,
        scope: clean.scope ?? 'global',
        budget: {
          ...DEFAULT_RESEARCHER_BUDGET,
          ...(clean.maxToolCalls !== undefined ? { maxToolCalls: clean.maxToolCalls } : {}),
          ...(clean.maxDepth !== undefined ? { maxDepth: clean.maxDepth } : {}),
        },
        ...(clean.timeoutMs !== undefined ? { timeoutMs: clean.timeoutMs } : {}),
        ...(clean.orientBudget !== undefined ? { orientBudget: clean.orientBudget } : {}),
        schedule: clean.schedule ?? 'off',
        posture: clean.posture ?? DEFAULT_POSTURE,
        enabled: clean.enabled ?? false,
        ...(clean.topics ? { topics: clean.topics } : {}),
        ...(clean.repoPath || clean.tenantId || clean.prRepo
          ? { config: { ...(clean.repoPath ? { repoPath: clean.repoPath } : {}), ...(clean.tenantId ? { tenantId: clean.tenantId } : {}), ...(clean.prRepo ? { prRepo: clean.prRepo } : {}) } }
          : {}),
      });
    }
    applied = true;
    await commitControlFile(root, researcherRegistryPath(root), `researcher ${clean.id} config change`);
  }, 'researcher-config:write');
  if (applied) {
    // Conforming `panel` audit: one event per changed behavior-relevant field (from→to), validated
    // values only — never a dropped-invalid field, never a no-op re-assert (QA-2 #81 follow-up).
    for (const event of researcherConfigAuditEvents(prior, clean)) await appendAuditEvent(root, event);
  }
  return listResearchersForActive();
}

/**
 * Manual "Run now" for a researcher (RESEARCH-15, "run-now to test") — a single on-demand pass via
 * the run-pass against a synthetic request derived from the researcher's config. It runs the REAL
 * cognition (`makeWebResearchFn` — egress-gated + SSRF-safe), the same adapter the scheduler uses, so
 * "Run now" can never ingest synthetic scaffolding into the Principal's vault. Until the live SDK
 * web-fetch session is wired (gated separately), the gated adapter yields a graceful no-finding rather
 * than fabricate a source. The Principal's trigger is audited as a `panel` event; the run's own work
 * is audited by the run-pass (actor `researcher`).
 */
export async function runActiveResearcherNow(id: string): Promise<RunResearcherResult> {
  if (!active) return { ran: false, reason: 'no-kb' };
  const root = active.stagingWt;
  const r = (await readResearcherRegistry(root)).find((x) => x.id === id);
  if (!r) return { ran: false, reason: 'not-found' };
  const what = researchWhatFor(r); // WS1 #6: the researcher's real name, never the generic template word ("code")
  const req: ResearchRequest = {
    id: ulid(),
    ts: new Date().toISOString(),
    by: { stage: 'panel' },
    what,
    why: 'on-demand test run via Control Panel',
    context: '',
    dedupKey: dedupKeyFor({ what, by: {} }),
  };
  // Same cliPath+dev-log wiring + per-template cognition as the scheduler (one seam, #160) — so Run-now
  // can't silently no-op in the packaged app, and a code/m365 researcher tests its OWN adapter.
  const opts = researchDepsOptions(active.log);
  const res = await runResearcher(root, r, req, { research: selectResearchFn(root, r, opts) });
  await appendAuditEvent(root, {
    actor: 'panel',
    eventType: 'researcher-run-now',
    subjects: { researcherId: id },
    payload: { outcome: res.failed ? 'failed' : res.ceilingReached ? 'ceiling-reached' : res.sourceIds.length > 0 ? 'researched' : 'no-finding', why: 'Principal manual run via Control Panel' },
  });
  return {
    ran: true,
    sourceIds: res.sourceIds,
    note: res.note,
    ...(res.failed ? { failed: true, ...(res.error ? { error: res.error } : {}) } : {}),
    ...(res.ceilingReached ? { ceilingReached: true } : {}),
  };
}

/** Recent runs for a researcher (RESEARCH-15) — its `researcher` audit events, newest-first. */
export async function listResearcherRunsForActive(id: string): Promise<ResearcherLastRun[]> {
  if (!active) return [];
  const events = await readEvents(active.stagingWt, { actors: ['researcher'], subjectId: id });
  return events.map((e) => lastRunFromEvent(e)).filter((x): x is ResearcherLastRun => x !== null);
}

// --- Control Panel · Sources — INTAKE feed connectors (SPEC-0027 PANEL-4 / INTAKE-14) ---

/** The intake connector registry as the Sources view needs it, with each connector's last pull. */
export async function listIntakeConnectorsForActive(): Promise<IntakeConnectorView[]> {
  if (!active) return [];
  const root = active.stagingWt;
  const registry = await readIntakeRegistry(root);
  const events = await readEvents(root, { actors: ['intake'] }); // newest-first
  const lastByConnector: Record<string, AuditEvent | undefined> = {};
  for (const c of registry) lastByConnector[c.id] = events.find((e) => e.subjects.intakeId === c.id);
  return buildIntakeConnectorViews(registry, lastByConnector);
}

/**
 * Apply a Sources-view connector config change (INTAKE-14) + return the refreshed list. Untrusted IPC
 * input is validated at this boundary (type/schedule dropped unless known enums; `maxItemsPerPass`
 * clamped; an unsafe `id` is rejected by the registry guard). The write + git commit run under the
 * shared lock; then a conforming `panel` audit event records the change (PANEL-7-style).
 */
export async function setActiveIntakeConnectorConfig(patch: IntakeConnectorConfigPatch): Promise<IntakeConnectorView[]> {
  if (!active) return [];
  const root = active.stagingWt;
  if (typeof patch.id !== 'string' || patch.id.length === 0) return listIntakeConnectorsForActive();

  // Validate untrusted IPC into a `clean` patch (drop unknown enums; clamp the item cap). apply + audit
  // both use `clean`, so a dropped-invalid field is never recorded as applied (mirrors researchers #81).
  const clean: IntakeConnectorConfigPatch = { id: patch.id };
  if (isIntakeConnectorType(patch.type)) clean.type = patch.type;
  if (typeof patch.label === 'string') clean.label = patch.label;
  if (typeof patch.enabled === 'boolean') clean.enabled = patch.enabled;
  if (isSchedulePreset(patch.schedule)) clean.schedule = patch.schedule;
  if (typeof patch.scope === 'string' && patch.scope.trim()) clean.scope = patch.scope.trim();
  if (typeof patch.sensitivity === 'string' && patch.sensitivity.trim()) clean.sensitivity = patch.sensitivity.trim();
  const cleanMax = clampMaxItems(patch.maxItemsPerPass);
  if (cleanMax !== undefined) clean.maxItemsPerPass = cleanMax;
  if (typeof patch.feedUrl === 'string' && patch.feedUrl.trim()) clean.feedUrl = patch.feedUrl.trim();
  if (typeof patch.tenantId === 'string' && patch.tenantId.trim()) clean.tenantId = patch.tenantId.trim();
  if (typeof patch.folder === 'string' && patch.folder.trim()) clean.folder = patch.folder.trim();

  let prior: IntakeConnectorConfig | undefined;
  let applied = false;
  await active.lock.run(async () => {
    const registry = await readIntakeRegistry(root);
    prior = registry.find((c) => c.id === clean.id);
    if (prior) {
      await patchIntakeConnector(root, clean.id, {
        ...(clean.enabled !== undefined ? { enabled: clean.enabled } : {}),
        ...(clean.schedule !== undefined ? { schedule: clean.schedule } : {}),
        ...(clean.scope !== undefined ? { scope: clean.scope } : {}),
        ...(clean.sensitivity !== undefined ? { sensitivity: clean.sensitivity } : {}),
        ...(clean.label !== undefined ? { label: clean.label } : {}),
        ...(clean.maxItemsPerPass !== undefined ? { maxItemsPerPass: clean.maxItemsPerPass } : {}),
        // Merge type-specific config (RSS feedUrl / M365 tenantId+folder), preserving other keys.
        ...(clean.feedUrl !== undefined || clean.tenantId !== undefined || clean.folder !== undefined
          ? {
              config: {
                ...(prior.config ?? {}),
                ...(clean.feedUrl !== undefined ? { feedUrl: clean.feedUrl } : {}),
                ...(clean.tenantId !== undefined ? { tenantId: clean.tenantId } : {}),
                ...(clean.folder !== undefined ? { folder: clean.folder } : {}),
              },
            }
          : {}),
      });
    } else {
      // New connector: derive a safe config from the (validated) type + conservative defaults.
      const type = clean.type ?? 'rss';
      clean.type = type;
      await upsertIntakeConnector(root, {
        id: clean.id,
        type,
        ...(clean.label ? { label: clean.label } : {}),
        enabled: clean.enabled ?? false,
        schedule: clean.schedule ?? 'off',
        scope: clean.scope ?? DEFAULT_INTAKE_SCOPE,
        sensitivity: clean.sensitivity ?? DEFAULT_INTAKE_SENSITIVITY,
        ...(clean.maxItemsPerPass !== undefined ? { maxItemsPerPass: clean.maxItemsPerPass } : {}),
        ...(clean.feedUrl || clean.tenantId || clean.folder
          ? { config: { ...(clean.feedUrl ? { feedUrl: clean.feedUrl } : {}), ...(clean.tenantId ? { tenantId: clean.tenantId } : {}), ...(clean.folder ? { folder: clean.folder } : {}) } }
          : {}),
      });
    }
    applied = true;
    await commitControlFile(root, intakeRegistryPath(root), `intake ${clean.id} config change`);
  }, 'intake-config:write');
  if (applied) {
    // Conforming `panel` audit: one event per changed behavior-relevant field (validated values only).
    for (const event of intakeConfigAuditEvents(prior, clean)) await appendAuditEvent(root, event);
  }
  return listIntakeConnectorsForActive();
}

/**
 * Principal override of a source's sensitivity label (SENSE-7/8). Validates the id is a real archived
 * source; under the canonical-writer lock it (1) persists the override to the Replay-sticky store so a
 * rebuild re-applies it (the classifier never overwrites a `by: principal` label), (2) re-stamps the
 * source's `source.md` frontmatter to the new label + `by: principal` (committing both atomically), then
 * (3) audits the change (`panel` event, from→to + why, SENSE-8). An empty label CLEARS the override (back
 * to the classifier/default). A custom label is accepted verbatim (SENSE-1); the comparator handles unknowns.
 */
export async function setActiveSourceSensitivity(sourceId: string, label: string): Promise<{ ok: boolean; reason?: string; sensitivity?: string }> {
  if (!active) return { ok: false, reason: 'no-kb' };
  if (typeof sourceId !== 'string' || !isUlid(sourceId)) return { ok: false, reason: 'bad-id' }; // #29: only a real ULID → a real source path
  const clean = typeof label === 'string' ? label.trim() : '';
  const root = active.stagingWt;
  const srcMdRel = path.join('sources', dateShard(sourceId), sourceId, 'source.md');
  const srcMdAbs = path.join(root, srcMdRel);
  try {
    await fs.access(srcMdAbs); // early not-found before taking the lock
  } catch {
    return { ok: false, reason: 'not-found' };
  }
  const at = new Date().toISOString();
  let fromLabel = '';
  await active.lock.run(async () => {
    // Read the authoritative base INSIDE the lock so a concurrent archive of the same source can't make
    // the re-stamp clobber a stale base (KB-QD-2 #267).
    const before = await fs.readFile(srcMdAbs, 'utf8');
    fromLabel = (before.match(/^sensitivity: (.*)$/m)?.[1] ?? '').trim();
    await setSensitivityOverride(root, sourceId, clean, at); // clean === '' clears the override
    // Setting: re-stamp the live source.md now so the Panel reflects it without a rebuild. Clearing: leave
    // the frontmatter as-is (a later Replay re-derives the classifier/default label).
    if (clean.length > 0) await fs.writeFile(srcMdAbs, applySensitivityOverrideToSourceMd(before, clean, at), 'utf8');
    const git = boundedGit(root);
    await git.add([path.relative(root, sensitivityOverridesPath(root)), srcMdRel]);
    const staged = (await git.diff(['--cached', '--name-only'])).trim();
    if (staged.length > 0) await git.commit(`control-panel: sensitivity ${sourceId} → ${clean || '(cleared)'}`);
  }, 'sensitivity-override:write');
  await appendAuditEvent(root, {
    actor: 'panel',
    eventType: 'sensitivity-override',
    subjects: { sourceId },
    payload: { field: 'sensitivity', from: fromLabel, to: clean || '(cleared → classifier/default)', by: 'principal', why: 'Principal overrode a source sensitivity via Control Panel' },
  });
  return { ok: true, sensitivity: clean || fromLabel };
}

/** Read the current sensitivity label + provenance for a set of sources (SENSE-10) — for the Control
 *  Panel (the Activity-lineage drill-down) to show a chip + offer the Principal an edit. Read-only. */
export async function getActiveSourceSensitivities(sourceIds: string[]): Promise<Record<string, SourceSensitivity>> {
  if (!active || !Array.isArray(sourceIds)) return {};
  return readSourceSensitivities(active.stagingWt, sourceIds.filter((s): s is string => typeof s === 'string'));
}

/**
 * Manual "Run now" for an intake connector (INTAKE-14, "run-now to test") — a single on-demand pull
 * via the real run-pass + the real per-type fetch (RSS = the SSRF-safe gated fetch; M365 = env-gated,
 * surfaces a clear `intake-failed` until wired). Never ingests synthetic scaffolding. The Principal's
 * trigger is audited as a `panel` event; the pull's own work is audited by the run-pass (actor `intake`).
 */
export async function runActiveIntakeConnectorNow(id: string): Promise<RunIntakeConnectorResult> {
  if (!active) return { ran: false, reason: 'no-kb' };
  const root = active.stagingWt;
  const c = (await readIntakeRegistry(root)).find((x) => x.id === id);
  if (!c) return { ran: false, reason: 'not-found' };
  const res = await runIntakeConnector(root, c, { fetch: selectIntakeFn(c) });
  await appendAuditEvent(root, {
    actor: 'panel',
    eventType: 'intake-run-now',
    subjects: { intakeId: id },
    payload: { outcome: res.failed ? 'failed' : res.sourceIds.length > 0 ? 'intook' : 'no-new-items', why: 'Principal manual run via Control Panel' },
  });
  return { ran: true, sourceIds: res.sourceIds, note: res.note, ...(res.failed ? { failed: true, ...(res.error ? { error: res.error } : {}) } : {}) };
}

/** Commit a job-registry change on `staging` — the durability record (audit is a separate `panel` event). */
async function commitRegistryChange(root: string, message: string): Promise<void> {
  await commitControlFile(root, jobRegistryPath(root), message);
}

/**
 * Commit one Control-Panel working file on the `staging` root — the **durability record**: these
 * files (`.kb/jobs/registry.json`, `.kb/instance.json`) are tracked on `staging`, never promoted, so
 * a commit is durable and protects them from a stray staging reset (the *conforming* audit is the
 * separate `panel` event the caller emits). MUST be called inside `lock.run` (it advances the
 * canonical branch directly; under the lock it is just another linear advance that stages cherry-pick
 * their disjoint work onto). A no-op write (identical bytes) commits nothing.
 */
// Exported for the #163 regression gate (boundedGit under the lock); `timeoutMs` defaults to the
// standard bound and is overridable so the test can drive the timeout fast.
export async function commitControlFile(root: string, absPath: string, message: string, timeoutMs?: number): Promise<void> {
  const git = boundedGit(root, timeoutMs); // #163: bounded — runs under the canonical-writer lock
  const rel = path.relative(root, absPath);
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
