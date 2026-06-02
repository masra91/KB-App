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
import { executeApprovedConsolidation } from '../kb/executeApprovedConsolidation';
import { runFullReplay } from '../kb/replay';
import { JobScheduler } from '../kb/jobScheduler';
import { exampleJobBehavior, EXAMPLE_JOB_TYPE } from '../kb/exampleJob';
import { makeReflectJobBehavior, REFLECT_JOB_TYPE } from '../kb/reflectJob';
import { makeReflectDecider } from '../kb/reflectAgent';
import { readJobRegistry, patchJob, upsertJob, jobRegistryPath } from '../kb/jobRegistry';
import { readJournal } from '../kb/jobStage';
import { JOB_CATALOG, catalogEntry } from '../kb/jobCatalog';
import { buildJobViews, isSchedulePreset, isAutonomyPosture, jobConfigAuditEvents } from '../kb/jobsPanel';
import { readInstanceConfig, writeInstanceConfig, instanceConfigPath, resolveJobPosture } from '../kb/instanceConfig';
import { AGENT_CATALOG, buildAgentViews } from '../kb/agentCatalog';
import { appendAuditEvent } from '../kb/audit';
import { readEvents } from '../kb/activityIndex';
import { readResearcherRegistry, upsertResearcher, patchResearcher, researcherRegistryPath } from '../kb/researcherRegistry';
import { buildResearcherViews, isEgressTier, isResearcherTemplate, defaultEgressFor } from '../kb/researchersPanel';
import { runResearcher } from '../kb/researchRun';
import { stubResearchFn } from '../kb/researchStub';
import { DEFAULT_RESEARCHER_BUDGET, dedupKeyFor, type ResearchRequest, type ResearcherConfig } from '../kb/researchers';
import { ulid } from '../kb/ulid';
import { DEFAULT_POSTURE, type JobBehavior, type JobConfig, type JournalEntry } from '../kb/jobs';
import type { Review } from '../kb/reviews';
import type { AuditEvent } from '../kb/audit';
import type { FullReplayResult, JobView, JobConfigPatch, RunJobResult, InstanceSettings, AgentView, ResearcherView, ResearcherConfigPatch, ResearcherLastRun, RunResearcherResult } from '../kb/types';
import { lastRunFromEvent } from '../kb/researchersPanel';

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

/** The active vault's `staging` worktree — where the full working-zone audit lives (per-item
 *  audit.jsonl, connect/, .kb/jobs, .kb/ask, .kb/audit.jsonl), a superset of the evergreen archive
 *  promoted to `main`. The read root for the Audit & Activity views (SPEC-0029). Null if no active KB. */
