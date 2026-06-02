// Connect-time SSRF defense (SPEC-0028 RESEARCH-8, KB-QD #85 hard gate). Pure logic + the
// Agent-lookup guard with an injected resolver (no real DNS/network).
import { describe, it, expect, vi } from 'vitest';
import { assertPublicResolved, makeSsrfSafeLookup, makeGatedFetch, type Resolver, type ResolvedAddress } from './researchFetch';

const A = (address: string, family = 4): ResolvedAddress => ({ address, family });

describe('assertPublicResolved', () => {
  it('passes a public resolution', () => {
    expect(() => assertPublicResolved([A('93.184.216.34')])).not.toThrow();
  });
  it('throws if ANY resolved address is non-public (DNS-rebinding / malicious A-record)', () => {
    expect(() => assertPublicResolved([A('127.0.0.1')])).toThrow(/non-public/);
    expect(() => assertPublicResolved([A('169.254.169.254')])).toThrow(/non-public/); // cloud metadata
    expect(() => assertPublicResolved([A('93.184.216.34'), A('10.0.0.1')])).toThrow(/non-public/); // mixed
    expect(() => assertPublicResolved([A('::1', 6)])).toThrow(/non-public/);
  });
  it('throws on an empty resolution', () => {
    expect(() => assertPublicResolved([])).toThrow(/did not resolve/);
  });
});

describe('makeSsrfSafeLookup — Agent lookup guard', () => {
  const lookupOnce = (resolver: Resolver, hostname: string, options: { all?: boolean } = {}): Promise<{ err: Error | null; address: unknown; family?: number }> =>
    new Promise((resolve) => makeSsrfSafeLookup(resolver)(hostname, options, (err, address, family) => resolve({ err, address, family })));

  it('refuses the connection when a public-looking name resolves to a private IP (rebinding)', async () => {
    const rebind: Resolver = async () => [A('127.0.0.1')]; // "totally-legit.com" → loopback
    const { err, address } = await lookupOnce(rebind, 'totally-legit.com');
    expect(err).toBeInstanceOf(Error);
    expect(err?.message).toMatch(/non-public/);
    expect(address).toBe(''); // no address handed to the connection
  });

  it('passes through a public resolution (single + all forms)', async () => {
    const pub: Resolver = async () => [A('93.184.216.34')];
    const single = await lookupOnce(pub, 'example.com');
    expect(single.err).toBeNull();
    expect(single.address).toBe('93.184.216.34');
    expect(single.family).toBe(4);
    const all = await lookupOnce(pub, 'example.com', { all: true });
    expect(all.err).toBeNull();
    expect(all.address).toEqual([A('93.184.216.34')]);
  });

  it('propagates a resolver (DNS) failure as a lookup error', async () => {
    const fail: Resolver = async () => {
      throw new Error('ENOTFOUND');
    };
    const { err } = await lookupOnce(fail, 'nope.invalid');
    expect(err).toBeInstanceOf(Error);
  });
});

describe('makeGatedFetch — the live researcher fetch primitive (RESEARCH-8, KB-QD enforceable egress)', () => {
  it('Gate 1 (static allowlist) refuses a disallowed URL BEFORE any DNS/socket', async () => {
    const resolver = vi.fn<Resolver>(async () => [A('93.184.216.34')]);
    const fetch = makeGatedFetch({ resolver });
    // non-http(s) scheme, non-public host, and a host outside a configured allowlist all refuse.
    await expect(fetch('file:///etc/passwd')).rejects.toThrow(/not an allowed URL/);
    await expect(fetch('http://localhost/admin')).rejects.toThrow(/not an allowed URL/);
    await expect(fetch('http://169.254.169.254/latest/meta-data/')).rejects.toThrow(/not an allowed URL/);
    await expect(makeGatedFetch({ resolver, allowedDomains: ['example.com'] })('https://evil.test/')).rejects.toThrow(/not an allowed URL/);
    expect(resolver).not.toHaveBeenCalled(); // refused statically — the resolver/socket is never reached
  });

  it('Gate 2 (SSRF lookup) fails closed when an allowed public name resolves to a private IP', async () => {
    // host passes isAllowedUrl (public DNS name, empty allowlist) but the injected resolver rebinds
    // it to a private IP → the Agent's makeSsrfSafeLookup refuses the connection → fetch rejects.
    const rebind: Resolver = async () => [A('10.0.0.1')];
    await expect(makeGatedFetch({ resolver: rebind })('https://totally-legit.example/')).rejects.toThrow();
  }, 10_000);

  it('emits a [gated-fetch] marker per real retrieval ONLY when KB_RESEARCH_FETCH_LOG is set (1d self-fetch check)', async () => {
    const rebind: Resolver = async () => [A('10.0.0.1')]; // passes isAllowedUrl, then SSRF-rejects after the marker
    const writes: string[] = [];
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation((c: string | Uint8Array) => {
      writes.push(typeof c === 'string' ? c : Buffer.from(c).toString());
      return true;
    });
    const prev = process.env.KB_RESEARCH_FETCH_LOG;
    try {
      // off (default): no marker even though the URL passes the static gate + reaches the request point
      delete process.env.KB_RESEARCH_FETCH_LOG;
      await makeGatedFetch({ resolver: rebind })('https://example.com/a').catch(() => {});
      expect(writes.some((w) => w.includes('[gated-fetch]'))).toBe(false);
      // on: exactly one marker for the retrieved URL (proves the page body went through this chokepoint)
      process.env.KB_RESEARCH_FETCH_LOG = '1';
      await makeGatedFetch({ resolver: rebind })('https://example.com/b').catch(() => {});
      expect(writes).toContain('[gated-fetch] https://example.com/b\n');
      // a statically-refused URL never reaches the marker (refused before the request point)
      writes.length = 0;
      await makeGatedFetch({ resolver: rebind })('file:///etc/passwd').catch(() => {});
      expect(writes.some((w) => w.includes('[gated-fetch]'))).toBe(false);
    } finally {
      if (prev === undefined) delete process.env.KB_RESEARCH_FETCH_LOG;
      else process.env.KB_RESEARCH_FETCH_LOG = prev;
      spy.mockRestore();
    }
  }, 10_000);
});
