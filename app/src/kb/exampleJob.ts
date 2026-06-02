// A deterministic example job (SPEC-0023) — the reference behavior that exercises the JOBS engine
// end-to-end without depending on Reflect (SPEC-0024). It does a tiny BOUNDED pass: count the
// canonical entity nodes, and — only when that count CHANGED since the last run (journal cursor,
// JOBS-7) — emit ONE additive, high-confidence finding that (over)writes an evergreen census note.
// Unchanged → no findings (the common "did nothing" outcome). Pure cognition, no external effects
// (JOBS-10). Real jobs (Reflect) plug in the same `JobBehavior` contract.
import path from 'node:path';
import { findEntityFiles } from './claimsStage';
import type { JobBehavior, JobPassResult } from './jobs';

/** The evergreen artifact the example job maintains (promotes to `main`, JOBS-12). */
export const EXAMPLE_CENSUS_REL = path.join('outputs', 'example', 'entity-census.md');
export const EXAMPLE_JOB_TYPE = 'example';

export const exampleJobBehavior: JobBehavior = async (ctx): Promise<JobPassResult> => {
  const entities = await findEntityFiles(ctx.root); // bounded inspect of the resolved graph
  const count = entities.length;
  const last = ctx.journal[ctx.journal.length - 1];
  const lastCount = typeof last?.cursor?.entityCount === 'number' ? (last.cursor.entityCount as number) : null;

  const inspected = `entities/ (${count} node${count === 1 ? '' : 's'})`;
  // No actionable work when the census is unchanged — a normal, common no-op run (JOBS-4).
  if (lastCount === count) {
    return { inspected, findings: [], cursor: { entityCount: count } };
  }
  const content = `---\ngenerated: example-job\nentityCount: ${count}\n---\n\n# Entity census\n\n${count} canonical entit${count === 1 ? 'y' : 'ies'} in the KB.\n`;
  return {
    inspected,
    findings: [
      {
        summary: `entity census ${lastCount ?? 'n/a'} → ${count}`,
        kind: 'additive',
        confidence: 1,
        proposed: 'auto',
        writes: [{ rel: EXAMPLE_CENSUS_REL, content }],
      },
    ],
    cursor: { entityCount: count },
  };
};
