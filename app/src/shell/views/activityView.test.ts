// @vitest-environment happy-dom
//
// SPEC-0029 AUDIT-5/6/7/8 — the Activity view, component tier (happy-dom, per-file env; node tier
// stays default). The IPC is mocked (`window.kbApi.activityFeed/activityLineage`); we assert the
// rendered DOM, the drill-down, the filter→re-query, lineage, and read-only/escaping behavior.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mountActivity } from './activityView';
import { LOAD_TIMEOUT_MS } from '../loadGuard';
import type { ActivityFeedResult, Lineage, KbApi } from '../../kb/types';

function feed(entries: ActivityFeedResult['entries'], total = entries.length, truncated = false): ActivityFeedResult {
  return { entries, total, truncated };
}

const ENTRIES: ActivityFeedResult['entries'] = [
  {
    id: 'C1',
    ts: '2026-01-01T00:02:00.000Z',
    actor: 'claims',
    summary: 'Claims derived 2 claims about E1',
    eventCount: 2,
    events: [
      { ts: '2026-01-01T00:01:00.000Z', actor: 'claims', eventType: 'start', subjects: { entityId: 'E1', sourceId: 'S1' }, payload: {}, provenance: { file: 'sources/2026/01/S1/audit.jsonl', line: 1 }, runId: 'C1' },
      { ts: '2026-01-01T00:02:00.000Z', actor: 'claims', eventType: 'claimed', subjects: { entityId: 'E1', sourceId: 'S1' }, payload: { claims: 2 }, provenance: { file: 'sources/2026/01/S1/audit.jsonl', line: 2 }, runId: 'C1' },
    ],
  },
  {
    id: 'A1',
    ts: '2026-01-01T00:00:00.000Z',
    actor: 'archivist',
    summary: 'Archived a new source',
    eventCount: 1,
    events: [{ ts: '2026-01-01T00:00:00.000Z', actor: 'archivist', eventType: 'archived', subjects: { sourceId: 'S1' }, payload: {}, provenance: { file: 'sources/2026/01/S1/audit.jsonl', line: 0 } }],
  },
];

let activityFeed: ReturnType<typeof vi.fn>;
let activityLineage: ReturnType<typeof vi.fn>;

function setApi(): void {
  (window as unknown as { kbApi: Pick<KbApi, 'activityFeed' | 'activityLineage'> }).kbApi = {
    activityFeed: activityFeed as unknown as KbApi['activityFeed'],
    activityLineage: activityLineage as unknown as KbApi['activityLineage'],
  };
}

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  activityFeed = vi.fn(async () => feed(ENTRIES, 3)); // 2 entries summarizing 3 raw events
  activityLineage = vi.fn(async () => ({ subjectId: 'E1', kind: 'entity', sources: ['S1'], events: ENTRIES[0].events, decisions: [] }) as Lineage);
  setApi();
});

async function mount(): Promise<HTMLElement> {
  const c = document.createElement('div');
  document.body.appendChild(c);
  mountActivity(c);
  await flush();
  return c;
}

describe('Activity feed (AUDIT-5)', () => {
  it('renders curated entries newest-first with an event count', async () => {
    const c = await mount();
    const items = c.querySelectorAll('.activity-entry');
    expect(items).toHaveLength(2);
    expect(c.querySelector('.activity-summary')?.textContent).toContain('Claims derived 2 claims about E1');
    expect(c.textContent).toContain('2 events'); // the multi-event run shows its count
    expect(c.querySelector('.activity-count')?.textContent).toContain('3 events'); // total, not entry count
  });

  it('surfaces truncation (never silently) when the window capped older events', async () => {
    activityFeed = vi.fn(async () => feed(ENTRIES, 500, true));
    setApi();
    const c = await mount();
    expect(c.querySelector('.activity-truncation')?.textContent).toContain('most recent of 500');
  });

  it('shows an empty state when there is no activity', async () => {
    activityFeed = vi.fn(async () => feed([]));
    setApi();
    const c = await mount();
    expect(c.querySelector('.activity-empty')).not.toBeNull();
  });

  it('shows an error state when the feed fails to load', async () => {
    activityFeed = vi.fn(async () => {
      throw new Error('boom');
    });
    setApi();
    const c = await mount();
    expect(c.querySelector('.activity-error')?.textContent).toContain('boom');
  });
});

describe('Drill-down to raw events (AUDIT-5)', () => {
  it('toggles the raw canonical events behind an entry on click', async () => {
    const c = await mount();
    const head = c.querySelector<HTMLButtonElement>('.activity-entry-head')!; // first entry (claims, C1)
    expect(c.querySelector('.activity-raw')).toBeNull();
    head.click();
    expect(c.querySelector('.activity-raw')).not.toBeNull();
    expect(c.querySelector('.activity-raw')?.textContent).toContain('"eventType": "claimed"');
    expect(c.querySelectorAll('.activity-event')).toHaveLength(2); // both raw events in the run
    expect(c.textContent).toContain('sources/2026/01/S1/audit.jsonl:2'); // provenance shown
    // re-query: the body innerHTML was swapped on toggle, so the prior node is detached.
    c.querySelector<HTMLButtonElement>('.activity-entry-head')!.click(); // collapse
    expect(c.querySelector('.activity-raw')).toBeNull();
  });
});

