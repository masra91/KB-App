// SPEC-0058 STATE-7 — the pure Today projection builder. Node tier (DOM-free). Asserts the real assembly
// logic: salutation-by-hour, stat deltas (up/flat), the honest line-meta, decision ordering + rest state,
// health thresholds, compact relative-time, activity cap, and ENG-15/16 coalescing of garbage numerics.
import { describe, it, expect } from 'vitest';
import { buildTodayProjection, salutationFor, compactAgo, activityKind, todayActivityFromFeed, todayHealthFromProjection, countConnections, assembleTodayProjection, type TodayInputs, type TodaySources } from './todayProjection';
import type { ActivityFeedEntry } from './activityDigest';
import type { HealthProjection } from './healthProjection';
import type { GraphProjection } from './graphProjection';
import type { PipelineStatusView } from './types';

function inputs(over: Partial<TodayInputs> = {}): TodayInputs {
  return {
    name: 'Alex',
    counts: { sources: 214, claims: 1847, entities: 392, connections: 1204 },
    todayDeltas: { sources: 6, claims: 38, entities: 0, connections: 21 },
    stations: [
      { name: 'Capture', stage: 'capture', state: 'idle', glyph: '○', count: 214 },
      { name: 'Decompose', stage: 'decompose', state: 'running', glyph: '▣', count: 2 },
      { name: 'Claims', stage: 'claims', state: 'idle', glyph: '○', count: 0 },
    ],
    inFlight: 2,
    lastComposedAgoMs: 6 * 60_000,
    activity: [
      { kind: 'composed', text: 'Composed a page for Atlas', ref: '[[Project Atlas]]', agoMs: 6 * 60_000 },
      { kind: 'connected', text: 'Connected 7 claims', agoMs: 22 * 60_000 },
    ],
    openReviews: 0,
    contradictions: 0,
    health: { dangling: 0, orphans: 0, thin: 11 },
    movedRecently: 3,
    ...over,
  };
}

const NOON = Date.parse('2026-06-27T13:00:00');
const EVENING = Date.parse('2026-06-27T23:48:00');
const MORNING = Date.parse('2026-06-27T08:00:00');

describe('salutationFor (time-of-day)', () => {
  it('maps the local hour to morning/afternoon/evening', () => {
    expect(salutationFor(MORNING)).toBe('Good morning');
    expect(salutationFor(NOON)).toBe('Good afternoon');
    expect(salutationFor(EVENING)).toBe('Good evening');
  });
});

describe('compactAgo', () => {
  it('formats compact relative ages', () => {
    expect(compactAgo(30_000)).toBe('now');
    expect(compactAgo(6 * 60_000)).toBe('6m');
    expect(compactAgo(2 * 3_600_000)).toBe('2h');
    expect(compactAgo(3 * 86_400_000)).toBe('3d');
    expect(compactAgo(-5)).toBe('now'); // never negative
  });
});

