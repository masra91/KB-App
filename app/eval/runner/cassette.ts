// SPEC-0042 EVAL Slice-3 — egress record/replay cassette (EVAL-6). Makes RESEARCH/external scenarios
// reproducible + secret-free. Hard security constraints (KB-Lead-ratified S3-A/S3-B, KB-QD hard-verifies):
//   - RECORD wraps the REAL `makeGatedFetch`, so the SSRF/allowlist gate runs on record (the only path
//     that egresses); only what passed the gate is captured.
//   - REPLAY serves pre-gated fixtures and ERRORS on a cache miss — it NEVER silently hits the live web.
//   - COMMITTED cassettes are PUBLIC-WEB egress ONLY: request-only URLs (D6a) + public response content.
//     internal-tenant/M365/any private tier must NEVER be recorded (that commits tenant PII/secrets into
//     the repo) — those use hand-authored SYNTHETIC fixtures, never recorded real private data.
//   - The scrubber drops auth/token material on record and FAILS LOUD if any secret pattern remains, so an
//     unscrubbed cassette can't be written. See eval/cassettes/README.md for the guardrail.
import type { GatedFetchResponse } from '../../src/kb/researchFetch';

/** The fetch primitive the research adapters use (mirrors makeGatedFetch's return). */
export type GatedFetch = (url: string) => Promise<GatedFetchResponse>;

/** One recorded request→response (response shape only — no headers/auth ever live in GatedFetchResponse). */
export interface CassetteEntry {
  url: string;
  status: number;
  text: string;
  truncated: boolean;
}

export interface Cassette {
  /** Egress tier the cassette was recorded for — MUST be 'public-web' for a committed cassette (S3-B). */
  tier: 'public-web';
  entries: CassetteEntry[];
}

/** Stable replay key for a request URL (request-only egress, D6a). Exact-URL match; trimmed. */
export function cassetteKey(url: string): string {
  return url.trim();
}

// Secret/credential patterns the scrubber redacts + the fail-loud guard scans for. Conservative + broad:
// better to over-redact a cassette than commit a live token. Covers common token/key/JWT/basic-auth forms.
const SECRET_PATTERNS: Array<{ re: RegExp; label: string }> = [
  { re: /\bghp_[A-Za-z0-9]{20,}\b/g, label: 'github-pat' },
  { re: /\bgh[oprsu]_[A-Za-z0-9]{20,}\b/g, label: 'github-token' },
  { re: /\bsk-[A-Za-z0-9]{20,}\b/g, label: 'openai-key' },
  { re: /\bAKIA[0-9A-Z]{16}\b/g, label: 'aws-access-key' },
  { re: /\bey[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, label: 'jwt' },
  { re: /\bBearer\s+[A-Za-z0-9._-]{16,}/gi, label: 'bearer' },
  { re: /\b(?:api[_-]?key|access[_-]?token|secret|password|client[_-]?secret)["'\s:=]+[A-Za-z0-9._-]{8,}/gi, label: 'labeled-secret' },
  { re: /(?<=:\/\/)[^/@\s:]+:[^/@\s]+@/g, label: 'url-basic-auth' }, // user:pass@host
  { re: /([?&](?:token|key|api_key|access_token|secret|sig|signature)=)[^&\s"']+/gi, label: 'query-credential' },
];

/** The placeholder a redacted secret is replaced with. Chosen so it contains none of the characters the
 *  SECRET_PATTERNS key off (`=`, `@`, `:`, the token prefixes) — so a scrubbed string is idempotently
 *  clean: re-scanning it via {@link findSecrets} finds nothing (the record→assert-clean invariant). */
const REDACTION = '[REDACTED]';

/** Redact secret-looking material from a string (used on record). Returns the scrubbed string. The WHOLE
 *  match is replaced (prefix + value), so no residual `token=`/`user:pass@` survives to re-trigger the
 *  fail-loud scanner. */
export function scrubString(s: string): string {
  let out = s;
  for (const { re } of SECRET_PATTERNS) out = out.replace(re, REDACTION);
  return out;
}

/** Scrub a recorded entry (url + body). */
export function scrubEntry(e: CassetteEntry): CassetteEntry {
  return { ...e, url: scrubString(e.url), text: scrubString(e.text) };
}

/** Return the secret labels still present in a string (empty = clean). The fail-loud detector. */
export function findSecrets(s: string): string[] {
  const found = new Set<string>();
  for (const { re, label } of SECRET_PATTERNS) {
    re.lastIndex = 0;
    if (re.test(s)) found.add(label);
  }
  return [...found];
}

/**
 * FAIL LOUD: throw if any cassette entry still contains a secret pattern after scrubbing, or if the tier
 * isn't public-web. Called before writing a recorded cassette AND on replay-load — so an unscrubbed or
 * private-tier cassette can never enter the repo or be replayed (EVAL-6; KB-QD hard-verify).
 */
export function assertCassetteClean(cassette: Cassette): void {
  if (cassette.tier !== 'public-web') {
    throw new Error(`cassette tier '${cassette.tier}' is not committable — only public-web egress may be recorded (S3-B); use a synthetic fixture for private tiers`);
  }
  for (const e of cassette.entries) {
    const secrets = [...findSecrets(e.url), ...findSecrets(e.text)];
    if (secrets.length) throw new Error(`cassette entry ${e.url} still contains secret material (${secrets.join(', ')}) — refusing to write/replay an unscrubbed cassette`);
  }
}

/**
 * REPLAY fetch (default eval path): serve a pre-gated, scrubbed fixture by URL. ERRORS on a cache miss —
 * never falls through to the live web (S3-A). The cassette is asserted clean on load.
 */
export function makeReplayFetch(cassette: Cassette): GatedFetch {
  assertCassetteClean(cassette);
  const byKey = new Map(cassette.entries.map((e) => [cassetteKey(e.url), e]));
  return async (url: string) => {
    const hit = byKey.get(cassetteKey(url));
    if (!hit) throw new Error(`cassette miss: ${url} — no recorded fixture (run with --live to record). Replay never hits the live web.`);
    return { url: hit.url, status: hit.status, text: hit.text, truncated: hit.truncated };
  };
}

/**
 * RECORD fetch (`--live`): wrap the REAL gated fetch so the SSRF/allowlist gate runs on record, scrub each
 * response, and collect entries into `sink`. The caller builds a Cassette { tier:'public-web', entries:sink }
 * and writes it ONLY after assertCassetteClean passes. A gate-refused/failed fetch propagates (not recorded).
 */
export function makeRecordingFetch(realFetch: GatedFetch, sink: CassetteEntry[]): GatedFetch {
  return async (url: string) => {
    const res = await realFetch(url); // the gate already ran inside realFetch (makeGatedFetch)
    sink.push(scrubEntry({ url: res.url, status: res.status, text: res.text, truncated: res.truncated }));
    return res;
  };
}
