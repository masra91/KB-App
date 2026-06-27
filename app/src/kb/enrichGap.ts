// SPEC-0028 RESEARCH-24 — the entity's ENRICHMENT GAP (claims-present + claims-MISSING). The warm-start
// orient (RESEARCH-22) was built and wired, but `chooseAngle` (researchOrient.ts) steered toward the first
// KB-neighbor the request didn't already name — "fresh-to-the-request," NOT "a gap in what the KB knows."
// So a sparse entity could be re-chased on a facet it already covers. This module computes a deterministic,
// per-kind gap: of the facets we'd expect to know about an entity of this kind, which ones its PRESENT
// claims already cover, and which are MISSING. The gap rides on the `research-request` (a payload field,
// plumbed producer→orient) so orient can bias the angle — and therefore the outbound query — toward the
// MISSING facets (gap-filling), expanding what the KB actually knows instead of re-establishing basics.
//
// Deterministic by design (no LLM → no brittle-JSON parse failure, matching the SPEC-0049 robustness ethos
// and the WS-B enrich-trigger that produces these requests). The facet labels are user-appropriate noun
// phrases (they become part of the search query), never dev-jargon.
import { kindSlug } from './connectDoc';
import { normalizeTerm } from './researchers';

/** The enrichment gap for one entity: which expected facets its claims cover vs. which are absent. */
export interface EnrichmentGap {
  /** Expected facets ALREADY covered by ≥1 present claim (the labels, query-ready). */
  present: string[];
  /** Expected facets NO present claim covers — the gap an enrichment pass should target. */
  missing: string[];
}

/** One expected facet of an entity kind: a query-ready `label` + lowercase `cues` that, if any appears
 *  in a claim statement, mark the facet covered. Cues are detection-only; the label is what we research. */
interface Facet {
  label: string;
  cues: string[];
}

/** Facets we'd expect to know about an entity of a given kind. Keyed by {@link kindSlug} so `Organization`
 *  and `organization` resolve the same. Unknown kinds fall back to {@link DEFAULT_FACETS}. Kept small and
 *  natural — these labels become outbound query terms, so they read like a person would phrase the gap. */
const FACETS_BY_KIND: Record<string, readonly Facet[]> = {
  person: [
    { label: 'role or occupation', cues: ['role', 'occupation', 'job', 'works as', 'is a ', 'is an ', 'profession', 'title', 'position', 'career', 'founder', 'ceo', 'engineer', 'professor', 'director', 'author', 'artist', 'scientist', 'researcher'] },
    { label: 'employer or affiliation', cues: ['employer', 'works at', 'employed', 'affiliat', 'member of', 'company', 'organization', 'firm', 'joined'] },
    { label: 'education', cues: ['education', 'studied', 'degree', 'university', 'college', 'graduated', 'phd', 'alma mater', 'school', 'majored'] },
    { label: 'date of birth', cues: ['born', 'birth', 'birthday', 'b.', 'age '] },
    { label: 'notable work or achievement', cues: ['known for', 'notable', 'award', 'achievement', 'created', 'wrote', 'published', 'built', 'developed', 'invented'] },
    { label: 'location', cues: ['lives', 'based in', 'located', 'hometown', 'resides', 'lives in', 'from '] },
  ],
  organization: [
    { label: 'founding date', cues: ['founded', 'established', 'est.', 'incorporated', 'started in', 'inception'] },
    { label: 'headquarters or location', cues: ['headquarter', 'based in', 'located', ' hq', 'offices'] },
    { label: 'industry or sector', cues: ['industry', 'sector', 'operates in', 'specializ', 'field of'] },
    { label: 'leadership', cues: ['ceo', 'founder', 'led by', 'headed by', 'president', 'director', 'chief'] },
    { label: 'products or services', cues: ['product', 'service', 'offers', 'makes', 'develops', 'sells', 'provides'] },
    { label: 'size or scale', cues: ['employees', 'revenue', 'valuation', 'users', 'market', 'staff'] },
  ],
  place: [
    { label: 'location or region', cues: ['located', 'region', 'country', 'situated', 'coordinates', 'continent', 'state of'] },
    { label: 'population', cues: ['population', 'residents', 'inhabitants', 'people'] },
    { label: 'notable features', cues: ['known for', 'landmark', 'feature', 'famous for', 'home to'] },
    { label: 'history', cues: ['founded', 'established', 'history', 'dates back', 'settled'] },
  ],
  product: [
    { label: 'creator or maker', cues: ['created by', 'made by', 'developed by', 'author', 'manufacturer', 'designed by', 'built by'] },
    { label: 'release date', cues: ['released', 'launched', 'published', 'debut', 'premiered', 'introduced', 'shipped'] },
    { label: 'description or purpose', cues: ['is a', 'purpose', 'used for', 'designed to', 'genre', 'category', 'enables'] },
    { label: 'reception or impact', cues: ['reception', 'reviews', 'impact', 'acclaim', 'sales', 'adoption', 'popular'] },
  ],
  event: [
    { label: 'date', cues: ['held', 'occurred', 'took place', 'date', 'when', ' on '] },
    { label: 'location', cues: ['held in', 'location', 'venue', 'took place in', 'hosted in'] },
    { label: 'participants', cues: ['participants', 'attended', 'hosted', 'organized by', 'speakers', 'players'] },
    { label: 'outcome or significance', cues: ['outcome', 'result', 'led to', 'significance', 'won', 'concluded'] },
  ],
};