export function activeStagingRoot(): string | null {
  return active?.stagingWt ?? null;
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
  // SPEC-0024 REFLECT-5/7: if this Review was a Reflect-proposed consolidation that the Principal
  // just APPROVED, execute the merge now — the ONLY point a Reflect destructive merge ever runs
  // (never autonomously). `executeApprovedConsolidation` self-gates (a safe no-op for any non-
  // approved / non-consolidation review), so calling it for every answered review is correct; we
  // promote ONLY when it actually merged, so the loser-node deletions mirror to `main` via the
  // deletion-aware gate (STAGING-10). Promote under the shared lock, like the stages' afterDrain.
  if (result.ok) {
    const consolidation = await executeApprovedConsolidation(active.stagingWt, id, active.lock);
    if (consolidation.executed) await active.lock.run(() => promote(active.vaultPath));
  }
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
      const instanceCfg = await readInstanceConfig(root);
      await upsertJob(root, { id, type: entry.type, enabled: false, schedule: 'off', posture: resolveJobPosture(instanceCfg.autonomyDefault, undefined) });
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

// --- Control Panel · Settings + Agents (SPEC-0027 PANEL-3/5) ---

/** The per-Instance settings for the active KB (PANEL-5). No active KB → safe defaults. */
export async function getActiveInstanceSettings(): Promise<InstanceSettings> {
  if (!active) return { autonomyDefault: 'guarded' };
  return readInstanceConfig(active.stagingWt);
}

/**
 * Persist the per-Instance settings (PANEL-5/6): write `.kb/instance.json` + git-commit on `staging`
 * under the lock (durability), then emit a conforming `panel` audit event when the autonomy default
 * changed (PANEL-7 / AUDIT-2/11 — `→ Autonomous` is a risky, audited change). An invalid posture is
 * refused (fail-safe). Takes effect immediately (new jobs inherit it via `resolveJobPosture`).
 */
export async function setActiveInstanceSettings(settings: InstanceSettings): Promise<InstanceSettings> {
  if (!active) return { autonomyDefault: 'guarded' };
  const root = active.stagingWt;
  if (!isAutonomyPosture(settings.autonomyDefault)) return readInstanceConfig(root); // reject invalid
  let prior: InstanceSettings = { autonomyDefault: 'guarded' };
  await active.lock.run(async () => {
    prior = await readInstanceConfig(root);
    await writeInstanceConfig(root, { autonomyDefault: settings.autonomyDefault });
    await commitControlFile(root, instanceConfigPath(root), `instance autonomyDefault=${settings.autonomyDefault}`);
  });
  if (prior.autonomyDefault !== settings.autonomyDefault) {
    await appendAuditEvent(root, {
      actor: 'panel',
      eventType: 'instance-config-change',
      subjects: {},
      payload: { field: 'autonomyDefault', from: prior.autonomyDefault, to: settings.autonomyDefault, why: 'Principal change via Control Panel' },
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

  let prior: ResearcherConfig | undefined;
  let applied = false;
  await active.lock.run(async () => {
    const registry = await readResearcherRegistry(root);
    prior = registry.find((r) => r.id === patch.id);
    if (prior) {
      await patchResearcher(root, patch.id, {
        ...(typeof patch.enabled === 'boolean' ? { enabled: patch.enabled } : {}),
        ...(isSchedulePreset(patch.schedule) ? { schedule: patch.schedule } : {}),
        ...(isAutonomyPosture(patch.posture) ? { posture: patch.posture } : {}),
        ...(isEgressTier(patch.egressTier) ? { egressTier: patch.egressTier } : {}),
        ...(typeof patch.prompt === 'string' && patch.prompt.trim() ? { prompt: patch.prompt } : {}),
        ...(typeof patch.scope === 'string' && patch.scope.trim() ? { scope: patch.scope } : {}),
        ...(Array.isArray(patch.topics) ? { topics: patch.topics } : {}),
      });
    } else {
      // New researcher: derive a safe config from the (validated) template + defaults.
      const template = isResearcherTemplate(patch.template) ? patch.template : 'custom';
      await upsertResearcher(root, {
        id: patch.id,
        template,
        label: typeof patch.label === 'string' ? patch.label : undefined,
        prompt: typeof patch.prompt === 'string' && patch.prompt.trim() ? patch.prompt : `Research ${template} sources relevant to the request.`,
        egressTier: isEgressTier(patch.egressTier) ? patch.egressTier : defaultEgressFor(template),
        scope: typeof patch.scope === 'string' && patch.scope.trim() ? patch.scope : 'global',
        budget: DEFAULT_RESEARCHER_BUDGET,
        schedule: isSchedulePreset(patch.schedule) ? patch.schedule : 'off',
        posture: isAutonomyPosture(patch.posture) ? patch.posture : DEFAULT_POSTURE,
        enabled: patch.enabled ?? false,
        ...(Array.isArray(patch.topics) ? { topics: patch.topics } : {}),
      });
    }
    applied = true;
    await commitControlFile(root, researcherRegistryPath(root), `researcher ${patch.id} config change`);
  });
  if (applied) {
    await appendAuditEvent(root, {
      actor: 'panel',
      eventType: 'researcher-config-change',
      subjects: { researcherId: patch.id },
      payload: {
        ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
        ...(patch.schedule !== undefined ? { schedule: patch.schedule } : {}),
        ...(patch.posture !== undefined ? { posture: patch.posture } : {}),
        ...(patch.egressTier !== undefined ? { egressTier: patch.egressTier } : {}),
        why: 'Principal change via Control Panel',
      },
    });
  }
  return listResearchersForActive();
}

/**
 * Manual "Run now" for a researcher (RESEARCH-15, "run-now to test") — a single on-demand pass via
 * the run-pass against a synthetic request derived from the researcher's config. Slice 1a uses the
 * deterministic `stubResearchFn` (no external egress); Slice 1b swaps the real Web adapter behind
 * the same seam. The Principal's trigger is audited as a `panel` event; the run's own work is audited
 * by the run-pass (actor `researcher`).
 */
export async function runActiveResearcherNow(id: string): Promise<RunResearcherResult> {
  if (!active) return { ran: false, reason: 'no-kb' };
  const root = active.stagingWt;
  const r = (await readResearcherRegistry(root)).find((x) => x.id === id);
  if (!r) return { ran: false, reason: 'not-found' };
  const what = r.topics?.[0] ?? r.label ?? r.template;
  const req: ResearchRequest = {
    id: ulid(),
    ts: new Date().toISOString(),
    by: { stage: 'panel' },
    what,
    why: 'on-demand test run via Control Panel',
    context: '',
    dedupKey: dedupKeyFor({ what, by: {} }),
  };
  const res = await runResearcher(root, r, req, { research: stubResearchFn });
  await appendAuditEvent(root, {
    actor: 'panel',
    eventType: 'researcher-run-now',
    subjects: { researcherId: id },
    payload: { outcome: res.sourceIds.length > 0 ? 'researched' : 'no-finding', why: 'Principal manual run via Control Panel' },
  });
  return { ran: true, sourceIds: res.sourceIds, note: res.note };
}

/** Recent runs for a researcher (RESEARCH-15) — its `researcher` audit events, newest-first. */
export async function listResearcherRunsForActive(id: string): Promise<ResearcherLastRun[]> {
  if (!active) return [];
  const events = await readEvents(active.stagingWt, { actors: ['researcher'], subjectId: id });
  return events.map((e) => lastRunFromEvent(e)).filter((x): x is ResearcherLastRun => x !== null);
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
async function commitControlFile(root: string, absPath: string, message: string): Promise<void> {
  const git = simpleGit(root);
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
