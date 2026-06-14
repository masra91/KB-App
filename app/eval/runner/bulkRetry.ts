// SPEC-0049 HEAL-7 — the bulk-retry harness. Re-runs the vault's SET-ASIDE sources (the 203 the dogfood
// vault accumulated from harness brittleness — `JSON.parse` deciders with no self-repair) through the
// REAL decompose→connect→claims drain on a chosen model + DEV-2's self-repair, and reports the residual:
// how many converged vs how many are STILL set aside (the toss-rate AFTER, the SPEC-0049 success measure).
//
// Mechanism (non-destructive): a partial REPLAY (SPEC-0022 REPLAY-6). A set-aside source carries a
// terminal `setaside` marker in its append-only audit, so the stage queue-readers skip it forever. We
// append a fresh replay-epoch marker to ONLY the set-aside sources — that supersedes their old terminal
// (the readers honor only post-epoch markers), so they re-enter the decompose queue WITHOUT touching the
// good entities/claims already derived and WITHOUT rewriting history. Then we drive the real drain and
// re-measure. By default we operate on a COPY of the vault (the real vault is never mutated by a
// measurement run); `inPlace` opts into actually remediating the live vault.
//
// The model-under-test is NEVER mocked (EVAL-2): the deciders resolve their model the production way
// (copilotModel.ts / KB_COPILOT_MODEL — pin opus-4.8 for the canonical run), and self-repair lives
// inside those deciders once DEV-2's HEAL-1/2 lands — the harness just drives the real path.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import simpleGit from 'simple-git';
import { ensureStagingWorktree } from '../../src/kb/stagingWorktree';
import { Mutex } from '../../src/kb/stageLock';
import { promote } from '../../src/kb/staging';
import { decomposeOne, readDecomposeQueue, findSourceDirs } from '../../src/kb/decomposeStage';
import { makeDecomposeDecider } from '../../src/kb/decomposeAgent';
import { ConnectStage } from '../../src/kb/connectStage';
import { makeConnectDecider } from '../../src/kb/connectAgent';
import { ClaimsStage } from '../../src/kb/claimsStage';
import { makeClaimsDecider } from '../../src/kb/claimsAgent';
import { DEFAULT_STAGE_CAP } from '../../src/kb/canonicalAdvance';
import { createVaultTracer, STAGE_RUN_OP, type Tracer } from '../../src/kb/tracing';
import { createVaultDevLog, type DevLog } from '../../src/kb/devlog';
import { newReplayId, replayResetLine, epochScopedLines, REPLAY_RESET_EVENT } from '../../src/kb/replayEpoch';
import { makeTempDir, rmTempDir } from '../../test/tempVault';
import { captureSnapshot, type VaultSnapshot } from './snapshot';

/** A source that left the pipeline via a terminal `setaside` (the toss) without ever succeeding. */
export interface SetAsideSource {
  /** Absolute path to the source dir (the one holding `source.md` + `audit.jsonl`). */
  dir: string;
  /** The stage(s) whose epoch-scoped audit recorded a `setaside` for this source (usually `decompose`). */
  stages: string[];
}

/** The success terminal markers — a source carrying any of these (in the current epoch) made progress
 *  and is NOT a residual toss. Mirrors each stage's terminal-success audit event. */
const SUCCESS_TERMINALS = new Set(['decomposed', 'connected', 'claimed', 'composed']);

/** Parse a source's append-only audit.jsonl (epoch-scoped to the latest replay generation) into the set
 *  of `setaside` stages and whether it carries any success terminal. Malformed lines are tolerated. */
function readSetAsideState(raw: string): { setAsideStages: Set<string>; succeeded: boolean } {
  const setAsideStages = new Set<string>();
  let succeeded = false;
  for (const line of epochScopedLines(raw)) {
    const t = line.trim();
    if (!t) continue;
    let o: { stage?: string; event?: string };
    try {
      o = JSON.parse(t) as { stage?: string; event?: string };
    } catch {
      continue;
    }
    if (o.event === 'setaside') setAsideStages.add(o.stage ?? 'unknown');
    if (o.event && SUCCESS_TERMINALS.has(o.event)) succeeded = true;
  }
  return { setAsideStages, succeeded };
}

