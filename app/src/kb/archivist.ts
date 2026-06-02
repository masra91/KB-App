// The archivist's "decision" — the per-item cognition the orchestrator feeds one fresh
// session at a time (SPEC-0014 ORCH-5/7). In v1 it is a DETERMINISTIC stand-in: the thin
// agent is cognition-only and the orchestrator owns all effects (ORCH-7). Phase B swaps in
// a single-shot Copilot session implementing the same `ArchivistDecider` interface — the
// orchestrator code does not change.
import type { CapturedMeta } from './ingest';
import type { SpanCtx } from './tracing';

export interface ArchiveDecision {
  kind: 'text' | 'file';
  class: 'primary' | 'secondary';
  scope: 'global';
  sensitivity: 'internal';
  /** Provenance of the decision itself — see AgentTrace (ORCH-16). */
  agent?: AgentTrace;
}

/**
 * Record of how a decision was reached, for auditing non-deterministic steps (ORCH-16).
 * Captures *what we launched and what happened* — never tokens/cost.
 */
export interface AgentTrace {
  via: 'copilot' | 'deterministic'; // which decision was actually used
  runtime?: 'copilot'; // model runtime attempted, if any
  model?: string; // model we launched with ('default' when unpinned — see note in copilotAgent)
  params?: string[]; // launch flags (excludes the prompt body)
  ok?: boolean; // did the runtime call succeed + parse
  error?: string; // fallback / error reason
  ms?: number; // call duration
  at?: string; // ISO timestamp of the invocation
}

/** A decider maps a captured unit's metadata to an archival decision. */
export type ArchivistDecider = (meta: CapturedMeta, ctx?: SpanCtx) => ArchiveDecision | Promise<ArchiveDecision>;

/**
 * v1 deterministic decision. Conservative defaults only (CAPTURE-10): everything captured
 * by the Principal is a `primary` source, `global`/`internal`. Real classification +
 * Review routing are Enrich's job, deferred.
 */
export function deterministicDecide(meta: CapturedMeta): ArchiveDecision {
  return { kind: meta.kind, class: 'primary', scope: 'global', sensitivity: 'internal', agent: { via: 'deterministic' } };
}

/** The injectable decider the orchestrator feeds per item (Phase B swaps in a Copilot
 *  session implementing the same interface). */
export const deterministicDecider: ArchivistDecider = deterministicDecide;