describe('buildTodayProjection', () => {
  it('assembles the greeting (salutation + name); drops the name when blank', () => {
    expect(buildTodayProjection(inputs(), EVENING).greeting).toEqual({ salutation: 'Good evening', name: 'Alex' });
    expect(buildTodayProjection(inputs({ name: '   ' }), EVENING).greeting).toEqual({ salutation: 'Good evening' });
  });

  it('builds the 4 stats with up/flat deltas', () => {
    const stats = buildTodayProjection(inputs(), NOON).stats;
    expect(stats.map((s) => s.key)).toEqual(['sources', 'claims', 'entities', 'connections']);
    expect(stats[0]).toMatchObject({ label: 'Sources', value: 214, delta: { dir: 'up', text: '+6 today' } });
    expect(stats[2]).toMatchObject({ key: 'entities', delta: { dir: 'flat', text: 'stable' } }); // 0 today → stable
  });

  it('writes an honest line-meta (in-flight + last composed), incl. the empty/never cases', () => {
    expect(buildTodayProjection(inputs(), NOON).line.meta).toBe('2 in flight · last composed 6m ago');
    expect(buildTodayProjection(inputs({ inFlight: 0, lastComposedAgoMs: null }), NOON).line.meta).toBe('nothing in flight · nothing composed yet');
    expect(buildTodayProjection(inputs(), NOON).line.stations).toHaveLength(3); // passed through
  });

  it('subtitle is calm when nothing needs you, and pluralizes the moved count', () => {
    expect(buildTodayProjection(inputs(), NOON).subtitle).toMatch(/quiet and current — 3 things moved/);
    expect(buildTodayProjection(inputs({ movedRecently: 1 }), NOON).subtitle).toMatch(/1 thing moved/);
    expect(buildTodayProjection(inputs({ movedRecently: 0 }), NOON).subtitle).toMatch(/nothing moved/);
    // not calm when something needs you
    expect(buildTodayProjection(inputs({ openReviews: 2 }), NOON).subtitle).toMatch(/^Your library is current/);
  });

  it('decisions are contradiction-first, then reviews; empty array is the calm rest state', () => {
    expect(buildTodayProjection(inputs(), NOON).decisions).toEqual([]); // nothing needs you
    const both = buildTodayProjection(inputs({ contradictions: 1, openReviews: 2 }), NOON).decisions;
    expect(both.map((d) => d.kind)).toEqual(['contradiction', 'review']); // contradiction leads
    expect(both[0]).toMatchObject({ title: 'A contradiction surfaced', action: 'Resolve', targetView: 'reviews' });
    expect(both[1].title).toBe('2 reviews waiting');
  });

  it('health glance = dangling/orphans/thin with ok|warn|bad (identical to the Health projection)', () => {
    const health = buildTodayProjection(inputs(), NOON).health;
    expect(health.map((h) => h.key)).toEqual(['dangling', 'orphans', 'thin']); // no Grounding (deferred)
    expect(health[0]).toMatchObject({ value: '0', status: 'ok' }); // no dangling
    expect(health[1]).toMatchObject({ value: '0', status: 'ok' }); // no orphans
    expect(health[2]).toMatchObject({ value: '11', status: 'warn' }); // thin stubs > 0 → brass warn
    // a dangling (dead) link is BAD (oxide), not warn — matches DL-2's HealthProjection severity
    const bad = buildTodayProjection(inputs({ health: { dangling: 3, orphans: 2, thin: 0 } }), NOON).health;
    expect(bad[0]).toMatchObject({ key: 'dangling', value: '3', status: 'bad' });
    expect(bad[1]).toMatchObject({ key: 'orphans', value: '2', status: 'warn' });
  });

  it('caps the activity feed at 5, newest-first, with compact ages', () => {
    const many = Array.from({ length: 9 }, (_v, i) => ({ kind: 'captured' as const, text: `e${i}`, agoMs: i * 60_000 }));
    const out = buildTodayProjection(inputs({ activity: many }), NOON).activity;
    expect(out).toHaveLength(5);
    expect(out[0]).toMatchObject({ text: 'e0', when: 'now' });
    expect(out[1].when).toBe('1m');
  });

  it('ENG-15/16: coalesces garbage/missing numerics instead of leaking NaN/undefined', () => {
    const dirty = buildTodayProjection(
      inputs({
        counts: { sources: NaN, claims: -3, entities: 1.9, connections: undefined as unknown as number },
        todayDeltas: { sources: undefined as unknown as number, claims: -1, entities: 0, connections: 4 },
        health: { dangling: NaN, orphans: 1.5, thin: -2 },
      }),
      NOON,
    );
    expect(dirty.stats[0].value).toBe(0); // NaN → 0
    expect(dirty.stats[1].value).toBe(0); // -3 → clamped 0
    expect(dirty.stats[0].delta).toEqual({ dir: 'flat', text: 'stable' }); // undefined delta → stable
    expect(dirty.stats[3].delta).toEqual({ dir: 'up', text: '+4 today' });
    expect(dirty.health[0]).toMatchObject({ key: 'dangling', value: '0', status: 'ok' }); // NaN → 0 → ok
    expect(dirty.health[1].value).toBe('1'); // 1.5 orphans → floor 1
    expect(dirty.health[2].value).toBe('0'); // -2 thin → 0
  });
});

