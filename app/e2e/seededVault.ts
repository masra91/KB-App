// Seeded-vault fixture for the live-run walkthrough harness (CORRECTIVE SWARM gate-of-record).
//
// The smoke fixtures (jobs/researchers.e2e.ts) seed a *minimal, empty* vault — enough to boot to the
// shell, but the data-views (Explore/Health/Activity) then render their EMPTY states, so a screenshot
// gate over them proves nothing. This fixture builds a tiny but REAL git-backed evergreen graph on
// disk so every data-view renders genuine, JUDGEABLE content (DL-2's seed-data spec):
//   - Explore  → a focal "Project Atlas" node with a rich rail: 4 linked neighbors + 3 claims at
//                varied confidence (0.9 / 0.65 / 0.4) so the confidence bars + a low-confidence note show.
//   - Health   → an ok + warn + bad spread: healthy linked entities ("ok") plus a deliberate orphan,
//                a dangling link, and a stub (the three structural-lint finding kinds).
//   - Activity → a real audit feed (seeded JSONL events + a resolvable git HEAD).
//   - Agents  → a registered Reflect JOB on a daily schedule + a web RESEARCHER, so the hub's Schedules
//                and Researchers sections render POPULATED rows (not just the always-present catalog at
//                its default 'off', and not the empty-researchers dock).
//   - Reviews → one OPEN disambiguation review, so the "needs you" queue renders a real ember card
//                (not the calm "Nothing needs you" empty state).
//
// All of the above are committed to `main`; the app branches `staging` off main's HEAD on open
// (ensureStagingBranch), so the jobs/researchers registries + the review ride into the staging worktree
// where listJobsForActive / listResearchersForActive / findOpenReviews read them. (SPEC-0060 QA-infra:
// populated live states so the walkthrough gate can judge ready states, not only warming/empty.)
//
// It is built with the PRODUCTION renderers (renderEntityNode/renderClaimMd + the generated
// link/claims blocks, same as app/test/recallVault.ts) so the views parse exactly what Connect/Claims
// actually write — no hand-rolled frontmatter that can silently drift from the scanners. The
// jobs/researcher/review records are type-annotated against the production interfaces (tsc catches drift).
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { renderEntityNode, applyLinksBlock, type EntityNode } from '../src/kb/connectDoc';
import { renderClaimMd, applyClaimsBlock, type ClaimBacklink } from '../src/kb/claimDoc';
import type { ClaimDecision } from '../src/kb/claims';
import { ulid, dateShard } from '../src/kb/ulid';
import type { JobConfig } from '../src/kb/jobs';
import type { ResearcherConfig } from '../src/kb/researchers';
import type { Review } from '../src/kb/reviews';

export interface SeededVault {
  /** Absolute path to the seeded vault root (a git repo). */
  vault: string;
  /** Absolute path to the temp userData dir whose kb-app.config.json points at the vault. */
  userDataDir: string;
}

const TS = '2026-06-01T00:00:00.000Z';
const SOURCE_DIR = 'sources/2026/06/01/SRC1';

function writeFile(root: string, rel: string, body: string): void {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, body);
}

function entity(node: Partial<EntityNode> & Pick<EntityNode, 'kind' | 'name' | 'confidence'>): EntityNode {
  return {
    id: ulid(),
    aliases: [],
    tags: [`type/${node.kind}`],
    derivedFrom: [SOURCE_DIR],
    resolvedFrom: [],
    createdAt: TS,
    updatedAt: TS,
    ...node,
  };
}

// renderEntityNode emits `…---\n\n# <name>\n` with no prose body — every node would read as a stub
// (<280-char body). Append real prose after the heading (before the generated link/claims blocks) so a
// node clears Health's stub threshold; a node left without prose stays a deliberate stub.
function withProse(entityMd: string, prose: string): string {
  return `${entityMd}\n${prose}\n`;
}

/**
 * Seed a fresh userData dir + a populated, git-backed vault. Returns both paths.
 * The caller launches the built app with `--user-data-dir=<userDataDir>` and the app resolves
 * `activeVaultPath` → the seeded vault. Caller owns cleanup (both are under os.tmpdir()).
 */
