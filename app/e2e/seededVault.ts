// Seeded-vault fixture for the live-run walkthrough harness (CORRECTIVE SWARM gate-of-record).
//
// The smoke fixtures (jobs/researchers.e2e.ts) seed a *minimal, empty* vault — enough to boot to the
// shell, but the data-views (Explore/Health/Activity) then render their EMPTY states, so a screenshot
// gate over them proves nothing. This fixture builds a tiny but REAL git-backed evergreen graph on
// disk so every data-view renders genuine content:
//   - Explore  → a real neighborhood graph (linked entities, asserted edges at confidence ≥ 0.7).
//   - Health   → real findings (a deliberate orphan, a stub, and a dangling link).
//   - Activity → a real audit feed (seeded JSONL events + a resolvable git HEAD).
//   - Capture/Ask/Sources/Settings/Agents → boot against a configured, populated KB.
//
// It is built with the PRODUCTION renderers (renderEntityNode/renderClaimMd + the generated
// link/claims blocks, same as app/test/recallVault.ts) so the views parse exactly what Connect/Claims
// actually write — no hand-rolled frontmatter that can silently drift from the scanners.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { renderEntityNode, applyLinksBlock, type EntityNode } from '../src/kb/connectDoc';
import { renderClaimMd, applyClaimsBlock } from '../src/kb/claimDoc';
import type { ClaimDecision } from '../src/kb/claims';
import { ulid } from '../src/kb/ulid';

export interface SeededVault {
  /** Absolute path to the seeded vault root (a git repo). */
  vault: string;
  /** Absolute path to the temp userData dir whose kb-app.config.json points at the vault. */
  userDataDir: string;
}

const TS = '2026-06-01T00:00:00.000Z';

function writeFile(root: string, rel: string, body: string): void {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, body);
}

// renderEntityNode emits `…---\n\n# <name>\n` with no prose body — every node would read as a stub
// (<280-char body). Append real prose after the heading (before the generated link/claims blocks) so a
// node clears Health's stub threshold; nodes left without prose stay deliberate stubs.
function withProse(entityMd: string, prose: string): string {
  return `${entityMd}\n${prose}\n`;
}

function entity(node: Partial<EntityNode> & Pick<EntityNode, 'kind' | 'name' | 'confidence'>): EntityNode {
  return {
    id: ulid(),
    aliases: [],
    tags: [`type/${node.kind}`],
    derivedFrom: ['sources/2026/06/01/SRC1'],
    resolvedFrom: [],
    createdAt: TS,
    updatedAt: TS,
    ...node,
  };
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
  writeFile(vault, '.kb/jobs/registry.json', JSON.stringify([], null, 2));

  // --- Source (immutable ground truth) ----------------------------------------------------------
  const sourceDir = 'sources/2026/06/01/SRC1';
  writeFile(
    vault,
    `${sourceDir}/source.md`,
    '---\nid: SRC1\n---\n\nAda Lovelace worked on the Analytical Engine and is regarded as the first computer programmer. Charles Babbage designed it.\n',
  );

  // --- Entities: a connected pair (Ada ↔ Engine) so Explore shows a real graph ------------------
  const adaRel = 'entities/person/ada-lovelace.md';
  const engineRel = 'entities/concept/analytical-engine.md';
  const claimRel = 'claims/person/ada-lovelace.md';

  let adaMd = withProse(
    renderEntityNode(
      entity({ kind: 'person', name: 'Ada Lovelace', confidence: 0.92, aliases: ['Ada', 'Lovelace'], tags: ['type/person', 'mathematician'] }),
    ),
    'Ada Lovelace (1815–1852) was an English mathematician known for her work on Charles Babbage’s ' +
      'proposed Analytical Engine. She recognised that the machine had applications beyond pure calculation, ' +
      'and published the first algorithm intended to be carried out by such a machine — for which she is often ' +
      'regarded as the first computer programmer. Her notes on the engine remain a landmark in computing history.',
  );
  adaMd = applyLinksBlock(adaMd, [{ targetRel: engineRel }]);
  adaMd = applyClaimsBlock(adaMd, [
    { claimPath: claimRel, statement: 'Ada Lovelace is regarded as the first computer programmer.', status: 'fact', confidence: 0.8 },
  ]);
  writeFile(vault, adaRel, adaMd);

  let engineMd = withProse(
    renderEntityNode(entity({ kind: 'concept', name: 'Analytical Engine', confidence: 0.85 })),
    'The Analytical Engine was a proposed mechanical general-purpose computer designed by Charles Babbage. ' +
      'It introduced an arithmetic logic unit, control flow via conditional branching and loops, and integrated ' +
      'memory — making it the first design for a Turing-complete machine. Though never built in Babbage’s lifetime, ' +
      'it directly anticipated the architecture of the modern digital computer.',
  );
  engineMd = applyLinksBlock(engineMd, [{ targetRel: adaRel }]);
  writeFile(vault, engineRel, engineMd);

  // --- Deliberate Health findings ---------------------------------------------------------------
  // (a) Dangling link: Babbage links to an entity that doesn't exist → a dead-link finding.
  let babbageMd = renderEntityNode(entity({ kind: 'person', name: 'Charles Babbage', confidence: 0.78 }));
  babbageMd = applyLinksBlock(babbageMd, [{ targetRel: 'entities/concept/difference-engine.md' }]);
  writeFile(vault, 'entities/person/charles-babbage.md', babbageMd);

  // (b) Orphan + stub: no links in or out, and a body well under the 280-char stub threshold.
  const orphanMd = renderEntityNode(entity({ kind: 'concept', name: 'Orphaned Idea', confidence: 0.6 }));
  writeFile(vault, 'entities/concept/orphaned-idea.md', orphanMd);

  // --- Claim (grounds Ada; gives Explore a claim to surface) ------------------------------------
  const claim: ClaimDecision = {
    statement: 'Ada Lovelace is regarded as the first computer programmer.',
    status: 'fact',
    confidence: 0.8,
    mentions: ['first computer programmer'],
    relatesTo: ['Analytical Engine'],
  };
  writeFile(vault, claimRel, renderClaimMd(claim, { id: ulid(), subject: adaRel, derivedFrom: sourceDir, createdAt: TS }));

  // --- Audit feed (so Activity renders events, not its empty state) -----------------------------
  const audit = (actor: string, eventType: string, subjects: Record<string, string>, payload: Record<string, unknown>, ts: string): string =>
    JSON.stringify({ ts, actor, eventType, subjects, payload, runId: 'walkthrough-seed' });
  writeFile(
    vault,
    `${sourceDir}/audit.jsonl`,
    [
      audit('archivist', 'archived', { sourceId: 'SRC1' }, { title: 'Ada Lovelace & the Analytical Engine' }, '2026-06-01T12:00:00.000Z'),
      audit('connect', 'connected', { entityId: 'ada' }, { edges: 1 }, '2026-06-01T12:01:00.000Z'),
      audit('claims', 'claimed', { claimId: 'ada-claim' }, { confidence: 0.8 }, '2026-06-01T12:02:00.000Z'),
    ].join('\n') + '\n',
  );
  writeFile(
    vault,
    '.kb/audit.jsonl',
    audit('panel', 'recall', {}, { question: 'Who invented the Analytical Engine?' }, '2026-06-01T12:05:00.000Z') + '\n',
  );

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
