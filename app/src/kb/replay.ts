// Full Replay (SPEC-0022 REPLAY, full rebuild v1) — vault mechanics. Throw away everything the
// pipeline derived (candidates/entities/claims/outputs/open reviews/caches), keep every immutable
// Source + the inbox, and reset all pipeline status via the append-only replay epoch (REPLAY-6)
// so the machine re-derives the whole KB from scratch on resume.
//
// Runs on the `staging` worktree as ONE atomic commit (never a half-purged staging — REPLAY-8/13),
// then the promotion gate republishes an evergreen `main` for the cleared generation (REPLAY-8).
// The purge itself is a commit, so the discarded generation stays recoverable in git history
// (REPLAY-10). This module is the locked critical section; the caller (pipeline.ts) pauses the
// stage sweeps before and resumes them after, which auto-rebuilds the KB (REPLAY-9).
import { promises as fs } from 'node:fs';
import path from 'node:path';
import simpleGit from 'simple-git';
import { ensureGitIdentity } from './vault';
import { findSourceDirs } from './decomposeStage';
import { promote } from './staging';
import { Mutex } from './stageLock';
import { newReplayId, replayResetLine } from './replayEpoch';

/**
 * Derived trees purged by a full replay (REPLAY-4) — everything below the Source line, across
 * both the evergreen-derived trees and the working zone on `staging`. Absent trees are skipped
 * (harmless to purge a missing tree — SPEC-0022 §5). `sources/`, `inbox/`, and `.kb/config.json`
 * are deliberately NOT listed, so they are never purged (REPLAY-3 / REPLAY-7 / REPLAY-4).
 */
export const PURGE_DIRS = ['candidates', 'entities', 'claims', 'outputs', 'reviews', 'queue'] as const;

/** Of the purged trees, the ones the vault scaffold tracks as empty dirs (DATA-1): keep the dir
 *  with a `.gitkeep` so the structure survives the purge, matching a fresh `createKb`. */
const SCAFFOLD_DIRS = new Set<string>(['entities', 'outputs']);

/** The stage-wide Connect audit (keyed by blockKey, not per-Source): gets an epoch marker so a
 *  replayed block re-resolves once Connect is wired (REPLAY-6 across stages). */
const CONNECT_AUDIT_REL = path.join('connect', 'audit.jsonl');
/** Working-zone record of replay actions (REPLAY-11): replayId, ts, counts. Not promoted to main. */
const REPLAY_AUDIT_REL = path.join('replay', 'audit.jsonl');
/** Rebuildable status cache (gitignored): cleared so the UI reflects the rebuild ramp, not stale state. */
const STATUS_CACHE_REL = path.join('.kb', 'cache', 'status.json');

/** Trees `git clean` may scrub of untracked leftovers from an interrupted prior purge (REPLAY-13).
 *  Scoped to derived paths so `sources/` and `inbox/` are never touched. */
const CLEAN_SCOPE = [...PURGE_DIRS, 'connect', 'replay'];

export interface ReplayCounts {
  /** The epoch minted for this replay (monotonic ULID). */
  replayId: string;
  /** How many Source audits received the epoch marker (REPLAY-5/6). */
  sourcesReset: number;
  /** Which derived trees actually existed and were cleared. */
  purgedTrees: string[];
}