export function seedWalkthroughVault(): SeededVault {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-walkthrough-ud-'));
  const vault = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-walkthrough-vault-'));

  // --- Vault identity + scaffolding -------------------------------------------------------------
  writeFile(vault, '.gitignore', '.kb/cache/\n');
  writeFile(vault, 'README.md', '# Walkthrough KB\n\nA seeded vault for the live-run walkthrough gate.\n');
  writeFile(
    vault,
    '.kb/config.json',
    JSON.stringify({ schemaVersion: 1, id: 'e2e-walkthrough-kb', name: 'Walkthrough KB', createdAt: TS }, null, 2),
  );
  // --- Agents: a scheduled Reflect job + a web researcher (so the hub renders POPULATED sections) ----
  // Reflect on a DAILY cadence → the hub's "Schedules" group shows a real scheduled job (the catalog
  // rows alone default to 'off'). `type: 'reflect'` matches JOB_CATALOG (asserted in the test).
  const seedJobs: JobConfig[] = [
    { id: 'reflect', type: 'reflect', schedule: 'daily', enabled: true, posture: 'guarded', facing: 'internal' },
  ];
  writeFile(vault, '.kb/jobs/registry.json', JSON.stringify(seedJobs, null, 2));
  // One web researcher → the hub's "Researchers" section renders a real row (not the empty add-dock).
  const seedResearchers: ResearcherConfig[] = [
    {
      id: 'web-scout',
      template: 'web',
      label: 'Web Scout',
      prompt: 'Track public developments relevant to Project Atlas and the Finance Team, and surface anything that affects the Q3 Budget.',
      egressTier: 'public-web',
      scope: 'global',
      budget: { maxToolCalls: 8, maxDepth: 2 },
      schedule: 'daily',
      posture: 'guarded',
      enabled: true,
    },
  ];
  writeFile(vault, '.kb/researchers/registry.json', JSON.stringify(seedResearchers, null, 2));

  // --- Source (immutable ground truth) ----------------------------------------------------------
  writeFile(
    vault,
    `${SOURCE_DIR}/source.md`,
    '---\nid: SRC1\n---\n\nProject Atlas is the FY26 cross-team knowledge initiative, led with the Finance Team against the Q3 Budget. Ada Lovelace and Steve Park are the leads.\n',
  );

  // --- Rel-paths ---------------------------------------------------------------------------------
  const atlasRel = 'entities/project/project-atlas.md';
  const adaRel = 'entities/person/ada-lovelace.md';
  const financeRel = 'entities/org/finance-team.md';
  const budgetRel = 'entities/concept/q3-budget.md';
  const steveRel = 'entities/person/steve-park.md';

  // --- Helper: render a claim file + return its backlink row for the entity's claims block -------
  let claimSeq = 0;
  const claim = (subjectRel: string, c: ClaimDecision): ClaimBacklink => {
    const claimRel = `claims/project/project-atlas-${++claimSeq}.md`;
    writeFile(vault, claimRel, renderClaimMd(c, { id: ulid(), subject: subjectRel, derivedFrom: SOURCE_DIR, createdAt: TS }));
    return { claimPath: claimRel, statement: c.statement, status: c.status, confidence: c.confidence };
  };

  // --- FOCAL node: Project Atlas (top confidence → Explore's default center) ---------------------
  // 4 linked neighbors + 3 claims at varied confidence so the focal rail shows confidence bars + a
  // low-confidence (hypothesis) note (DL-2 rubric).
  let atlasMd = withProse(
    renderEntityNode(entity({ kind: 'project', name: 'Project Atlas', confidence: 0.95, tags: ['type/project', 'initiative'] })),
    'Project Atlas is the FY26 cross-team knowledge initiative, consolidating how the Finance Team plans and ' +
      'reports against the Q3 Budget. It is led by Ada Lovelace with Steve Park, and is the focal program that ' +
      'the surrounding people, org, and concept entities all connect into. The initiative spans data capture, ' +
      'recall, and synthesis across the organisation.',
  );
  atlasMd = applyLinksBlock(atlasMd, [{ targetRel: adaRel }, { targetRel: financeRel }, { targetRel: budgetRel }, { targetRel: steveRel }]);
  atlasMd = applyClaimsBlock(atlasMd, [
    claim(atlasRel, { statement: 'Project Atlas is the FY26 cross-team knowledge initiative.', status: 'fact', confidence: 0.9, mentions: ['FY26 cross-team knowledge initiative'], relatesTo: ['Finance Team'] }),
    claim(atlasRel, { statement: 'Project Atlas is likely to absorb the legacy Finance reporting workflow.', status: 'interpretation', confidence: 0.65, mentions: ['Finance Team'], relatesTo: ['Finance Team'] }),
    claim(atlasRel, { statement: 'Project Atlas may expand to the EU region in Q4.', status: 'hypothesis', confidence: 0.4, mentions: [], relatesTo: ['Q3 Budget'] }),
  ]);
  writeFile(vault, atlasRel, atlasMd);

  // --- Linked neighbors (all "ok": prose + a resolved link back to Atlas) ------------------------
  const linkedNeighbor = (rel: string, node: Parameters<typeof entity>[0], prose: string, extraLinks: { targetRel: string }[] = []): void => {
    let md = withProse(renderEntityNode(entity(node)), prose);
    md = applyLinksBlock(md, [{ targetRel: atlasRel }, ...extraLinks]);
    writeFile(vault, rel, md);
  };
  // Prose for the "ok" neighbors is kept comfortably over Health's 280-char stub threshold so they read
  // as healthy (NOT thin-page findings) — only the deliberate stub below should appear under THIN PAGES.
  linkedNeighbor(
    adaRel,
    { kind: 'person', name: 'Ada Lovelace', confidence: 0.92, aliases: ['Ada', 'Lovelace'], tags: ['type/person', 'mathematician'] },
    'Ada Lovelace leads Project Atlas. A mathematician by background, she frames the initiative around making the ' +
      'organisation’s knowledge graph genuinely queryable rather than merely stored, and personally owns the recall and ' +
      'synthesis workstreams across the program. She works closely with the Finance Team to ground the initiative in the ' +
      'real reporting needs behind the Q3 Budget, and partners with Steve Park on bringing source material into the vault.',
  );
  linkedNeighbor(
    financeRel,
    { kind: 'org', name: 'Finance Team', confidence: 0.8, tags: ['type/org'] },
    'The Finance Team is the primary stakeholder of Project Atlas. They own the Q3 Budget that the initiative reports ' +
      'against, and are the first group whose planning and reporting workflow Atlas consolidates. Their requirements set ' +
      'the initial scope of the program, and their reviewers validate that what Atlas surfaces matches the figures of ' +
      'record. As the initiative matures, the team expects to retire several spreadsheets in favour of the shared graph.',
  );
  linkedNeighbor(
    budgetRel,
    { kind: 'concept', name: 'Q3 Budget', confidence: 0.75, tags: ['type/concept'] },
    'The Q3 Budget is the financial plan Project Atlas reports against. It is the shared reference the Finance Team and ' +
      'the initiative leads use to scope the FY26 workstreams and to decide what gets built first. It connects the people ' +
      'and org entities in this neighborhood to a concrete artifact, and is the figure of record against which the ' +
      'initiative’s claims about spend, savings, and forecast are checked for the cross-team reporting cadence.',
  );
  // Steve Park is "ok" (prose over the threshold + a resolved link to Atlas) but ALSO carries the
  // deliberate DANGLING link, so he is the source of the single dead-link finding.
  let steveMd = withProse(
    renderEntityNode(entity({ kind: 'person', name: 'Steve Park', confidence: 0.7, tags: ['type/person'] })),
    'Steve Park co-leads Project Atlas with Ada Lovelace, focused on the data-capture workstream and the connectors ' +
      'that bring source material into the vault for the rest of the initiative to build on. He owns the intake side of ' +
      'the program — wiring sources in, watching ingestion health, and making sure the graph stays fed — and pairs with ' +
      'the Finance Team to prioritise which reporting sources land first against the Q3 Budget for FY26 planning.',
  );
  steveMd = applyLinksBlock(steveMd, [{ targetRel: atlasRel }, { targetRel: 'entities/concept/nonexistent-thing.md' }]); // dangling → Health dead-link finding
  writeFile(vault, steveRel, steveMd);

  // --- Deliberate Health findings ---------------------------------------------------------------
  // Orphan: prose (so NOT a stub) but no links in or out → an orphan-only finding.
  writeFile(
    vault,
    'entities/concept/loose-idea.md',
    withProse(
      renderEntityNode(entity({ kind: 'concept', name: 'Loose Idea', confidence: 0.6, tags: ['type/concept'] })),
      'A standalone note that never got connected to anything — it has real, substantial prose but no links in or out, ' +
        'so it sits disconnected from the rest of the graph. It is exactly the kind of dangling thought Health surfaces ' +
        'as an orphan: worth keeping, but a candidate to reconnect into the neighborhood so it stops floating on its own. ' +
        'Because it carries enough body, it reads as an ORPHAN only — not also a thin-page stub — which is the point.',
    ),
  );
  // Stub: a short body (well under the 280-char threshold) but linked (to Ada) so it is NOT an orphan.
  let tinyMd = renderEntityNode(entity({ kind: 'person', name: 'Tiny Entry', confidence: 0.55, tags: ['type/person'] }));
  tinyMd = applyLinksBlock(withProse(tinyMd, 'A barely-there note.'), [{ targetRel: adaRel }]);
  writeFile(vault, 'entities/person/tiny-entry.md', tinyMd);

  // --- Audit feed (so Activity renders events, not its empty state) -----------------------------
  const audit = (actor: string, eventType: string, subjects: Record<string, string>, payload: Record<string, unknown>, ts: string): string =>
    JSON.stringify({ ts, actor, eventType, subjects, payload, runId: 'walkthrough-seed' });
  writeFile(
    vault,
    `${SOURCE_DIR}/audit.jsonl`,
    [
      audit('archivist', 'archived', { sourceId: 'SRC1' }, { title: 'Project Atlas kickoff brief' }, '2026-06-01T12:00:00.000Z'),
      audit('connect', 'connected', { entityId: 'project-atlas' }, { edges: 4 }, '2026-06-01T12:01:00.000Z'),
      audit('claims', 'claimed', { claimId: 'project-atlas-1' }, { confidence: 0.9 }, '2026-06-01T12:02:00.000Z'),
    ].join('\n') + '\n',
  );
  writeFile(
    vault,
    '.kb/audit.jsonl',
    audit('panel', 'recall', {}, { question: 'What is Project Atlas?' }, '2026-06-01T12:05:00.000Z') + '\n',
  );

  // --- Reviews: one OPEN disambiguation review (so the "needs you" queue renders a real ember card) --
  // A CONNECT-15-shape review with two candidates → the richest Reviews card (per-candidate rows +
  // Confirm/Reject). Committed to `main`, it rides into staging (where findOpenReviews reads). The id is
  // a ULID so its `reviews/<dateShard>/<id>/` path matches the production layout exactly.
  const reviewId = ulid();
  const review: Review = {
    id: reviewId,
    status: 'open',
    question: 'Is the “Ada” named in the kickoff brief the same person as the “Ada Lovelace” node leading Project Atlas?',
    detail: 'Two sources mention “Ada” in the Project Atlas context — confirm they are the same person so Connect can link them into one node.',
    raisedBy: {
      stage: 'connect',
      runId: 'walkthrough-seed',
      item: { kind: 'entity', ref: adaRel },
      auditRel: `${SOURCE_DIR}/audit.jsonl`,
      markerKey: { entityId: 'ada-lovelace' },
    },
    subject: {
      refs: [adaRel],
      sources: [SOURCE_DIR],
      candidates: [
        { name: 'Ada', gloss: 'the lead named only as “Ada” in the kickoff brief', title: 'Project Atlas kickoff brief', sourceRel: `${SOURCE_DIR}/source.md` },
        { name: 'Ada Lovelace', gloss: 'the existing person node already leading the initiative', title: 'Ada Lovelace', sourceRel: adaRel },
      ],
    },
    createdAt: TS,
  };
  const reviewDir = path.join('reviews', dateShard(reviewId), reviewId);
  writeFile(vault, path.join(reviewDir, 'review.json'), JSON.stringify(review, null, 2) + '\n');

  // --- Make it a real git repo (Activity reads git HEAD; SETUP-3 = git from the start) ----------
  const git = (...args: string[]): void => {
    execFileSync('git', ['-C', vault, ...args], { stdio: 'ignore' });
  };
  git('init', '-b', 'main');
  git('config', 'user.email', 'walkthrough@e2e.local');
  git('config', 'user.name', 'Walkthrough Seed');
  git('add', '-A');
  git('commit', '-m', 'chore(kb): initialize knowledge base');

  // --- Point the app at the vault ---------------------------------------------------------------
  fs.writeFileSync(path.join(userDataDir, 'kb-app.config.json'), JSON.stringify({ activeVaultPath: vault }) + '\n');

  return { vault, userDataDir };
}