describe('Filter / search (AUDIT-7)', () => {
  it('re-queries the feed with a text filter as the Principal types', async () => {
    const c = await mount();
    const search = c.querySelector<HTMLInputElement>('#activitySearch')!;
    search.value = 'atlas';
    search.dispatchEvent(new Event('input', { bubbles: true }));
    await flush();
    expect(activityFeed).toHaveBeenLastCalledWith({ text: 'atlas' });
  });

  it('re-queries with an actor filter; the dropdown is seeded from the loaded actors', async () => {
    const c = await mount();
    const sel = c.querySelector<HTMLSelectElement>('#activityActor')!;
    // options: "All" + the two actors present (archivist, claims), sorted.
    expect([...sel.options].map((o) => o.value)).toEqual(['', 'archivist', 'claims']);
    sel.value = 'claims';
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    await flush();
    expect(activityFeed).toHaveBeenLastCalledWith({ actors: ['claims'] });
  });
});

describe('Lineage (AUDIT-6)', () => {
  it('traces a subject and renders its provenance + timeline, then closes', async () => {
    const c = await mount();
    const traceBtn = c.querySelector<HTMLButtonElement>('.activity-trace')!; // claims entry → entityId E1
    traceBtn.click();
    await flush();
    expect(activityLineage).toHaveBeenCalledWith('E1');
    const panel = c.querySelector('.lineage-panel');
    expect(panel).not.toBeNull();
    expect(panel?.textContent).toContain('From source');
    expect(panel?.querySelectorAll('.lineage-step').length).toBeGreaterThan(0);
    c.querySelector<HTMLButtonElement>('[data-act="clear-lineage"]')!.click();
    expect(c.querySelector('.lineage-panel')).toBeNull();
  });

  // Regression (WS3 P1, KB-Lead defect): the "trace origin" action was an orphan <li> child flush to the
  // entry's left edge, off-center from the padded head. It must sit in the shared, aligned header row.
  it('keeps the trace-origin action in the aligned header row, not orphaned on the entry', async () => {
    const c = await mount();
    const row = c.querySelector('.activity-entry-row');
    expect(row).not.toBeNull();
    const traceBtn = c.querySelector<HTMLButtonElement>('.activity-trace')!;
    // trace lives inside the header row next to the toggle — not a bare child of the <li>.
    expect(traceBtn.closest('.activity-entry-row')).toBe(row);
    expect(traceBtn.parentElement).not.toBe(traceBtn.closest('.activity-entry'));
    expect(row!.querySelector('.activity-entry-head')).not.toBeNull();
  });
});

describe('Read-only + XSS-safety (AUDIT-8)', () => {
  it('escapes hostile content in summaries/payloads and renders no mutating controls', async () => {
    const hostile: ActivityFeedResult['entries'] = [
      {
        id: 'X1',
        ts: '2026-01-01T00:00:00.000Z',
        actor: 'recall',
        summary: 'Answered a question: "<img src=x onerror=alert(1)>"',
        eventCount: 1,
        events: [{ ts: '2026-01-01T00:00:00.000Z', actor: 'recall', eventType: 'recall', subjects: {}, payload: { question: '<script>alert(1)</script>' }, provenance: { file: '.kb/cache/ask/audit.jsonl', line: 0 } }],
      },
    ];
    activityFeed = vi.fn(async () => feed(hostile));
    setApi();
    const c = await mount();
    expect(c.querySelector('img')).toBeNull(); // summary not parsed as HTML
    c.querySelector<HTMLButtonElement>('.activity-entry-head')!.click();
    expect(c.querySelector('.activity-raw script')).toBeNull(); // raw payload not parsed as HTML
    expect(c.textContent).toContain('<script>alert(1)</script>'); // shown as text
    // read-only: no buttons that mutate (only toggle/lineage/clear — all read affordances)
    expect(c.querySelector('button.primary')).toBeNull();
  });
});

describe('Activity view · #145 load resilience (no infinite spinner on a hung IPC)', () => {
  let c: HTMLElement;
  beforeEach(() => {
    vi.useFakeTimers();
    c = document.createElement('div');
    document.body.appendChild(c);
  });
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    c.remove();
  });

  it('times out a hung activityFeed → retryable error, and Retry re-loads successfully', async () => {
    const activityFeed = vi.fn<KbApi['activityFeed']>().mockReturnValueOnce(new Promise<ActivityFeedResult>(() => {})); // hangs
    (window as unknown as { kbApi: Pick<KbApi, 'activityFeed'> }).kbApi = { activityFeed: activityFeed as unknown as KbApi['activityFeed'] };
    mountActivity(c);
    expect(c.textContent).toContain('Loading…'); // spinner initially

    await vi.advanceTimersByTimeAsync(LOAD_TIMEOUT_MS); // trip the timeout
    expect(c.textContent).not.toContain('Loading…'); // no infinite spinner
    expect(c.querySelector('.activity-error')).toBeTruthy();
    expect(c.querySelector('.load-retry')).toBeTruthy();

    // Retry succeeds → the feed renders.
    activityFeed.mockResolvedValueOnce(feed(ENTRIES, 3));
    c.querySelector<HTMLButtonElement>('.load-retry')!.click();
    await vi.advanceTimersByTimeAsync(0);
    expect(c.querySelectorAll('.activity-entry')).toHaveLength(2);
  });
});