/**
 * Find every source in `root` that is terminally SET ASIDE in the current replay epoch and never
 * succeeded — i.e. a stuck toss the queue-readers skip. This is the "before" population the bulk-retry
 * re-runs (target ≈ the 203). Reads source audits directly (fs), so it's pure of git/copilot.
 */
export async function findSetAsideSources(root: string): Promise<SetAsideSource[]> {
  const dirs = await findSourceDirs(root);
  const out: SetAsideSource[] = [];
  for (const dir of dirs) {
    let raw: string;
    try {
      raw = await fs.readFile(path.join(dir, 'audit.jsonl'), 'utf8');
    } catch {
      continue; // no audit → not a tracked set-aside
    }
    const { setAsideStages, succeeded } = readSetAsideState(raw);
    if (setAsideStages.size > 0 && !succeeded) out.push({ dir, stages: [...setAsideStages].sort() });
  }
  return out.sort((a, b) => (path.basename(a.dir) < path.basename(b.dir) ? -1 : 1));
}

/**
 * Re-enqueue set-aside sources via a partial replay (REPLAY-6): append one shared epoch marker to each
 * source's audit, so its old terminal `setaside` is superseded and it re-enters the stage queues — the
 * good entities/claims are untouched (no purge). Returns the number reset. Append-only, non-destructive.
 * Caller commits the markers (so they survive the drain's git advances) when driving the real pipeline.
 */
export async function reEnqueueSetAside(root: string, sourceDirs: string[], opts: { replayId?: string; ts?: string } = {}): Promise<number> {
  const replayId = opts.replayId ?? newReplayId();
  let n = 0;
  for (const dir of sourceDirs) {
    await fs.appendFile(path.join(dir, 'audit.jsonl'), replayResetLine(replayId, opts.ts));
    n += 1;
  }
  return n;
}

/** The structured outcome of a bulk-retry run — the HEAL-7 report. */
export interface BulkRetryReport {
  /** The model the deciders resolved to (KB_COPILOT_MODEL or 'default' when unpinned). */
  model: string;
  /** The replay epoch minted for this retry batch. */
  replayId: string;
  /** Set-aside sources found BEFORE the retry (the toss population — target ≈ 203). */
  beforeSetAside: number;
  /** How many were re-enqueued (= beforeSetAside). */
  reEnqueued: number;
  /** Sources that now carry a success terminal — they CONVERGED this run. */
  converged: number;
  /** Sources STILL terminally set aside after the retry (the residual toss). Success → ~0. */
  residualSetAside: number;
  /** Toss-rate AFTER = residual / re-enqueued. The SPEC-0049 success measure (→ ~0). */
  tossRateAfter: number;
  /** Cross-check from this run's telemetry: setaside / terminal decompose `stage.run` spans. */
  spanSetAsideRate: number | null;
}

/** Compute the report from the before-population + the post-drain audit residual + this run's spans. */
export function computeBulkRetryReport(args: {
  before: SetAsideSource[];
  after: SetAsideSource[];
  snap: VaultSnapshot;
  replayId: string;
  model: string;
}): BulkRetryReport {
  const { before, after, snap, replayId, model } = args;
  const beforeSetAside = before.length;
  const residualSetAside = after.length;
  const converged = Math.max(0, beforeSetAside - residualSetAside);
  const tossRateAfter = beforeSetAside === 0 ? 0 : residualSetAside / beforeSetAside;
  // Span-derived cross-check (decompose locus — where the 203 were tossed). The validator returns a
  // detail like "N/M set aside (stage 'decompose') = X%"; we re-derive the raw rate from the spans here.
  const runs = snap.spans.filter((s) => s.op === STAGE_RUN_OP && s.stage === 'decompose');
  const terminal = runs.filter((s) => s.outcome === 'ok' || s.outcome === 'setaside');
  const spanSetAsideRate = terminal.length === 0 ? null : runs.filter((s) => s.outcome === 'setaside').length / terminal.length;
  return { model, replayId, beforeSetAside, reEnqueued: beforeSetAside, converged, residualSetAside, tossRateAfter, spanSetAsideRate };
}

