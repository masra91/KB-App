// SPEC-0058 STATE-7 — the pure Today projection builder. Node tier (DOM-free). Asserts the real assembly
// logic: salutation-by-hour, stat deltas (up/flat), the honest line-meta, decision ordering + rest state,
// health thresholds, compact relative-time, activity cap, and ENG-15/16 coalescing of garbage numerics.
import { describe, it, expect } from 'vitest';
import { buildTodayProjection, salutationFor, compactAgo, type TodayInputs } from './todayProjection';

function inputs(over: Partial<TodayInputs> = {}): TodayInputs {
  return {
    name: 'Alex',
    counts: { sources: 214, claims: 1847, entities: 392, connections: 1204 },
    todayDeltas: { sources: 6, claims: 38, entities: 0, connections: 21 },
    stations: [
      { name: 'Capture', count: 214, state: 'done' },
      { name: 'Decompose', count: 2, state: 'active' },
      { name: 'Claims', count: null, state: 'idle' },
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
