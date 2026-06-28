// Curation engine (SPEC-0029 AUDIT-5). Deterministic templates per event-type + run-grouping; the
// raw events ride along each feed entry for drill-down.
import { describe, it, expect } from 'vitest';
import { digestEvent, buildFeed, shortRef, filterFeedByText } from './activityDigest';
import type { ActivityFeedEntry } from './activityDigest';
import type { AuditEvent, AuditActor } from './audit';

let line = 0;
function ev(actor: AuditActor, eventType: string, over: Partial<AuditEvent> = {}): AuditEvent {
  return {
    ts: over.ts ?? '2026-01-01T00:00:00.000Z',
    actor,
    eventType,
    subjects: over.subjects ?? {},
    payload: over.payload ?? {},
    provenance: over.provenance ?? { file: 'f', line: line++ },
    ...(over.runId ? { runId: over.runId } : {}),
    ...(over.model ? { model: over.model } : {}),
  };
}

describe('shortRef — raw ULID shortening (Activity v2; never raw unbounded inline text)', () => {
  it('shortens a long opaque ULID but leaves names / piped keys / short ids intact', () => {
    expect(shortRef('01KW6CW289ZZZZZZZZZZZZZZZZ')).toBe('01KW6CW2…'); // 26-char ULID → prefix…
    expect(shortRef('Atlas')).toBe('Atlas'); // short id untouched
    expect(shortRef('E1')).toBe('E1');
    expect(shortRef('person|atlas')).toBe('person|atlas'); // block key (has a pipe) untouched
  });

  it('a digest summary inlines the SHORTENED id, so it can never wrap mid-token into the timestamp', () => {
    const s = digestEvent(ev('enrich', 'signal', { subjects: { entityId: '01KW6CW289ZZZZZZZZZZZZZZZZ' } }));
    expect(s).toBe('Enrich noted a signal on 01KW6CW2…');
    expect(s).not.toContain('01KW6CW289ZZZZZZZZZZZZZZZZ'); // the full unbounded ULID is gone
  });
});

describe('digestEvent — deterministic templates (AUDIT-5 / AUTO-9)', () => {
  it('renders a human-friendly line per headline event-type', () => {
    expect(digestEvent(ev('archivist', 'archived', { subjects: { sourceId: 'S1' } }))).toBe('Archived a new source');
    expect(digestEvent(ev('decompose', 'decomposed', { payload: { candidates: 3 } }))).toBe('Decompose extracted 3 candidate entities');
    expect(digestEvent(ev('decompose', 'decomposed', { payload: { candidates: 1 } }))).toBe('Decompose extracted 1 candidate entity');
    expect(digestEvent(ev('claims', 'claimed', { subjects: { entityId: 'Atlas' }, payload: { claims: 2 } }))).toBe('Claims derived 2 claims about Atlas');
    expect(digestEvent(ev('connect', 'resolved', { subjects: { entityId: 'Atlas' }, payload: { candidates: 3, merged: 2 } }))).toBe('Connect resolved 3 candidates into Atlas (merged 2)');
    expect(digestEvent(ev('connect', 'connected', { payload: { clusters: 4 } }))).toBe('Connect resolved 4 clusters');
    expect(digestEvent(ev('job', 'job-run', { subjects: { jobId: 'reflect' }, payload: { applied: 2, deferred: 1 } }))).toBe('Job reflect ran — 2 applied, 1 deferred');
    expect(digestEvent(ev('recall', 'recall', { payload: { question: 'who is Atlas?' } }))).toBe('Answered a question: "who is Atlas?"');
    expect(digestEvent(ev('replay', 'replay-reset'))).toBe('Full rebuild — reset derived stages');
    expect(digestEvent(ev('panel', 'job-config-change', { subjects: { jobId: 'reflect' }, payload: { field: 'enabled', from: false, to: true } }))).toBe('Config change — enabled on reflect (false → true)');
  });

  it('handles generic / mid-run event-types with sensible fallbacks', () => {
    expect(digestEvent(ev('claims', 'setaside', { subjects: { entityId: 'E1' }, payload: { reason: 'review-cascade-cap' } }))).toBe('Claims set aside E1 (review-cascade-cap)');
    expect(digestEvent(ev('decompose', 'failed', { subjects: { sourceId: 'S1' } }))).toBe('Decompose failed on S1');
    expect(digestEvent(ev('connect', 'signal', { subjects: { blockKey: 'k' } }))).toBe('Connect noted a signal on k');
    expect(digestEvent(ev('claims', 'mystery-event', { subjects: {} }))).toBe('Claims mystery-event');
  });
});

