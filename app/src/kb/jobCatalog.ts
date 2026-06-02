// The known-job catalog (SPEC-0027 PANEL-2) — the Principal-facing list of job *types* the Control
// Panel can manage. The job registry (`.kb/jobs/registry.json`) is per-vault and starts empty with no
// add-a-job flow, so the Jobs view merges this catalog with the registry: every known type shows as a
// manageable row (default off/guarded) even before it is persisted; the first config edit persists it
// via `upsertJob`. The catalog MUST stay in sync with the orchestrator's `resolveJobBehavior` (a type
// listed here but unresolvable would surface a row whose "Run now" returns `unknown-type`).
//
// v1 ships the deterministic `example` job (a reference/non-production behavior that exercises the JOBS
// engine end-to-end, SPEC-0023) and the first real Principal-facing job, **Reflect / Rumination**
// (SPEC-0024). Later jobs add their catalog entry alongside their behavior when they land.
import { EXAMPLE_JOB_TYPE } from './exampleJob';
import { REFLECT_JOB_TYPE } from './reflectJob';

/** One entry in the known-job catalog — display metadata for a manageable job type. */
export interface JobCatalogEntry {
  /** The job `type` (matches `JobConfig.type` + the orchestrator's behavior resolver). */
  type: string;
  /** Principal-facing name shown in the Jobs view. */
  label: string;
  /** One-line description of what the job does. */
  description: string;
  /** False marks a reference / non-production behavior (the `example` job) so the UI can flag it. */
  production: boolean;
}

/** The known job types the Control Panel surfaces, in display order (SPEC-0027 PANEL-2). */
export const JOB_CATALOG: JobCatalogEntry[] = [
  {
    type: REFLECT_JOB_TYPE,
    label: 'Reflect',
    description:
      'Periodically reviews your KB for missed structure, connections, and stale topics, proposing ' +
      'improvements. Additive, high-confidence changes apply automatically; anything risky is sent to Reviews.',
    production: true,
  },
  {
    type: EXAMPLE_JOB_TYPE,
    label: 'Entity census',
    description:
      'Reference job — counts canonical entities and maintains a census note when the count changes. ' +
      'Demonstrates the autonomous-jobs engine end to end; not a production enrichment job.',
    production: false,
  },
];

/** Look up a catalog entry by job `type`, or undefined if the type is not in the catalog. */
export function catalogEntry(type: string): JobCatalogEntry | undefined {
  return JOB_CATALOG.find((e) => e.type === type);
}