export interface ReplayOptions {
  /** Inject the epoch id (tests/determinism); defaults to a fresh monotonic id. */
  replayId?: string;
  /** Inject the timestamp (tests/determinism); defaults to now. */
  ts?: string;
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Full replay: purge derived knowledge + reset the replay epoch on `staging`, commit it as one
 * advance, then republish `main` via the promotion gate. Serialized through the shared canonical-
 * writer lock (SPEC-0014 §5) so it never races a stage's ref advance.
 *
 * Preconditions (caller's job): the pipeline's stage sweeps are paused (so no stage re-derives
 * mid-purge) and the inbox/un-archived captures are left intact (REPLAY-7). Idempotent on an
 * empty KB (no Sources → an empty commit is skipped and promotion is a no-op, STAGING-4).
 */
export async function runFullReplay(
  vaultRoot: string,
  stagingWt: string,
  lock: Mutex,
  opts: ReplayOptions = {},
): Promise<ReplayCounts> {
  return lock.run(() => purgeResetPromote(vaultRoot, stagingWt, opts), 'replay:purge-reset-promote');
}

async function purgeResetPromote(vaultRoot: string, stagingWt: string, opts: ReplayOptions): Promise<ReplayCounts> {
  stagingWt = path.resolve(stagingWt);
  const replayId = opts.replayId ?? newReplayId();
  const ts = opts.ts ?? new Date().toISOString();
  const git = simpleGit(stagingWt);
  await ensureGitIdentity(git);

  // Restartability (REPLAY-13): begin from the last committed state so an interrupted prior purge
  // leaves staging pre-purge, never half-purged. reset --hard restores tracked deletions/appends;
  // clean scrubs untracked derived leftovers (scoped — never sources/ or inbox/).
  await git.raw('reset', '--hard', 'HEAD');
  try {
    await git.raw('clean', '-fd', '--', ...CLEAN_SCOPE);
  } catch {
    /* nothing to clean */
  }

  // 1) Append the epoch marker to every Source's audit (REPLAY-5/6). Sources are otherwise
  //    untouched — only their own append-only audit grows (REPLAY-3).
  const sourceDirs = await findSourceDirs(stagingWt);
  for (const dir of sourceDirs) {
    await fs.appendFile(path.join(dir, 'audit.jsonl'), replayResetLine(replayId, ts));
  }
  // 1b) …and to the stage-wide Connect audit if it exists, so resolved blocks re-derive (REPLAY-6).
  const connectAudit = path.join(stagingWt, CONNECT_AUDIT_REL);
  if (await pathExists(connectAudit)) {
    await fs.appendFile(connectAudit, replayResetLine(replayId, ts));
  }

  // 2) Purge the derived trees (REPLAY-4). Absent trees are skipped; scaffolded trees keep a
  //    .gitkeep so the structure matches a fresh vault.
  const purgedTrees: string[] = [];
  for (const name of PURGE_DIRS) {
    const dir = path.join(stagingWt, name);
    if (!(await pathExists(dir))) continue;
    purgedTrees.push(name);
    await fs.rm(dir, { recursive: true, force: true });
    if (SCAFFOLD_DIRS.has(name)) {
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(path.join(dir, '.gitkeep'), '');
    }
  }

  // 3) Record the replay action in the working zone (REPLAY-11). Append-only across replays.
  await fs.mkdir(path.join(stagingWt, 'replay'), { recursive: true });
  await fs.appendFile(
    path.join(stagingWt, REPLAY_AUDIT_REL),
    JSON.stringify({ ts, event: 'replay', replayId, sourcesReset: sourceDirs.length, purgedTrees }) + '\n',
  );

  // 4) Clear the rebuildable status cache (gitignored; not part of the commit) so the pipeline-
  //    status surface reflects the rebuild rather than stale pre-replay numbers.
  await fs.rm(path.join(stagingWt, STATUS_CACHE_REL), { force: true }).catch(() => {});

  // 5) Commit the purge + reset as ONE atomic advance of `staging` (REPLAY-8/10/13).
  await git.raw('add', '-A');
  const status = await git.status();
  if (status.files.length > 0) {
    await git.commit(`replay: clean & rebuild — purge derived knowledge, reset epoch ${replayId}`);
  }

  // 6) Republish `main` to the cleared evergreen set via the promotion gate (REPLAY-8). The gate
  //    is the sole writer of `main`, so `main` advances atomically and is never half-purged.
  await promote(vaultRoot);

  return { replayId, sourcesReset: sourceDirs.length, purgedTrees };
}