describe('todayActivityFromFeed (compose upstream → activity items)', () => {
  const entry = (over: Partial<ActivityFeedEntry>): ActivityFeedEntry =>
    ({ id: 'r', ts: '2026-06-27T11:54:00.000Z', actor: 'connect', summary: 'Connected 7 claims', eventCount: 1, events: [], ...over }) as ActivityFeedEntry;
  const NOW = Date.parse('2026-06-27T12:00:00.000Z');

  it('maps the actor → activity kind', () => {
    expect(activityKind('compose')).toBe('composed');
    expect(activityKind('connect')).toBe('connected');
    expect(activityKind('claims')).toBe('extracted');
    expect(activityKind('archivist')).toBe('captured');
    expect(activityKind('reflect')).toBe('other'); // unmapped → other (never a thrown/blank glyph)
  });

  it('maps entries newest-first with kind/text/age, capped', () => {
    const feed = [
      entry({ actor: 'compose', summary: 'Composed a page', ts: '2026-06-27T11:54:00.000Z' }), // 6m ago
      entry({ actor: 'claims', summary: 'Extracted 38 claims', ts: '2026-06-27T11:18:00.000Z' }), // 42m
    ];
    const out = todayActivityFromFeed(feed, NOW);
    expect(out[0]).toMatchObject({ kind: 'composed', text: 'Composed a page', agoMs: 6 * 60_000 });
    expect(out[1]).toMatchObject({ kind: 'extracted', text: 'Extracted 38 claims' });
  });

  it('caps the feed + tolerates a malformed ts (no NaN age) and missing fields (ENG-15/16)', () => {
    const many = Array.from({ length: 9 }, (_v, i) => entry({ id: String(i) }));
    expect(todayActivityFromFeed(many, NOW, 5)).toHaveLength(5);
    const bad = todayActivityFromFeed([{ actor: 'connect' } as unknown as ActivityFeedEntry], NOW);
    expect(bad[0]).toEqual({ kind: 'connected', text: '', agoMs: 0 }); // no ts/summary → 0 age + ''
  });
});

describe('todayHealthFromProjection (HealthProjection dimensions → counts)', () => {
  const health = (counts: { dangling: number; orphans: number; thin: number }): HealthProjection =>
    ({
      status: 'ready',
      overall: 'attention',
      totalIssues: counts.dangling + counts.orphans + counts.thin,
      dimensions: [
        { key: 'dangling', label: 'Dead links', desc: '', severity: counts.dangling ? 'bad' : 'ok', count: counts.dangling, findings: [] },
        { key: 'orphans', label: 'Orphans', desc: '', severity: counts.orphans ? 'warn' : 'ok', count: counts.orphans, findings: [] },
        { key: 'thin', label: 'Thin pages', desc: '', severity: counts.thin ? 'warn' : 'ok', count: counts.thin, findings: [] },
      ],
    }) as unknown as HealthProjection;

  it('pulls each dimension count by key', () => {
    expect(todayHealthFromProjection(health({ dangling: 3, orphans: 2, thin: 11 }))).toEqual({ dangling: 3, orphans: 2, thin: 11 });
  });

  it('null/warming projection or missing dimensions → all 0 (ENG-15/16)', () => {
    expect(todayHealthFromProjection(null)).toEqual({ dangling: 0, orphans: 0, thin: 0 });
    expect(todayHealthFromProjection({ status: 'warming', dimensions: [] } as unknown as HealthProjection)).toEqual({ dangling: 0, orphans: 0, thin: 0 });
  });

  it('round-trips through buildTodayProjection to the same severity DEV-2 bakes', () => {
    const inputsHealth = todayHealthFromProjection(health({ dangling: 1, orphans: 0, thin: 4 }));
    const proj = buildTodayProjection(inputs({ health: inputsHealth }), NOON);
    expect(proj.health[0]).toMatchObject({ key: 'dangling', status: 'bad' }); // dangling → oxide
    expect(proj.health[2]).toMatchObject({ key: 'thin', status: 'warn' }); // thin → brass
  });
});

