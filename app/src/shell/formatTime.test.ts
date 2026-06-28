// #3 — friendly timestamp formatter. Node tier (pure; `now` injected for determinism).
import { describe, it, expect } from 'vitest';
import { formatTimestamp, relativeCompact } from './formatTime';

const NOW = Date.parse('2026-06-02T12:00:00.000Z');

describe('formatTimestamp (#3)', () => {
  it('renders null/empty as an em-dash (never a blank or "Invalid Date")', () => {
    expect(formatTimestamp(null, NOW)).toBe('—');
    expect(formatTimestamp(undefined, NOW)).toBe('—');
    expect(formatTimestamp('', NOW)).toBe('—');
  });

  it('passes an unparseable string through unchanged (show, don’t hide)', () => {
    expect(formatTimestamp('not-a-date', NOW)).toBe('not-a-date');
  });

  it('renders recent times relative', () => {
    expect(formatTimestamp('2026-06-02T11:59:30.000Z', NOW)).toBe('just now');
    expect(formatTimestamp('2026-06-02T11:45:00.000Z', NOW)).toBe('15 min ago');
    expect(formatTimestamp('2026-06-02T09:00:00.000Z', NOW)).toBe('3 hr ago');
    expect(formatTimestamp('2026-06-01T11:00:00.000Z', NOW)).toBe('yesterday');
    expect(formatTimestamp('2026-05-31T11:00:00.000Z', NOW)).toBe('2 days ago');
  });

  it('renders older times as an absolute date (no "ago"), and never shows a raw ISO string', () => {
    const s = formatTimestamp('2026-04-01T11:00:00.000Z', NOW);
    expect(s).not.toContain('ago');
    expect(s).not.toContain('T'); // not the raw ISO
    expect(s).toMatch(/Apr/);
  });

  it('handles a future stamp gracefully (date, no negative "ago")', () => {
    const s = formatTimestamp('2026-07-01T11:00:00.000Z', NOW);
    expect(s).not.toContain('ago');
    expect(s).not.toContain('-'); // no negative diff leaking
  });
});

describe('relativeCompact (UX v2 Activity — dense log timestamps)', () => {
  it('renders compact units (no "ago"/"min"/"hr"): just now / Nm / Nh / Nd / Nw', () => {
    expect(relativeCompact('2026-06-02T11:59:30.000Z', NOW)).toBe('just now');
    expect(relativeCompact('2026-06-02T11:54:00.000Z', NOW)).toBe('6m');
    expect(relativeCompact('2026-06-02T11:38:00.000Z', NOW)).toBe('22m');
    expect(relativeCompact('2026-06-02T09:00:00.000Z', NOW)).toBe('3h');
    expect(relativeCompact('2026-05-31T12:00:00.000Z', NOW)).toBe('2d');
    expect(relativeCompact('2026-05-19T12:00:00.000Z', NOW)).toBe('2w');
  });

  it('falls back to an absolute date past ~4 weeks (never a raw ISO)', () => {
    const s = relativeCompact('2026-04-01T11:00:00.000Z', NOW);
    expect(s).not.toContain('T');
    expect(s).toMatch(/Apr/);
  });

  it('shares formatTimestamp’s null/unparseable/future tolerance', () => {
    expect(relativeCompact(null, NOW)).toBe('—');
    expect(relativeCompact('not-a-date', NOW)).toBe('not-a-date');
    expect(relativeCompact('2026-07-01T11:00:00.000Z', NOW)).not.toContain('-'); // future → date, no negative
  });
});
