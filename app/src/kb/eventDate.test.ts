// Event-date normalization (SPEC-0025 META S2, ruling b) — pure, no FS. Proves precision is inferred from
// the value's granularity, the date is padded to a full Obsidian `date`, labels normalize to slugs, and
// junk is dropped (never a malformed Property).
import { describe, it, expect } from 'vitest';
import { normalizeEventLabel, normalizeEventDate, normalizeEventDates, eventPrecisionKey } from './eventDate';

describe('normalizeEventLabel', () => {
  it('slugifies to an Obsidian Property key', () => {
    expect(normalizeEventLabel('Founded')).toBe('founded');
    expect(normalizeEventLabel('First Released')).toBe('first-released');
    expect(normalizeEventLabel('  date_of_birth ')).toBe('date-of-birth');
    expect(normalizeEventLabel('!!!')).toBe(''); // normalizes to nothing → caller drops
  });
});

describe('normalizeEventDate — precision inferred from granularity, padded to a full date', () => {
  it('year-only → year precision, padded to Jan 1', () => {
    expect(normalizeEventDate('founded', '1976')).toEqual({ label: 'founded', date: '1976-01-01', precision: 'year' });
  });
  it('year-month → month precision, padded to the 1st', () => {
    expect(normalizeEventDate('released', '2007-06')).toEqual({ label: 'released', date: '2007-06-01', precision: 'month' });
  });
  it('full date → day precision', () => {
    expect(normalizeEventDate('released', '2007-06-29')).toEqual({ label: 'released', date: '2007-06-29', precision: 'day' });
  });
  it('drops an unparseable / non-ISO value (never a malformed Property)', () => {
    expect(normalizeEventDate('founded', 'April 1976')).toBeNull();
    expect(normalizeEventDate('founded', 'sometime')).toBeNull();
    expect(normalizeEventDate('founded', '76')).toBeNull(); // not 4-digit year
  });
  it('rejects a calendar-invalid month/day rather than writing a broken date', () => {
    expect(normalizeEventDate('x', '1976-13')).toBeNull();
    expect(normalizeEventDate('x', '1976-02-32')).toBeNull();
  });
  it('drops an empty label', () => {
    expect(normalizeEventDate('  ', '1976')).toBeNull();
  });
});

describe('normalizeEventDates — dedup by label (first wins), sorted', () => {
  it('dedups by normalized label and sorts deterministically', () => {
    const out = normalizeEventDates([
      { label: 'Released', value: '2007-06-29' },
      { label: 'founded', value: '1976' },
      { label: 'released', value: '2010' }, // dup label (normalizes to 'released') — first wins
      { label: 'bad', value: 'nope' }, // dropped
    ]);
    expect(out).toEqual([
      { label: 'founded', date: '1976-01-01', precision: 'year' },
      { label: 'released', date: '2007-06-29', precision: 'day' }, // first 'Released' kept, '2010' dropped
    ]);
  });
});

describe('eventPrecisionKey', () => {
  it('appends _precision', () => {
    expect(eventPrecisionKey('founded')).toBe('founded_precision');
  });
});
