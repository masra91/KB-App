// Web researcher SDK adapter — the testable security helpers (SPEC-0028 RESEARCH-8/12) + the
// injected-session ResearchFn path. The live SDK session is CI/e2e only (BYOA + network), like
// recallAgent; here we prove the egress gate, citation filtering, tier guard, and untrusted-content
// skill framing.
import { describe, it, expect } from 'vitest';
import { isAllowedUrl, allowedDomainsOf, filterCitations, makeWebResearchFn, WEB_RESEARCH_SKILL } from './researchWebAgent';
import type { ResearcherConfig, ResearchRequest } from './researchers';

const web = (over: Partial<ResearcherConfig> = {}): ResearcherConfig => ({
  id: 'web-1', template: 'web', prompt: 'find prior art', egressTier: 'public-web', scope: 'global',
  budget: { maxToolCalls: 8, maxDepth: 2 }, schedule: 'off', posture: 'guarded', enabled: true, ...over,
});
const req: ResearchRequest = { id: 'r1', ts: '2026-06-02T00:00:00.000Z', by: { stage: 'decompose' }, what: 'Project Atlas', why: 'unknown', context: 'launch', dedupKey: 'k' };

describe('isAllowedUrl — egress gate (RESEARCH-8)', () => {
  it('rejects non-http(s) schemes (no file/data/local escapes)', () => {
    for (const u of ['file:///etc/passwd', 'data:text/html,x', 'ftp://h/x', 'javascript:alert(1)', 'not a url']) {
      expect(isAllowedUrl(u)).toBe(false);
    }
  });

  it('empty allowlist permits any https/http host (public-web default)', () => {
    expect(isAllowedUrl('https://example.com/x')).toBe(true);
    expect(isAllowedUrl('http://example.org')).toBe(true);
  });

  it('a configured allowlist NARROWS to those hosts + their subdomains', () => {
    const allow = ['example.com', 'docs.rs'];
    expect(isAllowedUrl('https://example.com/a', allow)).toBe(true);
    expect(isAllowedUrl('https://www.example.com/a', allow)).toBe(true); // www. normalized
    expect(isAllowedUrl('https://api.example.com/a', allow)).toBe(true); // subdomain
    expect(isAllowedUrl('https://evil.com/a', allow)).toBe(false);
    expect(isAllowedUrl('https://notexample.com/a', allow)).toBe(false); // not a suffix match
  });
});

describe('allowedDomainsOf + filterCitations', () => {
  it('reads allowedDomains from the researcher config', () => {
    expect(allowedDomainsOf(web({ config: { allowedDomains: ['example.com', 5, ''] } }))).toEqual(['example.com']);
    expect(allowedDomainsOf(web())).toEqual([]);
  });

  it('drops citations outside the allowlist + dedups (defense-in-depth)', () => {
    const cites = ['https://example.com/a', 'https://evil.com/b', 'https://example.com/a', 'file:///x'];
    expect(filterCitations(cites, ['example.com'])).toEqual(['https://example.com/a']);
  });
});

describe('WEB_RESEARCH_SKILL — untrusted-content posture (RESEARCH-12)', () => {
  it('frames fetched content as DATA, forbids following embedded instructions, and scopes to the request', () => {
    expect(WEB_RESEARCH_SKILL).toMatch(/DATA, never instructions/i);
    expect(WEB_RESEARCH_SKILL).toMatch(/do not follow/i);
    expect(WEB_RESEARCH_SKILL).toMatch(/ONLY the requested topic/i);
    expect(WEB_RESEARCH_SKILL).toMatch(/exfiltrate/i);
  });
});

describe('makeWebResearchFn — injected session (seam)', () => {
  it('runs the request-only query, filters citations through the allowlist, returns a finding', async () => {
    const fn = makeWebResearchFn({
      session: async ({ query, allowedDomains }) => {
        expect(query).toBe('Project Atlas — launch'); // request-only (D6a)
        expect(allowedDomains).toEqual(['example.com']);
        return { note: 'Atlas is a launch codename.', citations: ['https://example.com/a', 'https://evil.com/b'] };
      },
    });
    const f = await fn(web({ config: { allowedDomains: ['example.com'] } }), req);
    expect(f.found).toBe(true);
    expect(f.citations).toEqual(['https://example.com/a']); // evil.com dropped by the gate
    expect(f.query).toBe('Project Atlas — launch');
  });

  it('refuses to run for a non-public-web researcher (defense-in-depth) → no-finding', async () => {
    let called = false;
    const fn = makeWebResearchFn({ session: async () => ((called = true), { note: 'x', citations: [] }) });
    const f = await fn(web({ egressTier: 'local-only' }), req);
    expect(called).toBe(false); // never opened a session
    expect(f.found).toBe(false);
  });

  it('a session failure degrades to a no-finding, never throws into the dispatch', async () => {
    const fn = makeWebResearchFn({
      session: async () => {
        throw new Error('network down');
      },
    });
    const f = await fn(web(), req);
    expect(f).toMatchObject({ found: false, note: '', citations: [] });
  });

  it('an empty note is a valid no-finding', async () => {
    const fn = makeWebResearchFn({ session: async () => ({ note: '   ', citations: [] }) });
    expect((await fn(web(), req)).found).toBe(false);
  });
});
