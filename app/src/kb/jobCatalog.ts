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
import { DEFAULT_FACING, type Facing } from './jobs';

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
  /** JOBS-16: which way this built-in faces — `internal` (no egress) | `external` (researcher).
   *  The built-in's fixed facing; user-authored jobs (JOBS-18) set their own. Default `internal`. */
  facing: Facing;
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
    facing: 'internal', // JOBS-16: Reflect operates on the KB itself — no external egress
  },
  {
    type: EXAMPLE_JOB_TYPE,
    label: 'Entity census',
    description:
      'Reference job — counts canonical entities and maintains a census note when the count changes. ' +
      'Demonstrates the autonomous-jobs engine end to end; not a production enrichment job.',
    production: false,
    facing: 'internal',
  },
];

/** The facing for a job `type` — the catalog entry's, or the safe default (`internal`) for an
 *  unknown/user-authored type until JOBS-18 lets the Principal set it. */
export function facingForType(type: string): Facing {
  return catalogEntry(type)?.facing ?? DEFAULT_FACING;
}

/** Look up a catalog entry by job `type`, or undefined if the type is not in the catalog. */
export function catalogEntry(type: string): JobCatalogEntry | undefined {
  return JOB_CATALOG.find((e) => e.type === type);
}