/** A human-readable HEAL-7 report (for the #control post + the opt-in eval log). */
export function formatBulkRetryReport(r: BulkRetryReport): string {
  const pct = (x: number | null) => (x === null ? 'n/a' : `${(x * 100).toFixed(1)}%`);
  const verdict = r.residualSetAside === 0 ? '✓ toss-rate → 0 (every set-aside source converged)' : `${r.residualSetAside} residual toss(es) remain`;
  return [
    `HEAL-7 bulk-retry — model=${r.model} epoch=${r.replayId}`,
    `  set-aside before:   ${r.beforeSetAside}`,
    `  re-enqueued:        ${r.reEnqueued}`,
    `  converged:          ${r.converged}`,
    `  residual set-aside: ${r.residualSetAside}`,
    `  toss-rate after:    ${pct(r.tossRateAfter)}  (span cross-check: ${pct(r.spanSetAsideRate)})`,
    `  ${verdict}`,
  ].join('\n');
}

export interface RunBulkRetryOptions {
  /** The vault whose set-aside sources to bulk-retry (the dogfood vault for the canonical 203-run). */
  vaultPath: string;
  /** Mutate the real vault in place (actually remediate it). Default false: run on a throwaway COPY so a
   *  measurement never touches the user's vault. */
  inPlace?: boolean;
  /** Max decompose sweep passes before giving up on a never-terminating item (mirrors the stage sweep). */
  maxDecomposePasses?: number;
  /** Bound the retry to the first N set-aside sources (deterministic order). A real-copilot drain runs
   *  ~tens-of-seconds-to-minutes PER source, so the full population (≈203) is many hours — too long for a
   *  single test window. `limit` takes a quick representative SAMPLE (a real residual number in minutes)
   *  and lets the full population be worked in CHUNKS across runs. Omit/0 = the whole population. The
   *  report's denominator is exactly the targeted subset. */
  limit?: number;
  /** Inspect the post-drain snapshot (human-eyeball dogfood logging), as the scenario runner does. */
  onSnapshot?: (snap: VaultSnapshot) => void;
}

/** Default decompose sweep passes — K=3 set-aside attempts + buffer, so a poison item reaches its
 *  terminal set-aside without an unbounded loop (matches the scenario driver). */
const DEFAULT_DECOMPOSE_PASSES = 5;

/** Subpaths (relative to the vault root) that must NOT be carried into a non-destructive copy. A vault
 *  that has ever run the pipeline (i.e. EVERY real vault, incl. the 203 dogfood vault) holds live git
 *  worktrees under `.kb/cache/worktrees/*` whose `.git` files store ABSOLUTE `gitdir:` pointers back to
 *  the SOURCE vault, plus `.git/worktrees/*` admin entries that also encode absolute source paths.
 *  `fs.cp` copies both verbatim, so the "copy" stays wired to the original: `ensureStagingWorktree`
 *  sees the copied `staging` dir pass `--is-inside-work-tree` (its `.git` resolves to the real vault),
 *  deems it healthy, reuses it — and every git op (the replay-reset commit, each stage's ephemeral
 *  worktree) silently mutates the REAL vault, defeating the non-destructive guarantee AND crashing the
 *  drain with a doubled, nonexistent path (`…/staging/.kb/cache/worktrees/claims-<id>` ENOENT).
 *  Excluding them makes the copy self-contained — `ensureStagingWorktree` builds a FRESH staging
 *  worktree inside the copy's OWN git. */
const COPY_EXCLUDE_RELS = [path.join('.kb', 'cache', 'worktrees'), path.join('.git', 'worktrees')];

/**
 * Copy a vault to `dest` for a non-destructive bulk-retry, SEVERING the source's live git worktrees so
 * the copy is genuinely isolated (see COPY_EXCLUDE_RELS — without this, a real vault leaks its retry
 * back into the original). Exported so the isolation is unit-tested directly, since the live drain that
 * would otherwise exercise it can't run in CI.
 */
export async function copyVaultIsolated(srcVault: string, dest: string): Promise<void> {
  const src = path.resolve(srcVault);
  const excluded = COPY_EXCLUDE_RELS.map((rel) => path.join(src, rel));
  await fs.cp(src, dest, {
    recursive: true,
    // false skips the path AND (via the startsWith test) everything under it, regardless of whether
    // node descends into a filtered directory — robust across Node fs.cp filter-recursion behavior.
    filter: (from) => !excluded.some((ex) => from === ex || from.startsWith(ex + path.sep)),
  });
}

/**
 * Run the full HEAL-7 bulk-retry against a vault: find set-aside sources → partial-replay re-enqueue →
 * drive the REAL decompose→connect→claims drain on the resolved model + self-repair → measure residual.
 * Drives real copilot, so this is the opt-in live path (the .eval.ts entry gates it on KB_EVAL).
 */