describe('countConnections (graph backlinks → the Connections stat)', () => {
  it('sums every precomputed backlink across the graph', () => {
    const graph = { backlinks: { 'e/a.md': [{ from: 'b', to: 'a' }, { from: 'c', to: 'a' }], 'e/b.md': [{ from: 'c', to: 'b' }] } } as unknown as GraphProjection;
    expect(countConnections(graph)).toBe(3);
  });

  it('null/warming graph or malformed backlinks → 0 (ENG-15/16, no live walk)', () => {
    expect(countConnections(null)).toBe(0);
    expect(countConnections({} as unknown as GraphProjection)).toBe(0);
    expect(countConnections({ backlinks: { 'e/a.md': 'bad' as unknown as [] } } as unknown as GraphProjection)).toBe(0);
  });
});

describe('assembleTodayProjection (compose maintained reads → the full projection)', () => {
  const sources = (over: Partial<TodaySources> = {}): TodaySources => ({
    status: { conversion: { captured: 214, candidates: 30, entities: 392, claims: 1847, promoted: 6 } } as unknown as PipelineStatusView,
    graph: { backlinks: { a: [{ from: 'x', to: 'a' }], b: [{ from: 'y', to: 'b' }, { from: 'z', to: 'b' }] } } as unknown as GraphProjection,
    health: { status: 'ready', dimensions: [{ key: 'dangling', count: 0, severity: 'ok' }, { key: 'orphans', count: 0, severity: 'ok' }, { key: 'thin', count: 11, severity: 'warn' }] } as unknown as HealthProjection,
    activity: [{ id: 'r', ts: '2026-06-27T11:54:00.000Z', actor: 'compose', summary: 'Composed a page', eventCount: 1, events: [] } as ActivityFeedEntry],
    stations: [{ name: 'Capture', stage: 'capture', state: 'idle', glyph: '○', count: 214 }, { name: 'Compose', stage: 'compose', state: 'idle', glyph: '○', count: 0 }],
    openReviews: 2,
    contradictions: 1,
    inFlight: 2,
    lastComposedAgoMs: 6 * 60_000,
    movedRecently: 3,
    ...over,
  });
  const EVENING = Date.parse('2026-06-27T23:48:00');

  it('maps every section from the maintained reads into the locked contract shape', () => {
    const p = assembleTodayProjection(sources(), EVENING);
    expect(p.greeting).toEqual({ salutation: 'Good evening' }); // name omitted (v1)
    expect(p.stats.map((s) => [s.key, s.value])).toEqual([['sources', 214], ['claims', 1847], ['entities', 392], ['connections', 3]]); // connections = 3 backlinks
    expect(p.health.find((h) => h.key === 'thin')).toMatchObject({ value: '11', status: 'warn' });
    expect(p.activity[0]).toMatchObject({ kind: 'composed', text: 'Composed a page' });
    expect(p.decisions.map((d) => d.kind)).toEqual(['contradiction', 'review']); // 1 contradiction + 2 reviews
    expect(p.line.stations).toHaveLength(2); // injected, passed through
    expect(p.line.meta).toBe('2 in flight · last composed 6m ago');
  });

  it('a warming/empty backend (null status/graph/health) assembles a calm, non-crashing projection', () => {
    const p = assembleTodayProjection(sources({ status: null, graph: null, health: null, activity: [], stations: [], openReviews: 0, contradictions: 0, inFlight: 0, lastComposedAgoMs: null, movedRecently: 0 }), EVENING);
    expect(p.stats.every((s) => s.value === 0)).toBe(true);
    expect(p.health.every((h) => h.status === 'ok')).toBe(true);
    expect(p.decisions).toEqual([]); // calm rest state
    expect(p.line.meta).toBe('nothing in flight · nothing composed yet');
  });
});
