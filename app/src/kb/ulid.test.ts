// Unit tests for the in-house ULID (SPEC-0013 CAPTURE-15). Pure, no FS/git.
import { describe, it, expect } from 'vitest';
import { ulid, ulidTime, dateShard, isUlid, ULID_LEN } from './ulid';

const CROCKFORD = /^[0-9ABCDEFGHJKMNPQRSTVWXYZ]+$/;

describe('ulid (CAPTURE-15)', () => {
  it('is 26 Crockford-base32 chars', () => {
    const id = ulid();
    expect(id).toHaveLength(ULID_LEN);
    expect(id).toMatch(CROCKFORD);
    expect(isUlid(id)).toBe(true);
  });

  it('is unique across many rapid calls (same millisecond)', () => {
    const now = 1_700_000_000_000;
    const ids = new Set(Array.from({ length: 1000 }, () => ulid(now)));
    expect(ids.size).toBe(1000);
  });

  it('sorts lexicographically by time', () => {
    const early = ulid(1_000_000_000_000);
    const late = ulid(2_000_000_000_000);
    expect(early < late).toBe(true);
  });

  it('round-trips the encoded timestamp via ulidTime', () => {
    const t = 1_711_987_324_000;
    expect(ulidTime(ulid(t))).toBe(t);
  });

  it('encodes the Unix epoch as all-zero time prefix', () => {
    expect(ulid(0).slice(0, 10)).toBe('0000000000');
    expect(ulidTime('0000000000' + 'X'.repeat(16))).toBe(0);
  });

  it('rejects invalid times', () => {
    expect(() => ulid(-1)).toThrow(RangeError);
    expect(() => ulid(NaN)).toThrow(RangeError);
    expect(() => ulid(Infinity)).toThrow(RangeError);
  });

  it('floors fractional times', () => {
    expect(ulidTime(ulid(1234.9))).toBe(1234);
  });
});

describe('ulidTime / parsing', () => {
  it('throws on a too-short id', () => {
    expect(() => ulidTime('ABC')).toThrow(RangeError);
  });

  it('throws on an invalid Crockford char', () => {
    expect(() => ulidTime('I000000000')).toThrow(RangeError); // I is excluded
  });
});

describe('dateShard (CAPTURE-15 / shard layout)', () => {
  it('derives a UTC YYYY/MM/DD path from the ULID time', () => {
    // 2024-04-01T15:22:04.000Z
    const id = ulid(Date.UTC(2024, 3, 1, 15, 22, 4));
    expect(dateShard(id)).toBe('2024/04/01');
  });

  it('zero-pads month and day', () => {
    const id = ulid(Date.UTC(2026, 0, 5, 0, 0, 0)); // 2026-01-05
    expect(dateShard(id)).toBe('2026/01/05');
  });
});

describe('isUlid', () => {
  it('rejects wrong length and bad charset', () => {
    expect(isUlid('too-short')).toBe(false);
    expect(isUlid('I'.repeat(26))).toBe(false); // I not in Crockford
    expect(isUlid(ulid())).toBe(true);
  });
});