export async function runBulkRetry(opts: RunBulkRetryOptions): Promise<BulkRetryReport> {
  const src = path.resolve(opts.vaultPath);
  const maxPasses = opts.maxDecomposePasses ?? DEFAULT_DECOMPOSE_PASSES;
  let tempRoot: string | null = null;
  let root = src;
  if (!opts.inPlace) {
    tempRoot = await makeTempDir('kb-bulk-retry-');
    root = path.join(tempRoot, 'vault');
    await copyVaultIsolated(src, root);
  }
  try {
    // 1) BEFORE — the toss population (read from the canonical vault before staging). `limit` bounds it
    //    to the first N (deterministic order) so a slow real-copilot drain can be sampled / chunked; the
    //    targeted subset (by vault-relative path) is what we re-enqueue, drain, and measure.
    const allBefore = await findSetAsideSources(root);
    const before = opts.limit && opts.limit > 0 ? allBefore.slice(0, opts.limit) : allBefore;
    const targetRel = new Set(before.map((s) => path.relative(root, s.dir)));

    // 2) Re-enqueue via partial replay on the staging worktree (only the targeted subset), then commit
    //    so the markers survive the drain's git advances.
    const stagingWt = await ensureStagingWorktree(root);
    const replayId = newReplayId();
    const stagedSetAside = (await findSetAsideSources(stagingWt)).filter((s) => targetRel.has(path.relative(stagingWt, s.dir)));
    await reEnqueueSetAside(
      stagingWt,
      stagedSetAside.map((s) => s.dir),
      { replayId },
    );
    const git = simpleGit(stagingWt);
    await git.add('-A');
    await git.commit(`bulk-retry: partial replay-reset ${stagedSetAside.length} set-aside source(s) (HEAL-7, epoch ${replayId})`);

    // 3) Drive the REAL drain with telemetry sinks pointed at the vault root (where the snapshot reads).
    const lock = new Mutex();
    const log: DevLog = createVaultDevLog(root, { level: 'info' });
    const tracer: Tracer = createVaultTracer(root, { log });
    const promoteEvergreen = async (): Promise<void> => {
      await promote(root);
    };
    // Scope the Copilot subprocess cwd to the staging worktree (COPILOT-CONTEXT-SCOPE-BUG): on a large
    // real vault an unscoped cwd makes Copilot's workspace scan root-walk the filesystem. The cli path +
    // model are resolved inside the runner the production way (copilotModel.ts / KB_COPILOT_MODEL).
    const decideOpts = { vaultPath: stagingWt };
    const connectPoke = (): Promise<void> => new ConnectStage(stagingWt, makeConnectDecider(decideOpts), lock, undefined, promoteEvergreen, log, tracer).poke();

    let q = await readDecomposeQueue(stagingWt);
    for (let pass = 0; q.length > 0 && pass < maxPasses; pass++) {
      for (const srcRel of q) {
        const span = tracer.start(STAGE_RUN_OP, { stage: 'decompose', itemId: path.basename(srcRel) });
        const r = await decomposeOne(stagingWt, srcRel, makeDecomposeDecider(decideOpts), lock, undefined, log, span);
        span.end(r.ok ? 'ok' : r.setAside ? 'setaside' : 'error', r.error);
      }
      q = await readDecomposeQueue(stagingWt);
    }
    await connectPoke();
    await new ClaimsStage(stagingWt, makeClaimsDecider(decideOpts), lock, undefined, promoteEvergreen, DEFAULT_STAGE_CAP, log, tracer).poke();
    await connectPoke(); // settle link-promotion lock-free after claims (mirrors the scenario driver)
    await tracer.flush();
    await log.flush();

    // 4) AFTER — residual set-aside WITHIN the targeted subset + the snapshot (span cross-check + log).
    const after = (await findSetAsideSources(root)).filter((s) => targetRel.has(path.relative(root, s.dir)));
    const snap = await captureSnapshot(root);
    opts.onSnapshot?.(snap);
    return computeBulkRetryReport({ before, after, snap, replayId, model: process.env.KB_COPILOT_MODEL ?? 'default' });
  } finally {
    if (tempRoot) await rmTempDir(tempRoot);
  }
}

export { REPLAY_RESET_EVENT };
