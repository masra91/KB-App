// Manual LIVE diagnostic for the Web researcher (SPEC-0028 1d) — NOT a unit test (no `.test.ts`, never
// auto-run; it makes a REAL external call). Run it in a BYOA env (the `copilot` CLI on PATH) to answer
// the open option-A-vs-B question: does this copilot expose the built-in `web_search`/fetch tools the
// live Web run-pass needs?
//
//   cd app && node_modules/.bin/vite-node test/researchWebLiveCheck.ts "your query here"
//
// It invokes the production `makeWebResearchFn()` (live SDK, no injected session) against a seeded
// public-web request and prints the outcome. Interpretation:
//   - found:true + real https citations  → copilot exposes search/fetch → OPTION A works (1d live-OK).
//   - found:false (no error)             → the agent ran but surfaced nothing — likely the built-in
//                                           search tool name differs from WEB_SEARCH_TOOL_NAME, or no
//                                           results; inspect + adjust the constant / consider option B.
//   - throws / SDK error                 → the CLI/SDK isn't reachable here (still env-blocked).
// The egress is request-only (buildOutboundQuery) + the fetch is SSRF/allowlist-gated (#115); KB-QD
// uses this run to confirm the built-in `web_search` does NOT itself fetch un-gated page content.
import { makeWebResearchFn } from '../src/kb/researchWebAgent';
import type { ResearcherConfig, ResearchRequest } from '../src/kb/researchers';

async function main(): Promise<void> {
  const what = process.argv[2] ?? 'GitHub Copilot SDK';
  const fn = makeWebResearchFn({ ...(process.env.KB_COPILOT_PATH ? { cliPath: process.env.KB_COPILOT_PATH } : {}) });
  const r: ResearcherConfig = {
    id: 'web-live-check',
    template: 'web',
    prompt: 'Research the requested topic on the public web and return a short cited note.',
    egressTier: 'public-web',
    scope: 'global',
    budget: { maxToolCalls: 8, maxDepth: 2 },
    schedule: 'off',
    posture: 'guarded',
    enabled: true,
  };
  const req: ResearchRequest = {
    id: 'live-1',
    ts: new Date().toISOString(),
    by: { stage: 'panel' },
    what,
    why: 'live capability check',
    context: '',
    dedupKey: `live::${what}`,
  };
  console.log(`[web-live-check] querying: ${JSON.stringify(what)}\n`);
  const out = await fn(r, req);
  console.log(
    JSON.stringify(
      { found: out.found, query: out.query, citations: out.citations, noteChars: out.note.length, notePreview: out.note.slice(0, 800) },
      null,
      2,
    ),
  );
}

main().catch((err) => {
  console.error('[web-live-check] ERROR (likely the copilot CLI/SDK is not reachable in this env):', err);
  process.exitCode = 1;
});
