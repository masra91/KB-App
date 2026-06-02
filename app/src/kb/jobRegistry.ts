// The autonomous-job registry (SPEC-0023 JOBS-1) — per-vault config the Principal owns.
//
// Stored at `.kb/jobs/registry.json` (per-vault, NOT app-global appConfig — jobs are a property
// of a KB). It lives under `.kb/jobs/` which is tracked on `staging` (the vault gitignore ignores
// only `.kb/cache/`) and never promoted (it's not in EVERGREEN_PATHS), so it's git-auditable but
// hidden from Obsidian on `main`. Settings/Control-Panel edits go through these helpers (JOBS-14).
import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  SCHEDULE_PRESETS,
  AUTONOMY_POSTURES,
  DEFAULT_POSTURE,
  isSafeJobId,
  type JobConfig,
  type SchedulePreset,
  type AutonomyPosture,
} from './jobs';
import { noopDevLog, type DevLog } from './devlog';

const REGISTRY_REL = path.join('.kb', 'jobs', 'registry.json');

/** Absolute path to a vault's job registry file. */
export function jobRegistryPath(root: string): string {
  return path.join(path.resolve(root), REGISTRY_REL);
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.trim().length > 0;
}

/** Validate one stored entry into a `JobConfig`, or null to skip a malformed row (never crash a
 *  read on a bad file). Unknown schedule/posture fall back to safe defaults (`off` / `guarded`). */
function validJob(v: unknown): JobConfig | null {
  if (typeof v !== 'object' || v === null) return null;
  const o = v as Record<string, unknown>;
  if (!isNonEmptyString(o.id) || !isNonEmptyString(o.type)) return null;
  const schedule: SchedulePreset = (SCHEDULE_PRESETS as readonly string[]).includes(o.schedule as string)
    ? (o.schedule as SchedulePreset)
    : 'off';
  const posture: AutonomyPosture = (AUTONOMY_POSTURES as readonly string[]).includes(o.posture as string)
    ? (o.posture as AutonomyPosture)
    : DEFAULT_POSTURE;
  const job: JobConfig = {
    id: o.id,
    type: o.type,
    schedule,
    enabled: o.enabled === true,
    posture,
  };
  if (o.config && typeof o.config === 'object') job.config = o.config as Record<string, unknown>;
  return job;
}

/**
 * Read the vault's job registry (JOBS-1). Missing/malformed file → empty registry (no jobs).
 *
 * #29 sink-side hardening: `.kb/jobs/registry.json` is per-vault and hand-/foreign-editable, so a
 * stored `id` is untrusted. A row whose `id` is not a bare slug (`isSafeJobId`) is DROPPED here —
 * the read boundary — so a traversal id (`../x`) can never reach `journalRel(id)`/the per-job
 * worktree downstream. Dropping is NOT silent: each rejected id is surfaced on `devlog` (best-effort,
 * never-throws — injectable, noop by default) so a tampered/corrupt registry is observable, not
 * mysteriously short a job. Other (valid) rows still load.
 */
export async function readJobRegistry(root: string, devlog: DevLog = noopDevLog): Promise<JobConfig[]> {
  let raw: string;
  try {
    raw = await fs.readFile(jobRegistryPath(root), 'utf8');
  } catch {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const out: JobConfig[] = [];
  for (const row of parsed) {
    const job = validJob(row);
    if (!job) continue;
    if (!isSafeJobId(job.id)) {
      devlog.warn('job-id-rejected', { jobId: job.id, source: 'registry-read', reason: 'job id is not a bare slug (path-traversal guard, #29)' });
      continue;
    }
    out.push(job);
  }
  return out;
}

/** Write the registry (deterministic, stable key order via JobConfig shape) under `.kb/jobs/`. */
export async function writeJobRegistry(root: string, jobs: JobConfig[]): Promise<void> {
  const p = jobRegistryPath(root);
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, JSON.stringify(jobs, null, 2) + '\n', 'utf8');
}

/**
 * Insert or replace a job by `id` (Settings edit; JOBS-14), returning the updated registry.
 *
 * #29 write boundary: reject an unsafe `id` (throw — never persist), so a traversal id can't be
 * written into `registry.json` in the first place. For a NEW (not-yet-registered) job, also assert
 * `id === type`: v1 is one-instance-per-type and the catalog mints `id === type`, so a *new* id that
 * isn't its own type has no legitimate source (belt-and-suspenders over the slug check). Replacing an
 * existing job keeps its already-validated id. Throwing (vs a result type) keeps the signature stable
 * so the IPC/Settings caller surfaces the rejection without a wider refactor; legitimate ids (catalog
 * slugs) never trip it. The `Mutex` releases on throw (`.finally`), so a rejection can't deadlock.
 */
export async function upsertJob(root: string, job: JobConfig): Promise<JobConfig[]> {
  if (!isSafeJobId(job.id)) throw new Error(`refusing to register job with unsafe id: ${JSON.stringify(job.id)}`);
  const jobs = await readJobRegistry(root);
  const idx = jobs.findIndex((j) => j.id === job.id);
  if (idx === -1) {
    if (job.id !== job.type) {
      throw new Error(`refusing to register a new job whose id !== type (id=${JSON.stringify(job.id)}, type=${JSON.stringify(job.type)})`);
    }
    jobs.push(job);
  } else jobs[idx] = job;
  await writeJobRegistry(root, jobs);
  return jobs;
}

/** Patch one job's mutable config fields (enable/disable, cadence, posture); no-op if absent.
 *  #29: reject an unsafe `id` at the boundary (throw — never persist) before it can index anything. */
export async function patchJob(
  root: string,
  id: string,
  patch: Partial<Pick<JobConfig, 'enabled' | 'schedule' | 'posture' | 'config'>>,
): Promise<JobConfig[]> {
  if (!isSafeJobId(id)) throw new Error(`refusing to patch job with unsafe id: ${JSON.stringify(id)}`);
  const jobs = await readJobRegistry(root);
  const job = jobs.find((j) => j.id === id);
  if (job) {
    if (patch.enabled !== undefined) job.enabled = patch.enabled;
    if (patch.schedule !== undefined) job.schedule = patch.schedule;
    if (patch.posture !== undefined) job.posture = patch.posture;
    if (patch.config !== undefined) job.config = patch.config;
    await writeJobRegistry(root, jobs);
  }
  return jobs;
}
