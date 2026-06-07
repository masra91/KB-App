// SPEC-0042 EVAL Slice-3 — the egress cassette + secret-scrubber (EVAL-6). This is the deterministic CI
// smoke (EVAL-11) AND KB-QD's gate-2 hard-check: real secret patterns in → scrubbed/refused out, fail-loud
// on an unscrubbed/private-tier cassette, plus record/replay determinism. No network, no model — pure logic.
import { describe, it, expect } from 'vitest';
import {
  scrubString,
  scrubEntry,
  findSecrets,
  assertCassetteClean,
  cassetteKey,
  makeReplayFetch,
  makeRecordingFetch,
  type Cassette,
  type CassetteEntry,
  type GatedFetch,
} from './cassette';
import type { GatedFetchResponse } from '../../src/kb/researchFetch';

// Realistic secret material the scrubber MUST neutralize (representative of what a live page/response or a
// mis-built request could carry). Each is a plausible-shaped token, not a real credential.
const SECRETS: Array<{ label: string; sample: string }> = [
  { label: 'github-pat', sample: 'ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789' },
  { label: 'github-token', sample: 'gho_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789' },
  { label: 'openai-key', sample: 'sk-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789' },
  { label: 'aws-access-key', sample: 'AKIAIOSFODNN7EXAMPLE' },
  { label: 'jwt', sample: 'eyJhbGciOiJIUzI1Ni2.eyJzdWIiOiIxMjM0NTY3ODkw.dQw4w9WgXcQabcdef0123' },
  { label: 'bearer', sample: 'Bearer abcdef0123456789ABCDEF' },
  { label: 'labeled-secret', sample: 'password: hunter2supersecret' },
  { label: 'url-basic-auth', sample: 'https://alice:s3cr3tpass@example.com/data' },
  { label: 'query-credential', sample: 'https://api.example.com/x?token=abcdef0123456789' },
];

describe('cassette scrubber (EVAL-6 — secrets in → scrubbed out, idempotently clean)', () => {
  for (const { label, sample } of SECRETS) {
    it(`detects + scrubs ${label}, and the scrubbed output is clean`, () => {
      expect(findSecrets(sample).length).toBeGreaterThan(0); // detected before scrub
      const scrubbed = scrubString(sample);
      expect(scrubbed).not.toContain('hunter2supersecret');
      expect(scrubbed).toContain('[REDACTED]');
      // The record→assert-clean invariant: a scrubbed string re-scans clean (no residual token=/auth@).
      expect(findSecrets(scrubbed)).toEqual([]);
    });
  }

  it('leaves benign public prose untouched (no false positives on the committed cassette content)', () => {
    const prose = 'COBOL was developed in 1959 by CODASYL; Grace Hopper was a key figure in its creation.';
    expect(findSecrets(prose)).toEqual([]);
    expect(scrubString(prose)).toBe(prose);
  });

  it('scrubs both url and text of an entry', () => {
    const e: CassetteEntry = { url: 'https://api.example.com/x?token=abcdef0123456789', status: 200, text: 'body with ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 inside', truncated: false };
    const s = scrubEntry(e);
    expect(findSecrets(s.url)).toEqual([]);
    expect(findSecrets(s.text)).toEqual([]);
  });
});

describe('assertCassetteClean (fail-loud — an unscrubbed/private cassette can never land or replay)', () => {
  it('throws on a non-public-web tier', () => {
    const bad = { tier: 'internal-tenant', entries: [] } as unknown as Cassette;
    expect(() => assertCassetteClean(bad)).toThrow(/public-web/);
  });

  it('throws on an entry whose text still carries a secret', () => {
    const dirty: Cassette = { tier: 'public-web', entries: [{ url: 'https://example.com', status: 200, text: 'leaked ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789', truncated: false }] };
    expect(() => assertCassetteClean(dirty)).toThrow(/secret material/);
  });

  it('passes a scrubbed public-web cassette', () => {
    const clean: Cassette = { tier: 'public-web', entries: [scrubEntry({ url: 'https://example.com?token=abcdef0123456789', status: 200, text: 'public content', truncated: false })] };
    expect(() => assertCassetteClean(clean)).not.toThrow();
  });
});

describe('makeReplayFetch (serve pre-gated fixtures; ERROR on a miss — never live)', () => {
  const cassette: Cassette = { tier: 'public-web', entries: [{ url: 'https://en.wikipedia.org/wiki/COBOL', status: 200, text: 'COBOL is a language.', truncated: false }] };

  it('serves a recorded fetch by exact URL key', async () => {
    const fetch = makeReplayFetch(cassette);
    const res = await fetch('https://en.wikipedia.org/wiki/COBOL');
    expect(res.status).toBe(200);
    expect(res.text).toContain('COBOL');
  });

  it('errors on a cache miss (no silent live fall-through, S3-A)', async () => {
    const fetch = makeReplayFetch(cassette);
    await expect(fetch('https://en.wikipedia.org/wiki/Fortran')).rejects.toThrow(/cassette miss/);
  });

  it('refuses to build from a dirty cassette (asserts clean on load)', () => {
    const dirty: Cassette = { tier: 'public-web', entries: [{ url: 'https://x', status: 200, text: 'sk-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789', truncated: false }] };
    expect(() => makeReplayFetch(dirty)).toThrow(/secret material/);
  });
});

describe('makeRecordingFetch (wraps the real gated fetch; captures SCRUBBED responses)', () => {
  it('records each fetch scrubbed, leaving a clean cassette', async () => {
    // A fake "real" gated fetch (stands in for makeGatedFetch — the gate ran inside it) whose response
    // body happens to carry a token; recording must scrub it before it enters the sink.
    const realFetch: GatedFetch = async (url: string): Promise<GatedFetchResponse> => ({ url, status: 200, text: 'page body Authorization: Bearer abcdef0123456789ABCDEF end', truncated: false });
    const sink: CassetteEntry[] = [];
    const recording = makeRecordingFetch(realFetch, sink);
    const res = await recording('https://en.wikipedia.org/wiki/COBOL');
    // The caller still gets the real (unscrubbed) response; only the persisted cassette is scrubbed.
    expect(res.text).toContain('Bearer');
    expect(sink).toHaveLength(1);
    expect(findSecrets(sink[0].text)).toEqual([]);
    expect(() => assertCassetteClean({ tier: 'public-web', entries: sink })).not.toThrow();
  });
});

describe('cassetteKey', () => {
  it('is the trimmed exact URL', () => {
    expect(cassetteKey('  https://example.com/x  ')).toBe('https://example.com/x');
  });
});
