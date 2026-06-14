// SPEC-0028 RESEARCH-1/4 / WS-B — seed a default Web researcher so the research pipeline is not
// INERT on a fresh (or pre-feature) vault. The registry (`.kb/researchers/registry.json`) is empty
// by default, so with no researcher registered NOTHING dispatches even once a `research-request` is
// emitted — `outputs/` stays empty forever. We seed exactly ONE default Web researcher, keyed on the
// registry FILE's ABSENCE (not its emptiness): a Principal who deliberately CLEARS all researchers
// (leaving an empty `[]`) is respected and never re-seeded, while a virgin/pre-feature vault gets a
// working default. Public-web egress builds outbound queries from the request ONLY (D6a
// least-privilege — never arbitrary KB content), and the posture is GUARDED, so findings route to
// Review rather than auto-applying; the human stays in the loop on whatever the web turns up.
import { promises as fs } from 'node:fs';
import { DEFAULT_POSTURE } from './jobs';
import { DEFAULT_RESEARCHER_BUDGET, TEMPLATE_DEFAULT_EGRESS, type ResearcherConfig } from './researchers';
import { writeResearcherRegistry, researcherRegistryPath } from './researcherRegistry';

/** Stable bare-slug id for the seeded default Web researcher (isSafeResearcherId-valid). */
export const DEFAULT_WEB_RESEARCHER_ID = 'web';

/**
 * The default Web researcher seeded on a virgin vault (WS-B). **Disabled by default** — the
 * conservative, reversible OPT-IN egress posture ratified for SPEC-0028 (PM decision 2026-06-14): the
 * seed installs the researcher and the enrichment trigger still emits research-requests for sparse
 * entities, but NO public-web egress happens until the user enables it in the Control Panel (one
 * toggle — at which point the accumulated requests dispatch, bounded by the per-instance ceiling).
 * **Guarded** posture so even then findings route to Review, never auto-applied; `topics: []` so it
 * is eligible for every request (no pre-filter); `schedule: 'off'` (inline/on-demand only — driven by
 * the research-request sweep, not a standing cron). Budgets are the shared defaults, user-editable.
 */
export function makeDefaultWebResearcher(): ResearcherConfig {
  return {
    id: DEFAULT_WEB_RESEARCHER_ID,
    template: 'web',
    label: 'Web',
    prompt:
      'Research public-web sources (definitions, prior art, references) for the requested term and return a cited secondary source.',
    egressTier: TEMPLATE_DEFAULT_EGRESS.web, // 'public-web'
    scope: 'global',
    budget: { ...DEFAULT_RESEARCHER_BUDGET },
    schedule: 'off',
    posture: DEFAULT_POSTURE, // guarded — findings route to Review
    enabled: false, // opt-in egress: no public-web traffic until the user enables it (SPEC-0028 ratified)
    topics: [], // no pre-filter: eligible for every research-request once enabled
  };
}

/**
 * Seed the default Web researcher iff the registry FILE does not yet exist (RESEARCH-1, WS-B). Keyed
 * on file-absence (not an empty array) so a deliberately-emptied registry is never re-seeded. Writes
 * the file only; the caller commits it on `staging` under the canonical-writer lock (durability). A
 * fresh vault returns true (seeded); an existing registry — even an empty `[]` — returns false.
 */
export async function seedDefaultResearcherIfAbsent(root: string): Promise<boolean> {
  try {
    await fs.access(researcherRegistryPath(root));
    return false; // registry already exists (possibly an intentional empty []) — respect it
  } catch {
    // no registry file yet → virgin/pre-feature vault → seed one default
  }
  await writeResearcherRegistry(root, [makeDefaultWebResearcher()]);
  return true;
}
