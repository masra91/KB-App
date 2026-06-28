// SPEC-0060 QA-infra — the walkthrough seeded vault yields POPULATED states. The live-walkthrough gate
// could only ever exercise the warming/empty faces of the projection-backed views (Agents Schedules/
// Researchers, Reviews) because the seeded vault left those registries empty. This test builds the real
// fixture and asserts the PRODUCTION readers (the same `readJobRegistry`/`readResearcherRegistry`/
// `findOpenReviews` the app calls) return ≥1 populated row each — so a regression that empties the seed
// (or drifts a record shape past a validator) fails HERE, before it silently hollows the live gate.
//
// The fixture commits to `main`; the app branches `staging` off main's HEAD on open
// (ensureStagingBranch), so these registries + the review ride into the staging worktree the readers use
// in production. This test reads at the vault root (where the committed working tree lives), which
// validates the seed's SHAPE + that the production validators accept it — the staging-ride itself is
// unchanged production code (ensureStagingBranch), not re-tested here.
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import { seedWalkthroughVault } from '../../e2e/seededVault';
import { readJobRegistry } from './jobRegistry';
import { readResearcherRegistry } from './researcherRegistry';
import { findOpenReviews } from './reviewStore';
import { loadActivityIndex } from './activityIndex';
import { catalogEntry } from './jobCatalog';

let cleanup: string[] = [];
afterEach(() => {
  for (const dir of cleanup) fs.rmSync(dir, { recursive: true, force: true });
  cleanup = [];
});

describe('walkthrough seeded vault → POPULATED projection states (SPEC-0060 QA-infra)', () => {
  it('seeds ≥1 scheduled job, ≥1 researcher, ≥1 open review, ≥1 activity entry (live-gate can judge ready states)', async () => {
    const { vault, userDataDir } = seedWalkthroughVault();
    cleanup.push(vault, userDataDir);

    // Agents · Schedules — a registered job on a REAL cadence (not the catalog default 'off').
    const jobs = await readJobRegistry(vault);
    expect(jobs.length).toBeGreaterThanOrEqual(1);
    const scheduled = jobs.filter((j) => j.schedule !== 'off');
    expect(scheduled.length).toBeGreaterThanOrEqual(1);
    // The hardcoded `type: 'reflect'` must stay a real catalog type (guards against catalog drift).
    expect(catalogEntry(scheduled[0].type)).toBeDefined();

    // Agents · Researchers — at least one real researcher row.
    const researchers = await readResearcherRegistry(vault);
    expect(researchers.length).toBeGreaterThanOrEqual(1);
    expect(researchers[0].prompt.length).toBeGreaterThan(0);

    // Reviews — at least one OPEN review (the "needs you" ember card), with decision-grade candidates.
    const reviews = await findOpenReviews(vault);
    expect(reviews.length).toBeGreaterThanOrEqual(1);
    expect(reviews[0].status).toBe('open');
    expect((reviews[0].subject.candidates ?? []).length).toBeGreaterThanOrEqual(2); // CONNECT-15 disambiguation card

    // Activity — at least one real audit event (the feed, not the empty state).
    const activity = await loadActivityIndex(vault);
    expect(activity.events.length).toBeGreaterThanOrEqual(1);
  });
});
