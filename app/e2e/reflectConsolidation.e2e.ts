// e2e: SPEC-0024 REFLECT-5/7 — a Principal-APPROVED consolidation Review actually executes the
// merge, and the loser entity is removed from canonical `main`. This proves the *destructive
// wiring* end-to-end through the real packaged app: `kb:answerReview` (verdict 'confirm') →
// answerActiveReview → executeApprovedConsolidation → promote (deletion-aware) → loser gone on
// `main`. The unit tests prove the merge/promote LOGIC (mergeNodes, executeApprovedConsolidation);
// this proves the real Review-answer FIRES it and removes the loser from `main` — because the
// consequence is destructive on canonical, the wiring is proven, not argued (a dispatch bug —
// misread `executed`, wrong promote path, lock misuse — would be catastrophic + unit-invisible).
// e2e is CI-only (SPEC-0012 TEST-9).
import { test, expect, _electron as electron, type ElectronApplication } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import simpleGit from 'simple-git';
import { builtMainEntry } from './packagedApp';
import { createKb } from '../src/kb/vault';
import { ensureStagingWorktree } from '../src/kb/stagingWorktree';
import { promote } from '../src/kb/staging';
import { reviewRel, writeReviewFile } from '../src/kb/reviewStore';
import { ulid } from '../src/kb/ulid';
import type { Review } from '../src/kb/reviews';

const CANON = 'entities/person/steve-jobs.md';
const LOSER = 'entities/person/steven-jobs.md';

function rmDirBestEffort(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch {
    /* leave it for the OS to reap */
  }
}

function entityNode(name: string): string {
  return `---\nid: ${name}\nkind: person\nname: ${name}\n---\n# ${name}\n`;
}

/** An OPEN consolidation review (the app's answerReview sets the verdict) — its merge plan rides in
 *  the markerKey, exactly as JobStage raises one for a Reflect destructive finding (REFLECT-5/7). */
function openConsolidationReview(id: string): Review {
  return {
    id,
    status: 'open',
    question: 'Merge Steven Jobs into Steve Jobs?',
    detail: 'Same person.',
    raisedBy: {
      stage: 'job:reflect',
      runId: '01R',
      item: { kind: 'job', ref: '.kb/jobs/reflect/journal.jsonl' },
      auditRel: '.kb/jobs/reflect/journal.jsonl',
      markerKey: { jobId: 'reflect', kind: 'consolidation', canonicalRel: CANON, loserRels: LOSER },
    },
    subject: {},
    createdAt: '2026-06-02T00:00:00Z',
  };
}

/** Build a git-backed vault the app can boot: two entities + a claim promoted to `main`, plus an
 *  OPEN consolidation review on `staging` (reviews live on staging, never promoted). */
async function seedConsolidationVault(): Promise<{ vault: string; reviewId: string }> {
  const vault = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-e2e-consol-vault-'));
  await createKb({ path: vault, initGitIfNeeded: true });
  const stagingWt = await ensureStagingWorktree(vault);

  await fs.promises.mkdir(path.join(stagingWt, 'entities', 'person'), { recursive: true });
  await fs.promises.writeFile(path.join(stagingWt, CANON), entityNode('Steve Jobs'), 'utf8');
  await fs.promises.writeFile(path.join(stagingWt, LOSER), entityNode('Steven Jobs'), 'utf8');
  await fs.promises.mkdir(path.join(stagingWt, 'claims', '2026'), { recursive: true });
  await fs.promises.writeFile(
    path.join(stagingWt, 'claims/2026/01C.md'),
    `---\nid: 01C\nsubject: ${LOSER}\nstatus: fact\nconfidence: 0.9\n---\n\nCo-founded Apple.\n`,
    'utf8',
  );
  {
    const g = simpleGit(stagingWt);
    await g.add('-A');
    await g.commit('seed entities + claim');
  }
  await promote(vault); // MAIN now carries both entities + the claim (so the loser can later be removed FROM main)

  // The reflect job's journal must exist on staging: answerReview appends an answer marker to the
  // review's `auditRel` (the job journal) with fs.appendFile, which does NOT create the parent dir.
  // Mirror a reflect pass having journaled before it raised the consolidation Review.
  await fs.promises.mkdir(path.join(stagingWt, '.kb', 'jobs', 'reflect'), { recursive: true });
  await fs.promises.writeFile(
    path.join(stagingWt, '.kb', 'jobs', 'reflect', 'journal.jsonl'),
    JSON.stringify({ ts: '2026-06-02T00:00:00Z', runId: '01R', inspected: 'reflect pass', applied: 0, deferred: 1 }) + '\n',
    'utf8',
  );

  const reviewId = ulid();
  await writeReviewFile(path.join(stagingWt, reviewRel(reviewId)), openConsolidationReview(reviewId));
  {
    const g = simpleGit(stagingWt);
    await g.add('-A');
    await g.commit('seed open consolidation review');
  }
  return { vault, reviewId };
}

test.describe('REFLECT-5/7 — an approved consolidation removes the loser from main', () => {
  let app: ElectronApplication | null = null;
  let userDataDir: string | null = null;
  let vaultDir: string | null = null;

  test.afterEach(async () => {
    await app?.close();
    app = null;
    if (vaultDir) rmDirBestEffort(vaultDir);
    if (userDataDir) rmDirBestEffort(userDataDir);
    userDataDir = vaultDir = null;
  });

  test('answering a consolidation Review with confirm merges + promotes the deletion to main', async () => {
    const main = builtMainEntry();
    expect(main, 'built bundle not found — run `npm run package` first').toBeTruthy();

    userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-e2e-consol-'));
    const seed = await seedConsolidationVault();
    vaultDir = seed.vault;
    fs.writeFileSync(path.join(userDataDir, 'kb-app.config.json'), JSON.stringify({ activeVaultPath: seed.vault }) + '\n');

    // Precondition: both entities are present on `main` (the vault root checkout).
    expect(fs.existsSync(path.join(seed.vault, CANON))).toBe(true);
    expect(fs.existsSync(path.join(seed.vault, LOSER))).toBe(true);

    app = await electron.launch({ args: [main as string, `--user-data-dir=${userDataDir}`] });
    const page = await app.firstWindow();
    await page.waitForLoadState('domcontentloaded');

    // Wait until the pipeline is active and the seeded OPEN review surfaces via the real IPC.
    await expect
      .poll(async () => page.evaluate(async () => (await (window as { kbApi: { listReviews(): Promise<{ id: string }[]> } }).kbApi.listReviews()).map((r) => r.id)), {
        timeout: 25_000,
      })
      .toContain(seed.reviewId);

    // Answer 'confirm' through the real IPC — fires answerActiveReview → consolidation → promote.
    const result = await page.evaluate(
      (id) => (window as { kbApi: { answerReview(req: { id: string; verdict: string }): Promise<{ ok: boolean }> } }).kbApi.answerReview({ id, verdict: 'confirm' }),
      seed.reviewId,
    );
    expect(result.ok).toBe(true);

    // The loser is removed from canonical `main` (deletion-aware promotion); the survivor remains.
    await expect.poll(() => fs.existsSync(path.join(seed.vault, LOSER)), { timeout: 15_000 }).toBe(false);
    expect(fs.existsSync(path.join(seed.vault, CANON))).toBe(true);
  });
});
