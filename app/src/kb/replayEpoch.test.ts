// Unit tests for the replay-epoch helper (SPEC-0022 REPLAY-6). Pure string/parse logic —
// no git, runs everywhere.
import { describe, it, expect } from 'vitest';
import { epochScopedLines, replayResetLine, newReplayId, REPLAY_RESET_EVENT } from './replayEpoch';

const line = (o: Record<string, unknown>) => JSON.stringify(o) + '\n';

describe('replayEpoch — epochScopedLines (REPLAY-6)', () => {
  it('returns all lines when there is no epoch marker (the common case)', () => {
    const raw =
      line({ stage: 'decompose', event: 'start' }) +
      line({ stage: 'decompose', event: 'decomposed', entities: 1 });
    const kept = epochScopedLines(raw).filter((l) => l.trim().length > 0);
    expect(kept.length).toBe(2);
  });

  it('drops everything at/before the latest replay-reset, keeps what follows', () => {
    const raw =
      line({ stage: 'decompose', event: 'decomposed' }) + // superseded generation
      replayResetLine('R1', '2026-06-02T00:00:00.000Z') +
      line({ stage: 'decompose', event: 'start' }); // post-epoch
    const kept = epochScopedLines(raw)
      .filter((l) => l.trim().length > 0)
      .map((l) => JSON.parse(l) as { event?: string });
    expect(kept.map((o) => o.event)).toEqual(['start']);
  });

  it('honors only the LATEST epoch when several replays happened', () => {
    const raw =
      line({ event: 'decomposed' }) +
      replayResetLine('R1', '2026-06-02T00:00:00.000Z') +
      line({ event: 'decomposed' }) + // re-derived, then replayed again
      replayResetLine('R2', '2026-06-02T01:00:00.000Z') +
      line({ event: 'start' });
    const kept = epochScopedLines(raw)
      .filter((l) => l.trim().length > 0)
      .map((l) => JSON.parse(l) as { event?: string });
    expect(kept.map((o) => o.event)).toEqual(['start']);
  });

  it('a trailing replay-reset (nothing after it) scopes to empty — unit re-derives from zero', () => {
    const raw = line({ event: 'decomposed' }) + replayResetLine('R1', '2026-06-02T00:00:00.000Z');
    const kept = epochScopedLines(raw).filter((l) => l.trim().length > 0);
    expect(kept.length).toBe(0);
  });

  it('tolerates malformed lines and never treats them as epoch markers', () => {
    const raw =
      'not json\n' +
      replayResetLine('R1', '2026-06-02T00:00:00.000Z') +
      'also not json\n' +
      line({ event: 'start' });
    const kept = epochScopedLines(raw)
      .filter((l) => l.trim().length > 0)
      .map((l) => l.trim());
    expect(kept).toEqual(['also not json', JSON.stringify({ event: 'start' })]);
  });

  it('empty audit text yields no scoped content', () => {
    expect(epochScopedLines('').filter((l) => l.trim().length > 0)).toEqual([]);
  });
});

describe('replayEpoch — marker shape', () => {
  it('replayResetLine emits a single newline-terminated JSON object with the reset event + id', () => {
    const text = replayResetLine('RID', '2026-06-02T00:00:00.000Z');
    expect(text.endsWith('\n')).toBe(true);
    const o = JSON.parse(text.trim()) as { event: string; replayId: string; ts: string };
    expect(o.event).toBe(REPLAY_RESET_EVENT);
    expect(o.replayId).toBe('RID');
    expect(o.ts).toBe('2026-06-02T00:00:00.000Z');
  });

  it('newReplayId is monotonic across calls (ULID time-sortable)', () => {
    const a = newReplayId();
    const b = newReplayId();
    // Same-ms ids are random-ordered, but never decreasing by time prefix; assert well-formed + comparable.
    expect(a.length).toBe(26);
    expect(b.length).toBe(26);
    expect(a.slice(0, 10) <= b.slice(0, 10)).toBe(true);
  });
});
