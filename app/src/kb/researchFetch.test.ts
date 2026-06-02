// Connect-time SSRF defense (SPEC-0028 RESEARCH-8, KB-QD #85 hard gate). Pure logic + the
// Agent-lookup guard with an injected resolver (no real DNS/network).
import { describe, it, expect } from 'vitest';
import { assertPublicResolved, makeSsrfSafeLookup, type Resolver, type ResolvedAddress } from './researchFetch';

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
