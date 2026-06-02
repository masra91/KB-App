// Curation engine for the Activity feed (SPEC-0029 AUDIT-5; open-Q Q1 → deterministic templates).
//
// Turns raw canonical events into a human-friendly stream (AUTO-9: "Connect resolved 3 candidates
// into Project Atlas") WITHOUT an agent — pure templates per (actor, eventType), cheap and
// predictable. Events from one run (same `runId`) collapse into a single feed entry that carries
// its raw events for drill-down (AUDIT-5 "drill-down to the raw audit events").

import type { AuditEvent, AuditActor } from './audit';

/** A curated, human-friendly feed entry summarizing one run / action, with its raw events behind it. */
export interface ActivityFeedEntry {
  /** Stable key for the entry (the runId, or a provenance key for runless events). */
  id: string;
  /** Representative timestamp (the newest event in the group). */
  ts: string;
  /** Who acted. */
  actor: AuditActor;
  /** The human-friendly one-liner. */
  summary: string;
  /** How many raw events this entry summarizes. */
  eventCount: number;
  /** The raw events behind the entry, oldest-first (drill-down). */
  events: AuditEvent[];
}

/** Significance order — within a run we summarize from the most meaningful event reached. */
const SIGNIFICANCE: Record<string, number> = {
  // terminal / headline outcomes
  archived: 100,
  decomposed: 100,
  claimed: 100,
  resolved: 100,
  connected: 95,
  linked: 95,
  'job-run': 100,
  recall: 100,
  'replay-reset': 100,
  setaside: 90,
  // mid-run states
  'awaiting-review': 80,
  'review-raised': 75,
  failed: 70,
  // low-signal
  signal: 40,
  'links-start': 30,
  start: 20,
};

function significance(eventType: string): number {
  return SIGNIFICANCE[eventType] ?? 50;
}

function num(v: unknown, fallback = 0): number {
  return typeof v === 'number' ? v : fallback;
}

/** A short, readable label for the subject an event is about. */
function subjectLabel(event: AuditEvent): string {
  const s = event.subjects;
  if (s.entityId) return s.entityId;
  if (s.sourceId) return s.sourceId;
  if (s.claimId) return s.claimId;
  if (s.jobId) return s.jobId;
  if (s.blockKey) return s.blockKey;
  return 'an item';
}

/**
 * A deterministic, human-friendly one-liner for a single event (AUTO-9). Falls back to a generic
 * "<actor> <eventType>" line for any shape without a bespoke template, so a new event-type still
 * renders sensibly until a template is added.
 */
export function digestEvent(event: AuditEvent): string {
  const p = event.payload;
  switch (`${event.actor}:${event.eventType}`) {
    case 'archivist:archived':
      return 'Archived a new source';
    case 'decompose:decomposed':
      return `Decompose extracted ${num(p.candidates)} candidate ${plural(num(p.candidates), 'entity', 'entities')}`;
    case 'claims:claimed':
      return `Claims derived ${num(p.claims)} ${plural(num(p.claims), 'claim')} about ${subjectLabel(event)}`;
    case 'claims:awaiting-review':
      return `Claims raised a review on ${subjectLabel(event)}`;
    case 'connect:resolved':
      return `Connect resolved ${num(p.candidates)} ${plural(num(p.candidates), 'candidate')} into ${subjectLabel(event)}${num(p.merged) > 0 ? ` (merged ${num(p.merged)})` : ''}`;
    case 'connect:connected':
      return `Connect resolved ${num(p.clusters)} ${plural(num(p.clusters), 'cluster')}`;
    case 'connect:linked':
      return 'Connect linked entities';
    case 'connect:awaiting-review':
      return 'Connect raised a review';
    case 'job:job-run':
      return `Job ${subjectLabel(event)} ran — ${num(p.applied)} applied, ${num(p.deferred)} deferred`;
    case 'recall:recall':
      return `Answered a question${typeof p.question === 'string' ? `: "${truncate(p.question, 80)}"` : ''}`;
    case 'replay:replay-reset':
      return 'Full rebuild — reset derived stages';
    default:
      if (event.eventType === 'setaside') return `${cap(event.actor)} set aside ${subjectLabel(event)}${typeof p.reason === 'string' ? ` (${p.reason})` : ''}`;
      if (event.eventType === 'failed') return `${cap(event.actor)} failed on ${subjectLabel(event)}`;
      if (event.eventType === 'signal') return `${cap(event.actor)} noted a signal on ${subjectLabel(event)}`;
      return `${cap(event.actor)} ${event.eventType}`;
  }
}

function plural(n: number, one: string, many = `${one}s`): string {
  return n === 1 ? one : many;
}
function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/** Group key: one logical activity. A run's events share a `runId`; runless events stand alone. */
function groupKey(event: AuditEvent): string {
  return event.runId ?? `${event.actor}:${event.provenance.file}:${event.provenance.line}`;
}

/**
 * Curate an event stream into the human-friendly feed (AUDIT-5). Events are grouped into runs;
 * each run is summarized from its most significant event and keeps its raw events for drill-down.
 * Input order is irrelevant — entries come back newest-first by representative ts.
 */
export function buildFeed(events: readonly AuditEvent[]): ActivityFeedEntry[] {
  const groups = new Map<string, AuditEvent[]>();
  for (const e of events) {
    const key = groupKey(e);
    const g = groups.get(key);
    if (g) g.push(e);
    else groups.set(key, [e]);
  }

  const entries: ActivityFeedEntry[] = [];
  for (const [id, group] of groups) {
    group.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : a.provenance.line - b.provenance.line));
    const headline = group.reduce((best, e) =>
      significance(e.eventType) > significance(best.eventType) ? e : e.ts >= best.ts && significance(e.eventType) === significance(best.eventType) ? e : best,
    );
    entries.push({
      id,
      ts: group[group.length - 1].ts,
      actor: headline.actor,
      summary: digestEvent(headline),
      eventCount: group.length,
      events: group,
    });
  }
  entries.sort((a, b) => (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : 0));
  return entries;
}
