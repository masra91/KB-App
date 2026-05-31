// In-house ULID (SPEC-0013 CAPTURE-15): a globally-unique, lexicographically
// time-sortable id — 48-bit UTC-millisecond prefix + 80 bits of crypto randomness,
// rendered as 26 Crockford-base32 chars. No dependency (ENG-5); the `sources/` date
// shard derives from the id's own timestamp so folder and id can never disagree.
import { randomBytes } from 'node:crypto';

// Crockford base32 — excludes I, L, O, U to avoid ambiguity.
const ENC = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const TIME_LEN = 10; // 10 chars * 5 bits = 50 bits, holds the 48-bit ms timestamp
const RAND_LEN = 16; // 16 chars * 5 bits = 80 bits of randomness
export const ULID_LEN = TIME_LEN + RAND_LEN; // 26

function encodeTime(ms: number): string {
  let out = '';
  for (let i = TIME_LEN - 1; i >= 0; i--) {
    const mod = ms % 32;
    out = ENC[mod] + out;
    ms = (ms - mod) / 32;
  }
  return out;
}

function encodeRandom(): string {
  const bytes = randomBytes(RAND_LEN);
  let out = '';
  for (let i = 0; i < RAND_LEN; i++) out += ENC[bytes[i] & 31];
  return out;
}

/** Generate a new ULID for the given time (defaults to now). */
export function ulid(time: number = Date.now()): string {
  if (!Number.isFinite(time) || time < 0) {
    throw new RangeError(`ulid: invalid time ${time}`);
  }
  return encodeTime(Math.floor(time)) + encodeRandom();
}

/** Extract the millisecond timestamp encoded in a ULID's time prefix. */
export function ulidTime(id: string): number {
  if (id.length < TIME_LEN) throw new RangeError(`ulid: too short: ${id}`);
  let ms = 0;
  for (const ch of id.slice(0, TIME_LEN)) {
    const v = ENC.indexOf(ch.toUpperCase());
    if (v < 0) throw new RangeError(`ulid: invalid char ${ch} in ${id}`);
    ms = ms * 32 + v;
  }
  return ms;
}

/** `YYYY/MM/DD` (UTC) derived from the ULID's own timestamp — the `sources/` shard. */
export function dateShard(id: string): string {
  const d = new Date(ulidTime(id));
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}/${m}/${day}`;
}

/** True if `s` is a well-formed ULID (length + Crockford charset). */
export function isUlid(s: string): boolean {
  return s.length === ULID_LEN && [...s].every((c) => ENC.includes(c.toUpperCase()));
}
