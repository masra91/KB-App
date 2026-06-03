// Manual SEED for the Field Desk escalation deep-link (SPEC-0028 RESEARCH-11; #65/#186) — NOT a unit
// test (no `.test.ts`, never auto-run). It deterministically puts a researcher into the `escalated`
// last-run state + writes the matching open depth-limit Review, WITHOUT having to induce a real
// research→finding→research-request depth chain in the GUI (which is hard to drive live). That lets a
// BYOA/Playwright pass assert the "open review →" affordance + its navigation to the Reviews queue.
//
// The running app reads researchers + reviews from its STAGING worktree, so seed THAT (not the vault
// root):  <vault>/.kb/cache/worktrees/staging
//
//   cd app && node_modules/.bin/vite-node test/fieldDeskEscalationSeed.ts /path/to/vault/.kb/cache/worktrees/staging
//
// Then reload the Researchers view: the seeded researcher's last-run reads "paused — needs your review"
// with an "open review →" control; clicking it navigates to Reviews, where the seeded depth-limit
// Review awaits confirm/reject (confirm → resume-on-confirm runs one level deeper). Re-running is
// idempotent on the Review (raiseResearchEscalation reuses an open one per requestId).
import { upsertResearcher } from '../src/kb/researcherRegistry';
import { raiseResearchEscalation } from '../src/kb/researchEscalate';
import { DEFAULT_RESEARCHER_BUDGET, dedupKeyFor, type ResearcherConfig, type ResearchRequest } from '../src/kb/researchers';

async function main(): Promise<void> {
  const root = process.argv[2];
  if (!root) {
    process.stderr.write('usage: vite-node test/fieldDeskEscalationSeed.ts <staging-worktree-root>\n');
    process.exit(2);
    return;
  }
  const id = process.argv[3] ?? 'web-escalation-demo';
  const researcher: ResearcherConfig = {
    id,
    template: 'web',
    label: 'Escalation demo (seeded)',
    prompt: 'Seeded researcher for the Field Desk escalation deep-link demo.',
    egressTier: 'public-web',
    scope: 'global',
    budget: { ...DEFAULT_RESEARCHER_BUDGET, maxDepth: 2 },
    schedule: 'off',
    posture: 'guarded',
    enabled: true,
  };
  await upsertResearcher(root, researcher);

  // An over-depth request (depth 3 > maxDepth 2) — exactly what the dispatcher escalates.
  const what = 'Seeded over-depth research topic';
  const req: ResearchRequest = {
    id: 'seed-request:1',
    ts: new Date().toISOString(),
    by: { stage: 'decompose', sourceId: 'seed-source' },
    what,
    why: 'seeded depth-limit escalation for the Field Desk GUI demo',
    context: 'seeded',
    dedupKey: dedupKeyFor({ what, by: { sourceId: 'seed-source' } }),
    depth: 3,
  };
  const esc = await raiseResearchEscalation(root, researcher, req, 3);

  process.stdout.write(
    `Seeded escalation:\n  researcher: ${id} (enabled, public-web)\n  reviewId:   ${esc.reviewId} (${esc.created ? 'created' : 'reused existing open'})\n` +
      `Open the Researchers view → strip "${id}" shows "paused — needs your review" + "open review →".\n` +
      `Click it → Reviews queue → the depth-limit Review for "${what}" awaits confirm/reject.\n`,
  );
}

void main();
