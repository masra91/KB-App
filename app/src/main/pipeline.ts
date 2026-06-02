// Main-process owner of the active vault's orchestration engine (SPEC-0014 / SPEC-0021).
//
// EVERGREEN MODEL (SPEC-0019/0021): the whole working pipeline runs on a persistent `staging`
// worktree (`.kb/cache/worktrees/staging`), never on the vault root. The stages are
// root-agnostic, so handing them the staging worktree as their "root" makes all their existing
// logic (queues, markers, isolation worktrees, ff-advance) operate on `staging`. The vault
// root stays on `main` for Obsidian; the archivist's `afterDrain` hook runs the promotion gate
// (`promote`) to publish freshly-archived `sources/` from `staging` → `main`. Working state
// (inbox, entities, claims, candidates, the Review queue) lives only on `staging`.
//
// All stages share ONE canonical-writer lock per vault (SPEC-0014 §5): promotion + every stage
// ref-advance serialize through it.
import { Orchestrator } from '../kb/orchestrator';
import { makeCopilotDecider } from '../kb/copilotAgent';
import { DecomposeStage } from '../kb/decomposeStage';
import { makeDecomposeDecider } from '../kb/decomposeAgent';
import { ClaimsStage } from '../kb/claimsStage';
import { makeClaimsDecider } from '../kb/claimsAgent';
import { ConnectStage } from '../kb/connectStage';
import { makeConnectDecider } from '../kb/connectAgent';
import { Mutex } from '../kb/stageLock';
import { ensureStagingWorktree } from '../kb/stagingWorktree';
import { promote } from '../kb/staging';
import { findOpenReviews, answerReview as answerReviewInVault, type AnswerReviewResult } from '../kb/reviewStore';
import type { Review } from '../kb/reviews';

let active: {
  vaultPath: string; // the vault root — on `main`, what Obsidian sees (promotion target)
  stagingWt: string; // the staging worktree — where every stage operates
  orch: Orchestrator;
  decompose: DecomposeStage;
  connect: ConnectStage;
  claims: ClaimsStage;
  lock: Mutex;
} | null = null;

/**
 * Start (or reuse) the pipeline for `vaultPath`, replacing any prior one. The stages run on the
 * vault's persistent `staging` worktree; the archivist promotes `sources/` to `main` after each
 * drain. All stages share one canonical-writer lock (§5). Async because it provisions the
 * staging worktree before the stages start.
 */
export async function startPipeline(vaultPath: string): Promise<Orchestrator> {
  if (active?.vaultPath === vaultPath) return active.orch;
  active?.orch.stop();
  active?.decompose.stop();
  active?.connect.stop();
  active?.claims.stop();

  const stagingWt = await ensureStagingWorktree(vaultPath); // working surface (on `staging`)
  const lock = new Mutex(); // the shared serialized canonical writer for this vault (§5)
  // The promotion gate: publish the evergreen subset staging→main, serialized under the lock
  // (SPEC-0021 STAGING-3/4). A stage runs it after a drain that changed an evergreen path
  // (archive→sources; connect→entities), so `main` tracks the resolved graph.
  const promoteEvergreen = async (): Promise<void> => {
    await promote(vaultPath);
  };
  const orch = new Orchestrator(stagingWt, makeCopilotDecider(), lock, promoteEvergreen);
  // The stages run on the staging worktree (root-agnostic) and serialize their canonical
  // advances through the one shared lock (§5). Pipeline order is Decompose→Connect→Claims
  // (SPEC-0020 reorder): Decompose emits candidates, Connect resolves them into evergreen
  // `entities/`, Claims attaches to the resolved graph. They drain independently; the lock keeps
  // their staging ff-advances from racing. Connect carries the promotion gate as its afterDrain
  // so resolved entities become visible on `main` (the archivist already promotes sources/).
  const decompose = new DecomposeStage(stagingWt, makeDecomposeDecider(), lock);
  const connect = new ConnectStage(stagingWt, makeConnectDecider(), lock, undefined, promoteEvergreen);
  // ClaimsStage is constructed (the Review-answer path pokes it via answerActiveReview) but NOT
  // started in this slice: Connect-produced nodes carry source-ULID provenance in `derivedFrom`,
  // which `claimsOne` can't yet resolve to a source dir, so a running Claims sweep would fail on
  // every entity and churn (no terminal marker recordable). Claims is wired + started with its
  // promote-after-drain hook in the claims-after-Connect slice, alongside the provenance fix.
  const claims = new ClaimsStage(stagingWt, makeClaimsDecider(), lock);
  orch.start();
  decompose.start();
  connect.start();
  active = { vaultPath, stagingWt, orch, decompose, connect, claims, lock };
  return orch;
}

/** The archivist orchestrator for the loaded KB, or null if none is active. */
export function activePipeline(): Orchestrator | null {
  return active?.orch ?? null;
}

/** The open "needs you" queue (SPEC-0018) — read from `staging`, where review state lives. */
export async function listActiveReviews(): Promise<Review[]> {
  return active ? findOpenReviews(active.stagingWt) : [];
}

/**
 * Answer an open review (REVIEW-6) on `staging`: records the verdict (+ optional note → primary
 * source), supersedes the park, then pokes the owning stage so the parked item resumes.
 */
export async function answerActiveReview(id: string, answerInput: unknown): Promise<AnswerReviewResult> {
  if (!active) return { ok: false, message: 'No active knowledge base.' };
  const result = await answerReviewInVault(active.stagingWt, active.lock, id, answerInput);
  if (result.ok && result.stage === 'claims') void active.claims.poke(); // resume the unparked item
  return result;
}

/** Stop and clear the active pipeline (used on shutdown / vault switch). */
export function stopPipeline(): void {
  active?.orch.stop();
  active?.decompose.stop();
  active?.connect.stop();
  active?.claims.stop();
  active = null;
}
