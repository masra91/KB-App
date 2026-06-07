// SPEC-0042 EVAL Slice-3 — the egress controller (fork S3-A): bridges the cassette to the research
// adapters' fetch seam (WebResearchOptions.makeFetch). It exposes a `makeFetch` factory the harness
// injects so a `dispatchResearcher` action runs reproducibly:
//   - REPLAY (default eval path): serve pre-gated, scrubbed fixtures; ERROR on a cache miss (never live).
//   - RECORD (`--live`): wrap the REAL `makeGatedFetch` so the SSRF/allowlist gate runs on record, then
//     scrub + collect; `recorded()` returns the clean cassette to persist (asserts clean / fail-loud).
// Production omits `makeFetch` entirely → the adapter builds `makeGatedFetch` exactly as before.
import { makeGatedFetch } from '../../src/kb/researchFetch';
import { type Cassette, type CassetteEntry, type GatedFetch, makeReplayFetch, makeRecordingFetch, assertCassetteClean } from './cassette';

export interface EgressController {
  /** Pass as `WebResearchOptions.makeFetch`: build the session's fetch primitive from its allowedDomains. */
  makeFetch: (allowedDomains: readonly string[]) => GatedFetch;
  /** RECORD only: the cassette to persist (asserted clean / secret-free). `null` in replay mode. */
  recorded(): Cassette | null;
}

/** Replay egress: every session fetch is served from `cassette` (already pre-gated on record); a miss
 *  errors. The allowedDomains are irrelevant on replay — the gate ran when the cassette was recorded. */
export function makeReplayEgress(cassette: Cassette): EgressController {
  const replay = makeReplayFetch(cassette); // asserts the cassette is clean on load
  return { makeFetch: () => replay, recorded: () => null };
}

/** Record egress (`--live`): each session's fetch wraps a real `makeGatedFetch({allowedDomains})`, so the
 *  egress gate runs on record; responses are scrubbed + collected. `recorded()` builds + asserts the
 *  public-web cassette. Sessions for different researchers share one sink (one cassette per scenario). */
export function makeRecordEgress(): EgressController {
  const sink: CassetteEntry[] = [];
  return {
    makeFetch: (domains) => makeRecordingFetch(makeGatedFetch({ allowedDomains: domains }), sink),
    recorded() {
      const cassette: Cassette = { tier: 'public-web', entries: sink };
      assertCassetteClean(cassette); // fail-loud before the caller persists it (EVAL-6)
      return cassette;
    },
  };
}
