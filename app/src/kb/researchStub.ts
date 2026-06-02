// A deterministic, network-free `ResearchFn` (SPEC-0028 Slice 1a). It proves the full
// request→dispatch→secondary-source→pipeline→audit→view flow with **zero external egress** — the
// real Web SDK adapter (live search/fetch, egress-gated) lands in Slice 1b behind the same seam.
//
// It honors the Slice-1 egress floor (D6a / RESEARCH-8): the note is built from the request's
// `what`/`why`/`context` ONLY (via `buildOutboundQuery`), never from KB content, and its single
// citation is a synthetic `kb-app://stub/<id>` ref that visibly marks the finding as non-external —
// so a stub finding can never be mistaken for a real web source in the audit/provenance.
import { buildOutboundQuery, type ResearchFn } from './researchRun';

/** The synthetic citation scheme a stub finding carries — clearly not an external source. */
export const STUB_CITATION_PREFIX = 'kb-app://stub/';

export const stubResearchFn: ResearchFn = async (r, req) => {
  const query = buildOutboundQuery(req);
  const note = [
    `# Research note: ${req.what}`,
    '',
    `_Stub finding — no external fetch (Slice 1a). Query: "${query}". Requested by ${req.by.stage}._`,
    '',
    req.why,
    '',
  ].join('\n');
  return { found: true, note, citations: [`${STUB_CITATION_PREFIX}${r.id}`], query };
};
