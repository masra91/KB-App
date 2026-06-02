// Connect-time SSRF defense for the Web researcher's live fetch handler (SPEC-0028 RESEARCH-8;
// KB-QD's hard gate on #85). The static `isAllowedUrl` host check (researchWebAgent) cannot stop a
// PUBLIC-looking DNS name that RESOLVES to a private/loopback IP — DNS-rebinding, or an attacker
// domain with an A-record of 127.0.0.1 / 169.254.169.254. The complete defense enforces on the
// RESOLVED address at connect time: a custom DNS `lookup` (wired into the http(s) Agent) that
// rejects the connection if ANY resolved address is non-public. Reuses `isPublicHost` so the
// IP-range policy is defined once.
import { lookup as dnsLookup } from 'node:dns';
import { isPublicHost } from './researchWebAgent';

export interface ResolvedAddress {
  address: string;
  family: number;
}

/** Resolve a hostname to all its addresses. Injected for tests; defaults to `dns.lookup({all:true})`. */
export type Resolver = (hostname: string) => Promise<ResolvedAddress[]>;

const defaultResolver: Resolver = (hostname) =>
  new Promise((resolve, reject) => {
    dnsLookup(hostname, { all: true }, (err, addresses) => (err ? reject(err) : resolve(addresses as ResolvedAddress[])));
  });

/** Throw if ANY resolved address is non-public (loopback/private/link-local/metadata/IPv6 equivs).
 *  An empty resolution also throws (a name that resolves to nothing must not be connected to). */
export function assertPublicResolved(addresses: readonly ResolvedAddress[]): void {
  if (addresses.length === 0) throw new Error('SSRF blocked: hostname did not resolve to any address');
  for (const a of addresses) {
    if (!isPublicHost(a.address)) throw new Error(`SSRF blocked: hostname resolves to non-public address ${a.address}`);
  }
}

/** Node `dns.lookup`-shaped callback signature, as `http.Agent({ lookup })` expects. */
type LookupCallback = (err: NodeJS.ErrnoException | null, address: string | ResolvedAddress[], family?: number) => void;
type LookupOptions = { all?: boolean } & Record<string, unknown>;

/**
 * Build an SSRF-safe `lookup` for an http(s) Agent (RESEARCH-8): resolve the hostname, REFUSE the
 * connection (error the callback) if any resolved IP is non-public, else hand the address(es) back.
 * Because the Agent connects to exactly what this returns, a rebinding name can't slip a private IP
 * past the static gate. Honors the `{all:true}` option shape. The resolver is injected (tests) /
 * `dns.lookup` (production).
 */
export function makeSsrfSafeLookup(resolver: Resolver = defaultResolver): (hostname: string, options: LookupOptions, callback: LookupCallback) => void {
  return (hostname, options, callback) => {
    resolver(hostname)
      .then((addresses) => {
        try {
          assertPublicResolved(addresses);
        } catch (e) {
          callback(e as NodeJS.ErrnoException, '');
          return;
        }
        if (options && options.all) callback(null, addresses);
        else callback(null, addresses[0].address, addresses[0].family);
      })
      .catch((e) => callback(e as NodeJS.ErrnoException, ''));
  };
}
