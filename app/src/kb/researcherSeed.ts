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
 * The default Web researcher seeded on a virgin vault (WS-B). **Enabled** so the pipeline is
 * genuinely live — a disabled seed would leave it inert, the very bug this fixes; **guarded** posture
 * so findings route to Review, never auto-applied; `topics: []` so it is eligible for every request
 * (no topic pre-filter); `schedule: 'off'` (inline/on-demand only — driven by the research-request
 * sweep, not a standing cron). Budgets are the shared defaults, user-editable in the Researchers view.
 * NB: the enabled-by-default posture is the one egress-policy choice the SPEC-0028 amendment may flip
 * to opt-in; the rest of the machinery is unaffected by that toggle.
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
    enabled: true,
    topics: [], // no pre-filter: eligible for every research-request
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