/** Fallback facets for an unrecognized kind (or `concept`): generic-but-useful enrichment angles. */
export const DEFAULT_FACETS: readonly Facet[] = [
  { label: 'overview or definition', cues: ['is a', 'is an', 'refers to', 'overview', 'defined', 'definition', 'means', 'describes'] },
  { label: 'origin or history', cues: ['history', 'founded', 'created', 'originated', 'established', 'first', 'coined', 'developed'] },
  { label: 'notable details', cues: ['known for', 'notable', 'significance', 'important', 'famous', 'recognized'] },
];

/** The expected facets for a kind (kindSlug-normalized), or the default set for an unknown kind. */
function facetsForKind(kind: string): readonly Facet[] {
  return FACETS_BY_KIND[kindSlug(kind)] ?? DEFAULT_FACETS;
}

/**
 * Compute the enrichment gap for an entity of `kind` given its PRESENT claim statements (RESEARCH-24).
 * A facet is `present` when any of its cues appears in the (normalized, concatenated) claim statements,
 * else `missing`. An entity with NO claims has every expected facet missing — the strongest gap, which
 * matches the WS-B intuition that a stub wants enrichment across the board. Pure + deterministic.
 */
export function computeEnrichmentGap(kind: string, claimStatements: readonly string[]): EnrichmentGap {
  const haystack = normalizeTerm(claimStatements.join(' • '));
  const present: string[] = [];
  const missing: string[] = [];
  for (const f of facetsForKind(kind)) {
    (f.cues.some((c) => haystack.includes(c)) ? present : missing).push(f.label);
  }
  return { present, missing };
}

/**
 * Is this entity FACET-THIN — covering fewer of its kind's expected facets than it's missing
 * (RESEARCH-QUALITY)? This is the QUALITATIVE gap signal that complements the count-only sparse check:
 * an entity can be corroborated by several sources yet still be a stub on the facets that matter (a
 * person with three sources but no birth date, education, or role). `missing.length > present.length`
 * means it covers under half of what we'd expect to know — a real gap worth an enrichment pass — while
 * a `{present:[], missing:[]}` (no expectations) or a well-covered entity reads as `false`. Pure.
 */
export function isFacetThin(gap: EnrichmentGap): boolean {
  return gap.missing.length > gap.present.length;
}

/** Runtime shape-guard for a gap read back off an audit payload (foreign/legacy-tolerant — ENG-16). */
export function isEnrichmentGap(v: unknown): v is EnrichmentGap {
  const o = v as EnrichmentGap;
  return (
    !!o &&
    typeof o === 'object' &&
    Array.isArray(o.present) &&
    o.present.every((s) => typeof s === 'string') &&
    Array.isArray(o.missing) &&
    o.missing.every((s) => typeof s === 'string')
  );
}
