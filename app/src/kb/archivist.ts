// The archivist's "decision" — the per-item cognition the orchestrator feeds one fresh
// session at a time (SPEC-0014 ORCH-5/7). In v1 it is a DETERMINISTIC stand-in: the thin
// agent is cognition-only and the orchestrator owns all effects (ORCH-7). Phase B swaps in
// a single-shot Copilot session implementing the same `ArchivistDecider` interface — the
// orchestrator code does not change.
import type { CapturedMeta } from './ingest';

export interface ArchiveDecision {
  kind: 'text' | 'file';
  class: 'primary' | 'secondary';
  scope: 'global';
  sensitivity: 'internal';
}

/** A decider maps a captured unit's metadata to an archival decision. */
export type ArchivistDecider = (meta: CapturedMeta) => ArchiveDecision | Promise<ArchiveDecision>;

/**
 * v1 deterministic decision. Conservative defaults only (CAPTURE-10): everything captured
 * by the Principal is a `primary` source, `global`/`internal`. Real classification +
 * Review routing are Enrich's job, deferred.
 */
export function deterministicDecide(meta: CapturedMeta): ArchiveDecision {
  return { kind: meta.kind, class: 'primary', scope: 'global', sensitivity: 'internal' };
}

/** The injectable decider the orchestrator feeds per item (Phase B swaps in a Copilot
 *  session implementing the same interface). */
export const deterministicDecider: ArchivistDecider = deterministicDecide;