describe('buildFeed — run grouping + drill-down (AUDIT-5)', () => {
  it('collapses one run (same runId) into a single entry summarized from the headline event', () => {
    const events = [
      ev('claims', 'start', { runId: 'R1', subjects: { entityId: 'E1' }, ts: '2026-01-01T00:00:00.000Z' }),
      ev('claims', 'signal', { runId: 'R1', subjects: { entityId: 'E1' }, ts: '2026-01-01T00:00:01.000Z' }),
      ev('claims', 'claimed', { runId: 'R1', subjects: { entityId: 'E1' }, payload: { claims: 2 }, ts: '2026-01-01T00:00:02.000Z' }),
    ];
    const feed = buildFeed(events);
    expect(feed).toHaveLength(1);
    expect(feed[0]).toMatchObject({ id: 'R1', actor: 'claims', summary: 'Claims derived 2 claims about E1', eventCount: 3 });
    expect(feed[0].events).toHaveLength(3); // raw events preserved for drill-down
    expect(feed[0].ts).toBe('2026-01-01T00:00:02.000Z'); // representative ts = newest in group
  });

  it('keeps runless events (archived, recall, replay) as standalone entries', () => {
    const events = [
      ev('archivist', 'archived', { subjects: { sourceId: 'S1' }, ts: '2026-01-01T00:00:00.000Z' }),
      ev('recall', 'recall', { payload: { question: 'q' }, ts: '2026-01-01T00:00:01.000Z' }),
    ];
    const feed = buildFeed(events);
    expect(feed).toHaveLength(2);
    expect(feed.every((e) => e.eventCount === 1)).toBe(true);
  });

  it('orders entries newest-first by representative ts', () => {
    const events = [
      ev('archivist', 'archived', { subjects: { sourceId: 'S1' }, ts: '2026-01-01T00:00:00.000Z' }),
      ev('claims', 'claimed', { runId: 'R1', subjects: { entityId: 'E1' }, payload: { claims: 1 }, ts: '2026-01-03T00:00:00.000Z' }),
      ev('decompose', 'decomposed', { runId: 'R2', payload: { candidates: 1 }, ts: '2026-01-02T00:00:00.000Z' }),
    ];
    const feed = buildFeed(events);
    expect(feed.map((e) => e.ts)).toEqual(['2026-01-03T00:00:00.000Z', '2026-01-02T00:00:00.000Z', '2026-01-01T00:00:00.000Z']);
  });
});

describe('filterFeedByText — search hits the VISIBLE summary (SPEC-0060 VUX-14)', () => {
  // The bug class: search ran on the raw event stream (actor/eventType/subjects/payload), so a word
  // the Principal could plainly READ in a curated summary ("Archived…", "Connect resolved…") did not
  // match. The fix searches the built feed by its summary text. These rows model that gap directly.
  const entries: ActivityFeedEntry[] = [
    { id: 'R1', ts: '2026-01-03T00:00:00.000Z', actor: 'connect', summary: 'Connect resolved 3 candidates into Project Atlas', eventCount: 1,
      events: [ev('connect', 'resolved', { runId: 'R1', subjects: { entityId: 'ent_9f2c' }, payload: { candidates: 3 } })] },
    { id: 'R2', ts: '2026-01-02T00:00:00.000Z', actor: 'archivist', summary: 'Archived a new source', eventCount: 1,
      events: [ev('archivist', 'archived', { runId: 'R2', subjects: { sourceId: 'src_obsidian_note' } })] },
  ];

  it('matches a word that appears ONLY in the curated summary (the original miss)', () => {
    // "Atlas" lives in the summary, not in any raw field — the old per-event haystack missed it.
    expect(filterFeedByText(entries, 'atlas').map((e) => e.id)).toEqual(['R1']);
    expect(filterFeedByText(entries, 'archived').map((e) => e.id)).toEqual(['R2']);
  });

  it('still matches a token visible only in the drill-down raw events (e.g. a source id)', () => {
    expect(filterFeedByText(entries, 'obsidian').map((e) => e.id)).toEqual(['R2']);
  });

  it('is case-insensitive and returns every entry for empty / whitespace text', () => {
    expect(filterFeedByText(entries, 'CONNECT').map((e) => e.id)).toEqual(['R1']);
    expect(filterFeedByText(entries, '   ')).toHaveLength(2);
    expect(filterFeedByText(entries, '')).toHaveLength(2);
  });

  it('tolerates legacy/partial entries — missing summary or missing events never throws (ENG-15/16)', () => {
    const legacy = [
      { id: 'L1', ts: '2026-01-01T00:00:00.000Z', actor: 'claims', eventCount: 0 } as unknown as ActivityFeedEntry, // no summary, no events
      { id: 'L2', ts: '2026-01-01T00:00:00.000Z', actor: 'claims', summary: 'Claims derived 2 claims', eventCount: 1, events: undefined } as unknown as ActivityFeedEntry,
      ...entries,
    ];
    expect(() => filterFeedByText(legacy, 'claims')).not.toThrow();
    expect(filterFeedByText(legacy, 'claims').map((e) => e.id)).toEqual(['L2']);
    expect(filterFeedByText(legacy, 'atlas').map((e) => e.id)).toEqual(['R1']); // good rows still searchable
  });
});
