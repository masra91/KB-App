// Control Panel · Jobs — pure view-model logic (SPEC-0027 PANEL-2/7).
//
// This module is DOM-free and side-effect-free so it is unit-tested in the node tier (the
// SHELL-6 discipline, SPEC-0012 TEST-5): the main process gathers the fs-backed inputs (registry
// + journals) and hands them here; the renderer just renders the result. It owns three things the
// Jobs view's correctness rides on:
//   - buildJobViews: merge the known-job catalog with the per-vault registry into display rows,
//     overlaying each job's last-run summary from its journal (PANEL-2);
//   - schedulePresetLabel: the human label for a cadence preset;
//   - isRiskyJobChange: which config changes must confirm + audit (PANEL-7).
import { SCHEDULE_PRESETS, DEFAULT_POSTURE, type JobConfig, type JournalEntry, type SchedulePreset } from './jobs';
import type { JobCatalogEntry } from './jobCatalog';
import type { JobView, JobLastRun, JobConfigPatch } from './types';

/** Human labels for the named schedule presets (JOBS-2), in cadence order. */
const PRESET_LABELS: Record<SchedulePreset, string> = {
  off: 'Off',
  'several-daily': 'A few times a day',
  hourly: 'Hourly',
  daily: 'Daily',
};

/** The label for a schedule preset (falls back to the raw value for forward-compat). */
export function schedulePresetLabel(preset: SchedulePreset): string {
  return PRESET_LABELS[preset] ?? preset;
}

/** Presets offered in the cadence picker, in a sensible order (off last). */
export const SCHEDULE_OPTIONS: SchedulePreset[] = ['several-daily', 'hourly', 'daily', 'off'];

/** The last-run summary for display (PANEL-2), derived from a job's newest journal entry, or null. */
function lastRunOf(entry: JournalEntry | undefined): JobLastRun | null {
  if (!entry) return null;
  return {
    ts: entry.ts,
    inspected: entry.inspected,
    applied: entry.applied,
    deferred: entry.deferred,
    ...(entry.note ? { note: entry.note } : {}),
  };
}

/**
 * Merge the known-job catalog with the per-vault registry into display rows (PANEL-2).
 *
 * Every catalog type yields a row — registered (its persisted config) or catalog-only (defaults:
 * disabled / off / guarded, `registered:false`) so the Principal can manage a known job before it
 * is ever persisted. Registry jobs whose `type` has no catalog entry (e.g. a job registered before
 * its catalog row, or a since-removed type) are still listed, labeled by their type, so nothing the
 * scheduler might run is hidden. Catalog order first, then any extra registry jobs by id. Each row's
 * `lastRun` comes from `lastEntryByJobId[id]` (the newest journal line for that job).
 */
export function buildJobViews(
  catalog: JobCatalogEntry[],
  registry: JobConfig[],
  lastEntryByJobId: Record<string, JournalEntry | undefined>,
): JobView[] {
  // For v1 a catalog type maps to a single job whose id === type (one instance per type).
  const byId = new Map<string, JobConfig>(registry.map((j) => [j.id, j]));
  const views: JobView[] = [];
  const seen = new Set<string>();

  for (const entry of catalog) {
    const id = entry.type;
    seen.add(id);
    const cfg = byId.get(id);
    views.push({
      id,
      type: entry.type,
      label: entry.label,
      description: entry.description,
      production: entry.production,
      registered: cfg !== undefined,
      enabled: cfg?.enabled ?? false,
      schedule: cfg?.schedule ?? 'off',
      posture: cfg?.posture ?? DEFAULT_POSTURE,
      lastRun: lastRunOf(lastEntryByJobId[id]),
    });
  }

  // Registry jobs without a catalog entry — never hide a job the scheduler may run.
  for (const cfg of registry) {
    if (seen.has(cfg.id)) continue;
    views.push({
      id: cfg.id,
      type: cfg.type,
      label: cfg.type,
      description: 'Registered job (no catalog entry).',
      production: false,
      registered: true,
      enabled: cfg.enabled,
      schedule: cfg.schedule,
      posture: cfg.posture,
      lastRun: lastRunOf(lastEntryByJobId[cfg.id]),
    });
  }

  return views;
}

/**
 * Whether a pending config change is "risky" and so must confirm + be audited (PANEL-7 / AUTO-1,8):
 * **enabling** a job (it starts running on a cadence) or moving a job to **Autonomous** posture (the
 * agent's judgment governs all dispositions, incl. destructive). Disabling, changing cadence, or
 * relaxing to Guarded are not risky. Compared against the job's current view (`current`); a patch
 * that doesn't change the field, or matches the current value, is not risky.
 */
export function isRiskyJobChange(current: Pick<JobView, 'enabled' | 'posture'>, patch: JobConfigPatch): boolean {
  const enabling = patch.enabled === true && !current.enabled;
  const goingAutonomous = patch.posture === 'autonomous' && current.posture !== 'autonomous';
  return enabling || goingAutonomous;
}

/** Validate a schedule string against the known presets (defensive: IPC input may be untrusted). */
export function isSchedulePreset(v: unknown): v is SchedulePreset {
  return typeof v === 'string' && (SCHEDULE_PRESETS as readonly string[]).includes(v);
}
