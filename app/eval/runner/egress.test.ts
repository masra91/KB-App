// SPEC-0042 EVAL Slice-3 — the egress controller wiring (fork S3-A). Deterministic CI smoke: replay serves
// pre-gated fixtures + errors on a miss (recorded()===null); record builds a clean public-web cassette.
import { describe, it, expect } from 'vitest';
import { makeReplayEgress, makeRecordEgress } from './egress';
import type { Cassette } from './cassette';

const cassette: Cassette = { tier: 'public-web', entries: [{ url: 'https://en.wikipedia.org/wiki/COBOL', status: 200, text: 'COBOL is a language.', truncated: false }] };

describe('makeReplayEgress', () => {
  it('serves the cassette regardless of allowedDomains, and records nothing', async () => {
    const egress = makeReplayEgress(cassette);
    const fetch = egress.makeFetch(['en.wikipedia.org']);
    expect((await fetch('https://en.wikipedia.org/wiki/COBOL')).text).toContain('COBOL');
    expect(egress.recorded()).toBeNull();
  });

  it('errors on a cache miss (never live)', async () => {
    const egress = makeReplayEgress(cassette);
    const fetch = egress.makeFetch([]);
    await expect(fetch('https://example.com/other')).rejects.toThrow(/cassette miss/);
  });
});

describe('makeRecordEgress', () => {
  it('builds a fetch factory and yields a clean public-web cassette from an empty session', () => {
    const egress = makeRecordEgress();
    expect(typeof egress.makeFetch(['en.wikipedia.org'])).toBe('function'); // builds (no network until called)
    const recorded = egress.recorded();
    expect(recorded).not.toBeNull();
    expect(recorded?.tier).toBe('public-web');
    expect(recorded?.entries).toEqual([]);
  });
});
