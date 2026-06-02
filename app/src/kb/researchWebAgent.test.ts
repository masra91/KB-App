// Web researcher SDK adapter — the testable security helpers (SPEC-0028 RESEARCH-8/12) + the
// injected-session ResearchFn path. The live SDK session is CI/e2e only (BYOA + network), like
// recallAgent; here we prove the egress gate, citation filtering, tier guard, and untrusted-content
// skill framing.
import { describe, it, expect } from 'vitest';
import { isAllowedUrl, isPublicHost, allowedDomainsOf, filterCitations, makeWebResearchFn, WEB_RESEARCH_SKILL, budgetExhausted, budgetExhaustedMessage } from './researchWebAgent';
import { noopDevLog, type DevLog, type Fields } from './devlog';
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

  it('empty allowlist permits any PUBLIC https/http host (public-web default)', () => {
    expect(isAllowedUrl('https://example.com/x')).toBe(true);
    expect(isAllowedUrl('http://example.org')).toBe(true);
  });

  it('SSRF backstop: rejects loopback/private/link-local/metadata hosts EVEN with an empty allowlist (KB-QD #85)', () => {
    for (const u of [
      'http://localhost/x',
      'http://sub.localhost/x',
      'http://127.0.0.1/x',
      'http://127.1.2.3/x',
      'https://[::1]/x',
      'http://0.0.0.0/x',
      'http://10.0.0.5/x',
      'http://172.16.0.1/x',
      'http://172.31.255.255/x',
      'http://192.168.1.1/x',
      'http://169.254.169.254/latest/meta-data/', // cloud metadata → credential theft
      'https://[fe80::1]/x', // IPv6 link-local
      'https://[fc00::1]/x', // IPv6 unique-local
      'http://[::ffff:127.0.0.1]/x', // IPv4-mapped IPv6 loopback
    ]) {
      expect(isAllowedUrl(u), `${u} must be rejected`).toBe(false);
    }
  });

  it('still ALLOWS public IPs + a 172.x outside the private 172.16/12 block', () => {
    expect(isPublicHost('8.8.8.8')).toBe(true);
    expect(isPublicHost('172.15.0.1')).toBe(true); // just below private range
    expect(isPublicHost('172.32.0.1')).toBe(true); // just above
    expect(isPublicHost('example.com')).toBe(true); // DNS name
  });

  it('rejects the hex-normalized IPv4-mapped IPv6 loopback (the smuggling form — KB-QD nit)', () => {
    expect(isPublicHost('::ffff:7f00:1')).toBe(false); // == ::ffff:127.0.0.1
    expect(isPublicHost('::ffff:a9fe:a9fe')).toBe(false); // == ::ffff:169.254.169.254 metadata
    expect(isPublicHost('[::ffff:7f00:1]')).toBe(false); // bracketed form
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

  it('pins findings capture to the submitFindings tool call — not a free reply (1d findings-capture fix)', () => {
    expect(WEB_RESEARCH_SKILL).toMatch(/calling the submitFindings tool/i);
    expect(WEB_RESEARCH_SKILL).toMatch(/only way your findings are recorded/i);
  });
});

describe('retrieval budget — HARD enforcement (RESEARCH-11; #51 found:false root cause)', () => {
  it('budgetExhausted gates exactly maxToolCalls fetches (the (max+1)th is refused)', () => {
    // used 0..7 (< 8) proceed; used 8 (== budget) is exhausted → refuse the 9th call.
    expect(budgetExhausted(0, 8)).toBe(false);
    expect(budgetExhausted(7, 8)).toBe(false);
    expect(budgetExhausted(8, 8)).toBe(true);
    expect(budgetExhausted(18, 8)).toBe(true); // the over-fetch DEV-2 observed would now be refused
  });
  it('budgetExhaustedMessage steers the agent to stop fetching + submit (forces convergence)', () => {
    const msg = budgetExhaustedMessage(8);
    expect(msg).toMatch(/budget exhausted/i);
    expect(msg).toContain('8');
    expect(msg).toMatch(/call submitFindings now/i);
    expect(msg).toMatch(/do not fetch any more/i);
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

  it('an empty note is a valid no-finding', async () => {
    const fn = makeWebResearchFn({ session: async () => ({ note: '   ', citations: [] }) });
    const f = await fn(web(), req);
    expect(f.found).toBe(false);
    expect(f.failed).toBeUndefined(); // a legit empty result is NOT a failure
  });
});

describe('makeWebResearchFn — session failure is surfaced, NOT swallowed (#160 / BUG #65 class)', () => {
  /** A DevLog that records what was logged + the scope it was bound to. */
  function recordingLog(): { log: DevLog; errors: Array<{ scope?: string; event: string; fields?: Fields }> } {
    const errors: Array<{ scope?: string; event: string; fields?: Fields }> = [];
    const make = (scope?: string): DevLog => ({
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: (event, fields) => errors.push({ scope, event, fields }),
      child: (bind) => make(typeof bind.scope === 'string' ? bind.scope : scope),
      flush: () => Promise.resolve(),
    });
    return { log: make(), errors };
  }

  it('a failed session returns failed≠empty (not a silent found:false) and never throws into the dispatch', async () => {
    const { log, errors } = recordingLog();
    const fn = makeWebResearchFn({
      session: async () => {
        // Mirrors the packaged-app failure: the SDK can't spawn the BYOA copilot.
        throw new Error('spawn copilot ENOENT');
      },
      log,
    });
    const f = await fn(web(), req); // must resolve, not reject (resilient dispatch)
    expect(f.found).toBe(false);
    expect(f.failed).toBe(true); // the distinguishing flag — before #160 this was a silent found:false
    expect(f.error).toMatch(/ENOENT/);
    // the cause is logged at the `research` scope (OBS-1) — never a silent swallow.
    const logged = errors.find((e) => e.event === 'research.session-failed');
    expect(logged).toBeDefined();
    expect(logged!.scope).toBe('research');
  });

  it('defaults to the no-op logger when none is injected (no crash on the failure path)', async () => {
    const fn = makeWebResearchFn({ session: async () => { throw new Error('boom'); }, log: noopDevLog });
    await expect(fn(web(), req)).resolves.toMatchObject({ failed: true });
  });
});
