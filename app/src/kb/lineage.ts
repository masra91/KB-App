// Lineage tracer (SPEC-0029 AUDIT-6).
//
// For any source / entity / claim id, trace WHERE it came from (provenance), WHAT transformed it
// (which stages/agents acted, when), and the DECISIONS along the way (reviews) — read straight from
// the canonical audit (the single source of truth, DATA-10), NOT from the window-capped feed index,
// so lineage stays complete however old (open-Q Q3: the cap is the feed's, never the history's).
//
// The trace is a bounded closure over the audit: the events that name the id, plus a one-hop
// expansion to the sources/entities those events reference — enough to walk source → entity → claim
// without pulling the whole graph.

import path from 'node:path';
import { readAllAuditEvents } from './activityIndex';
import type { AuditEvent } from './audit';

export type LineageKind = 'source' | 'entity' | 'claim' | 'unknown';

export interface Lineage {
  /** The id traced. */
  subjectId: string;
  /** What kind of thing it is, inferred from the subject fields that name it in the audit. */
  kind: LineageKind;
  /** The source ids in the provenance closure (where it ultimately came from). */
  sources: string[];
  /** Every event in the lineage closure, oldest-first (the transformation timeline). */
  events: AuditEvent[];
  /** The decision points — review-related events (the *why* / human calls), oldest-first. */
  decisions: AuditEvent[];
}

/** Oldest-first ordering (the lineage timeline reads forward in time). */
function byTsAscending(a: AuditEvent, b: AuditEvent): number {
  if (a.ts !== b.ts) return a.ts < b.ts ? -1 : 1;
  if (a.provenance.file !== b.provenance.file) return a.provenance.file < b.provenance.file ? -1 : 1;
  return a.provenance.line - b.provenance.line;
}

/** Does this event name `id` in any subject field? */
function names(event: AuditEvent, id: string): boolean {
  return Object.values(event.subjects).some((v) => v === id);
}

/** A review-related event records a decision / the why behind a human or agent call. */
function isDecision(event: AuditEvent): boolean {
  return event.subjects.reviewId !== undefined || event.eventType.includes('review') || event.eventType === 'awaiting-review';
}

/** Infer the kind of `id` from the subject field that names it in its own events. */
function inferKind(seed: readonly AuditEvent[], id: string): LineageKind {
  for (const e of seed) {
    if (e.subjects.entityId === id) return 'entity';
    if (e.subjects.claimId === id) return 'claim';
    if (e.subjects.sourceId === id) return 'source';
  }
  return 'unknown';
}

/** Collect the source/entity ids an event references, both in its subjects and in known payload
 *  fields (a claim's `derivedFrom`, a connect resolve's candidate refs), for the one-hop expansion. */
function relatedIds(event: AuditEvent): Set<string> {
  const ids = new Set<string>();
  if (event.subjects.sourceId) ids.add(event.subjects.sourceId);
  if (event.subjects.entityId) ids.add(event.subjects.entityId);
  if (event.subjects.claimId) ids.add(event.subjects.claimId);
  // A claim/entity records the source dir it derived from as a rel path; recover the source id.
  const derivedFrom = event.payload.derivedFrom;
  if (typeof derivedFrom === 'string' && derivedFrom.length > 0) ids.add(path.basename(derivedFrom));
  return ids;
}

/**
 * Trace the lineage of `id` (AUDIT-6). Reads the full audit, gathers every event naming `id`, then
 * expands one hop to the sources/entities those events reference — the result is the provenance +
 * transformation timeline + decisions for the subject. An unknown id yields an empty lineage
 * (kind 'unknown'), never an error.
 */
export async function traceLineage(root: string, id: string): Promise<Lineage> {
  const all = await readAllAuditEvents(root);

  const seed = all.filter((e) => names(e, id));
  const closure = new Set<string>([id]);
  for (const e of seed) for (const r of relatedIds(e)) closure.add(r);

  const events = all.filter((e) => [...closure].some((cid) => names(e, cid)));
  events.sort(byTsAscending);

  const sources = [...new Set(events.map((e) => e.subjects.sourceId).filter((s): s is string => s !== undefined))];
  const decisions = events.filter(isDecision);

  return { subjectId: id, kind: inferKind(seed, id), sources, events, decisions };
}
