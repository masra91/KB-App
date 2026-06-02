// A deterministic, network-free `ResearchFn` — a TEST-ONLY fixture (SPEC-0028). It lets unit tests
// exercise the full request→dispatch→secondary-source→pipeline→audit→view flow with **zero external
// egress** and no SDK, behind the `ResearchFn` seam. The production cognition is the real Web SDK
// adapter (`makeWebResearchFn`, egress-gated + SSRF-safe).
//
// It lives under `test/` ON PURPOSE: production code must never import it, so simply running the app
// can never ingest synthetic scaffolding into a real vault. It also emits NO internal process naming
// — only neutral, clearly-synthetic text — and its single citation is a `kb-app://stub/<id>` ref that
// visibly marks the finding as non-external, so a fixture finding can never be mistaken for a real
// web source in the audit/provenance.
//
// It honors the egress floor (D6a / RESEARCH-8): the note is built from the request's
// `what`/`why`/`context` ONLY (via `buildOutboundQuery`), never from KB content.
import { buildOutboundQuery, type ResearchFn } from '../src/kb/researchRun';

/** The synthetic citation scheme a fixture finding carries — clearly not an external source. */
export const STUB_CITATION_PREFIX = 'kb-app://stub/';

export const stubResearchFn: ResearchFn = async (r, req) => {
  const query = buildOutboundQuery(req);
  const note = [
    `# Research note: ${req.what}`,
    '',
    `_Synthetic test finding — no external fetch was performed. Query: "${query}". Requested by ${req.by.stage}._`,
    '',
    req.why,
    '',
  ].join('\n');
  return { found: true, note, citations: [`${STUB_CITATION_PREFIX}${r.id}`], query };
};
