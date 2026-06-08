// The Connect stage runtime (SPEC-0020) — the FOURTH user of the SPEC-0014 harness: the SAME
// deterministic pattern as archivist / Decompose / Claims (worktree isolation, fresh
// disposable session per item, orchestrator-owns-effects, ff-advance under the shared
// canonical-writer lock), pointed at a different work-list + instruction file (ORCH-9).
//
// Connect is the FIRST stage that reasons ACROSS items. The orchestrator does deterministic
// BLOCKING (group candidates by kind + normalized name; CONNECT-4); the thin agent does
// MATCHING on ONE bounded candidate set (CONNECT-5). Connect is the SOLE writer of evergreen
// `entities/` (CONNECT-3): it turns per-source CANDIDATES into born-resolved, human-named,
// deduped nodes.
//
// SCOPE (v1 resolver core): block / match / merge / dedup / born-resolved nodes + claim
// repoint on merge. Link-promotion ([[wikilinks]], CONNECT-12/13) is a DEFERRED later slice
// (a Connect re-pass after Claims). This file writes NO links block.
//
// INTEGRATION SEAM: per CANON, all stages work on the `staging` branch and a promotion gate
// advances `main`. The staging retarget (SPEC-0021) realizes this by running every stage on the
// persistent `staging` worktree — which is checked out ON `staging` (stagingWorktree.ts). Connect
// bases its worktree on the resolved base branch (`BASE_BRANCH` override, else the vault's CURRENT
// branch), so when pipeline.ts hands it the staging worktree the current branch IS `staging` and
// Connect targets it with NO override needed — exactly like Decompose/Claims, which hardcode
// nothing. `BASE_BRANCH` therefore stays `null` (see its doc below). pipeline.ts registers
// ConnectStage on the staging worktree.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import simpleGit from 'simple-git';
import { ulid, dateShard, isUlid } from './ulid';
import { ensureGitIdentity } from './vault';
import { validCandidate, blockKey, normalizeName, type Candidate } from './connect';
import {
  renderEntityNode,
  parseEntityNode,
  entityFileRel,
  unionOrdered,
  applyLinksBlock,
  type EntityNode,
  type NodeLink,
  type ParsedNode,
} from './connectDoc';
import { mergeNodes } from './mergeNodes';
import { applyClaimDedup, type DedupReport } from './claimDedup';
import { typeTag, normalizeTag } from './metaVocab';
import { makeConnectDecider, type ConnectDecider, type CandidateSet, type ExistingNodeRef } from './connectAgent';
import { reviewRel, writeReviewFile, readAllReviews } from './reviewStore';
import type { Review, ReviewSubjectCandidate } from './reviews';
import { Mutex } from './stageLock';
import { epochScopedLines } from './replayEpoch';
import { advanceOrCollide, boundedGit, canonicalHead, DEFAULT_MAX_COLLISION_RETRIES, withConcurrentAdvance, type PrepareContext } from './canonicalAdvance';
import { noopDevLog, type DevLog } from './devlog';
import { noopTracer, noopActiveSpan, STAGE_RUN_OP, type Tracer, type ActiveSpan } from './tracing';

/**
 * The branch Connect's worktree is based on and fast-forwards into.
 *
 * `null` (the v1 default) means "the vault's CURRENT branch" — resolved at runtime via
 * `rev-parse --abbrev-ref HEAD`, exactly as decomposeStage/claimsStage do. This is correct on
 * any vault regardless of its default branch name (`main`, `master`, a CI PR ref, …) — the
 * earlier hardcoded `'main'` broke on vaults whose branch wasn't literally `main`.
 *
 * The CANON staging retarget (SPEC-0019 / SPEC-0021) does NOT need to flip this: it runs every
 * stage on the persistent `staging` worktree (checked out on `staging`), so the current-branch
 * default already resolves to `staging` and Connect's ff-advance moves `staging`; the promotion
 * gate then advances `main`. Hardcoding `'staging'` here would be both redundant and wrong — it
 * would break on any vault without a literal `staging` branch (e.g. the connectStage unit tests),
 * the same hardcoded-branch hazard the `null` default was introduced to fix.
 */
export const BASE_BRANCH: string | null = null;

/** Resolve the base branch: the explicit override, else the vault's current branch. */
async function resolveBaseBranch(git: ReturnType<typeof simpleGit>): Promise<string> {
  if (BASE_BRANCH) return BASE_BRANCH;
  return (await git.raw('rev-parse', '--abbrev-ref', 'HEAD')).trim();
}

const WORKTREE_REL = path.join('.kb', 'cache', 'worktrees', 'connect');
const WORK_BRANCH = 'kb/connect-work';
const STAGE = 'connect';
/** Append-only stage audit (working zone; keyed by blockKey). The review resume path points here. */
const AUDIT_REL = path.join('connect', 'audit.jsonl');
/** Default attempts before a poison block is set aside (CONNECT-14). */
export const DEFAULT_MAX_ATTEMPTS = 3;
/** Default review rounds (parks) on one block before it is set aside (REVIEW-8 cascade cap). */
export const DEFAULT_MAX_REVIEW_ROUNDS = 3;
/** In-pass retries for a link write that hits the bounded-git BLOCK TIMEOUT under bulk-writer
 *  contention (CONNECT-12). A transient timeout must be retried, not silently dropped — else the
 *  entity is left permanently unlinked. The lock is released between attempts so contention eases. */
export const LINK_WRITE_MAX_ATTEMPTS = 3;

// Terminal block markers (the block leaves the active queue). `setaside` is poison/recoverable
// (CONNECT-14); `dismissed` is user-retired (OBS-17, never re-queued). Resolution itself is recorded
// by candidate deletion, not a marker. A `reopened` marker (OBS-17 retry) supersedes a prior terminal.
const TERMINAL_EVENTS = new Set(['setaside', 'dismissed']);
/** Which terminal marker a block reached (OBS-17): `setaside` is recoverable, `dismissed` is not. */
export type ConnectTerminalReason = 'setaside' | 'dismissed';

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve a candidate's `sourceId` to the repo-relative SOURCE DIR the archivist wrote it to
 * (`sources/<dateShard(id)>/<id>`, orchestrator.ts). A candidate carries only the source's ULID
 * (the frozen Candidate contract), but the node's `derivedFrom` must be a source-DIR path so the
 * downstream Claims stage can read the whole source from it (CLAIMS-5; `claimsOne` does
 * `path.join(root, derivedFrom)`). The layout is deterministic, so no directory walk is needed. A
 * non-ULID `sourceId` (only ever in unit fixtures) is passed through unchanged.
 */
function sourceDirRel(sourceId: string): string {
  return isUlid(sourceId) ? path.join('sources', dateShard(sourceId), sourceId) : sourceId;
}

// ── Reading the working zone: candidates + existing nodes ──────────────────────────────────

/** Walk `candidates/` and return every well-formed candidate (skips malformed files). */
export async function readCandidates(root: string): Promise<Candidate[]> {
  root = path.resolve(root);
  const out: Candidate[] = [];
  async function walk(dir: string): Promise<void> {
    let entries: import('node:fs').Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory() && !e.name.startsWith('.')) await walk(full);
      else if (e.isFile() && e.name.endsWith('.json')) {
        try {
          out.push(validCandidate(JSON.parse(await fs.readFile(full, 'utf8'))));
        } catch {
          /* malformed candidate — skip (not our well-formed unit) */
        }
      }
    }
  }
  await walk(path.join(root, 'candidates'));
  return out;
}

/** A located existing entity node: its parsed identity + repo-relative file path. */
export interface LocatedNode extends ParsedNode {
  rel: string;
}

/** Walk `entities/` and return every well-formed node with its repo-relative path. */
export async function readEntityNodes(root: string): Promise<LocatedNode[]> {
  root = path.resolve(root);
  const out: LocatedNode[] = [];
  async function walk(dir: string): Promise<void> {
    let entries: import('node:fs').Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory() && !e.name.startsWith('.')) await walk(full);
      else if (e.isFile() && e.name.endsWith('.md')) {
        try {
          const parsed = parseEntityNode(await fs.readFile(full, 'utf8'));
          out.push({ ...parsed, rel: path.relative(root, full) });
        } catch {
          /* foreign / malformed node — skip */
        }
      }
    }
  }
  await walk(path.join(root, 'entities'));
  return out;
}

// ── Per-block state (from the stage audit; keyed by blockKey) ──────────────────────────────

interface AuditLine {
  stage?: string;
  event?: string;
  blockKey?: string;
  reviewIds?: string[];
  reviewId?: string;
}

export interface ConnectState {
  terminal: boolean; // set aside / dismissed — leaves the queue for good
  terminalReason?: ConnectTerminalReason; // which terminal marker (OBS-17: setaside is recoverable)
  failures: number;
  parked: boolean; // an open awaiting-review whose reviews aren't all answered (REVIEW-5)
  rounds: number;
}

async function readConnectState(root: string, key: string): Promise<ConnectState> {
  let raw: string;
  try {
    raw = await fs.readFile(path.join(root, AUDIT_REL), 'utf8');
  } catch {
    return { terminal: false, failures: 0, parked: false, rounds: 0 };
  }
  let terminal = false;
  let terminalReason: ConnectTerminalReason | undefined;
  let failures = 0;
  let rounds = 0;
  let parkRounds: string[][] = [];
  let answered = new Set<string>();
  // Scope to the current replay epoch (REPLAY-6): a replayed block's prior terminal/park markers
  // are ignored so the (re-emitted) candidates re-resolve through the unmodified pipeline (REPLAY-14).
  for (const line of epochScopedLines(raw)) {
    if (line.trim().length === 0) continue;
    let o: AuditLine;
    try {
      o = JSON.parse(line) as AuditLine;
    } catch {
      continue;
    }
    if (o.stage !== STAGE || o.blockKey !== key) continue;
    if (o.event === 'reopened') {
      // OBS-17 (user retry): a per-block `reopened` marker supersedes ALL prior state for THIS block
      // (terminal/failures/park) so it re-enters the queue and re-resolves on the next sweep.
      terminal = false;
      terminalReason = undefined;
      failures = 0;
      rounds = 0;
      parkRounds = [];
      answered = new Set<string>();
    } else if (o.event && TERMINAL_EVENTS.has(o.event)) {
      terminal = true;
      terminalReason = o.event as ConnectTerminalReason;
    } else if (o.event === 'failed') failures += 1;
    else if (o.event === 'awaiting-review') {
      rounds += 1;
      parkRounds.push(o.reviewIds ?? []);
    } else if (o.event === 'review-answered' && o.reviewId) answered.add(o.reviewId);
  }
  const parked = !terminal && parkRounds.some((ids) => ids.some((id) => !answered.has(id)));
  return { terminal, terminalReason, failures, parked, rounds };
}

// ── Blocking (deterministic; CONNECT-4) ────────────────────────────────────────────────────

/**
 * Group the working zone into candidate sets by block key (kind + normalized name), pulling
 * existing same-key nodes in for fold/merge. Returns only sets that are still actionable
 * (not terminal, not parked, under the failure cap) and that contain ≥1 candidate. Sorted by
 * block key for deterministic drains.
 */
export async function readConnectQueue(root: string, maxAttempts = DEFAULT_MAX_ATTEMPTS): Promise<CandidateSet[]> {
  root = path.resolve(root);
  const candidates = await readCandidates(root);
  const nodes = await readEntityNodes(root);

  const byKey = new Map<string, CandidateSet>();
  for (const c of candidates) {
    const key = blockKey(c.kind, c.name);
    let set = byKey.get(key);
    if (!set) {
      set = { blockKey: key, kind: c.kind, candidates: [], existingNodes: [] };
      byKey.set(key, set);
    }
    set.candidates.push(c);
  }
  for (const n of nodes) {
    const key = blockKey(n.kind, n.name);
    const set = byKey.get(key); // only attach to blocks that have candidates to resolve
    if (set) set.existingNodes.push({ id: n.id, name: n.name });
  }

  const queued: CandidateSet[] = [];
  for (const set of byKey.values()) {
    const st = await readConnectState(root, set.blockKey);
    if (st.terminal || st.parked || st.failures >= maxAttempts) continue;
    set.candidates.sort((a, b) => (a.id < b.id ? -1 : 1));
    queued.push(set);
  }
  return queued.sort((a, b) => (a.blockKey < b.blockKey ? -1 : 1));
}

// ── Set-aside recovery (OBS-17, Connect half — mirrors claimsStage CLAIMS-20) ────────────────

/** One recoverable set-aside Connect block for the Status-view recovery panel (OBS-17). The handle
 *  is the **blockKey** — a set-aside block has NO entity node (it failed to resolve; its candidates
 *  remain). `name` is a representative human label from the block's candidates/nodes. */
export interface ConnectSetAsideItem {
  blockKey: string;
  kind: string;
  name: string;
  failures: number; // failed attempts recorded before set-aside
  rounds: number; // review-park rounds (REVIEW-8), if set aside on the review-cascade cap
}

/**
 * OBS-17 (Connect half) — the recoverable set-aside list: every candidate block whose CURRENT
 * connect state is terminal via `setaside` (NOT a user-`dismissed` block, NOT a resolved one).
 * Mirrors {@link listSetAsideItems} for claims; reads through {@link readConnectState} so it honors
 * retries/dismisses/replay-epochs with no parallel logic. The Status view offers retry/dismiss on each.
 */
export async function listConnectSetAsideItems(root: string): Promise<ConnectSetAsideItem[]> {
  root = path.resolve(root);
  const candidates = await readCandidates(root);
  const nodes = await readEntityNodes(root);
  const byKey = new Map<string, { kind: string; name: string }>();
  for (const c of candidates) {
    const key = blockKey(c.kind, c.name);
    if (!byKey.has(key)) byKey.set(key, { kind: c.kind, name: c.name }); // first candidate's spelling as the label
  }
  for (const n of nodes) {
    const key = blockKey(n.kind, n.name);
    if (!byKey.has(key)) byKey.set(key, { kind: n.kind, name: n.name });
  }
  const out: ConnectSetAsideItem[] = [];
  for (const [key, meta] of byKey) {
    const st = await readConnectState(root, key);
    if (st.terminal && st.terminalReason === 'setaside') {
      out.push({ blockKey: key, kind: meta.kind, name: meta.name, failures: st.failures, rounds: st.rounds });
    }
  }
  return out.sort((a, b) => (a.blockKey < b.blockKey ? -1 : 1));
}

/**
 * Append ONE per-block audit event to `connect/audit.jsonl` and commit it under the canonical-writer
 * lock via the shared optimistic-advance machinery (ORCH-17/18) — shared by the OBS-17 recovery
 * primitives. A rare same-path collision retries; exhaustion throws (a manual, one-at-a-time recovery
 * action shouldn't exhaust — surface it rather than silently drop).
 */
async function appendConnectAudit(
  root: string,
  key: string,
  fields: Record<string, unknown>,
  commitMessage: (key: string) => string,
  lock: Mutex,
): Promise<void> {
  root = path.resolve(root);
  const prepare = async ({ wt }: PrepareContext): Promise<boolean> => {
    const auditPath = path.join(wt, AUDIT_REL);
    await fs.mkdir(path.dirname(auditPath), { recursive: true });
    await fs.appendFile(auditPath, auditLine({ runId: ulid(), blockKey: key, ...fields }), 'utf8');
    const wtGit = simpleGit(wt);
    await wtGit.raw('add', '-A');
    await wtGit.commit(commitMessage(key));
    return true;
  };
  const onExhausted = async (): Promise<void> => {
    throw new Error(`connect recovery: could not advance ${String(fields.event)} for ${key} — canonical too contended`);
  };
  await withConcurrentAdvance({ root, lock, stage: STAGE }, prepare, onExhausted);
}

/**
 * OBS-17 — user-driven **retry** of a set-aside Connect block. Appends a per-block `reopened` marker
 * that supersedes the prior `setaside`/`failed` count (see {@link readConnectState}), so the block
 * re-enters the queue and re-resolves on the next sweep. Idempotent-safe in the read-outside/act-
 * under-lock window: re-appending `reopened` is harmless, and a since-recovered block's marker is inert.
 */
export async function retryConnectItem(root: string, key: string, lock: Mutex = new Mutex(), log: DevLog = noopDevLog): Promise<void> {
  await appendConnectAudit(root, key, { event: 'reopened' }, (k) => `connect: reopened ${k} (retry)`, lock);
  log.info('connect.reopened', { itemId: key });
}

/**
 * OBS-17 — user-driven **dismiss** of a set-aside Connect block. Appends a TERMINAL `dismissed`
 * marker: the block leaves the recoverable list permanently and is never retried or re-resolved —
 * distinct from `setaside`, which stays recoverable.
 */
export async function dismissConnectItem(root: string, key: string, lock: Mutex = new Mutex(), log: DevLog = noopDevLog): Promise<void> {
  await appendConnectAudit(root, key, { event: 'dismissed' }, (k) => `connect: dismissed ${k}`, lock);
  log.info('connect.dismissed', { itemId: key });
}

// ── Worktree + audit helpers (mirror decomposeStage/claimsStage) ───────────────────────────

async function ensureWorktree(root: string): Promise<{ wt: string; base: string }> {
  const git = simpleGit(root);
  await ensureGitIdentity(git);
  const base = await resolveBaseBranch(git);
  const wt = path.join(root, WORKTREE_REL);
  try {
    await git.raw('worktree', 'prune');
  } catch {
    /* none yet */
  }
  const healthy =
    (await pathExists(wt)) &&
    (await simpleGit(wt)
      .revparse(['--is-inside-work-tree'])
      .then(() => true)
      .catch(() => false));
  if (!healthy) {
    if (await pathExists(wt)) await fs.rm(wt, { recursive: true, force: true });
    await fs.mkdir(path.dirname(wt), { recursive: true });
    await git.raw('worktree', 'add', '-B', WORK_BRANCH, wt, base);
  }
  return { wt, base };
}

/** The rigid audit envelope (SPEC-0020 §3.9) — orchestrator-owned fields wrap freeform payloads. */
function auditLine(fields: Record<string, unknown>): string {
  return JSON.stringify({ ts: new Date().toISOString(), stage: STAGE, ...fields }) + '\n';
}

async function appendAudit(wt: string, text: string): Promise<void> {
  const file = path.join(wt, AUDIT_REL);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.appendFile(file, text, 'utf8');
}

// ── Claim repoint (CONNECT-11): point a loser node's claims at the canonical node ──────────

/** Minimal claim view for repointing + regenerating the canonical node's claims block, plus the
 *  soft `relatesTo` hints Connect promotes into links (CONNECT-12). */
interface ClaimRef {
  rel: string; // repo-relative claim file path
  subject: string; // current subject (entity rel path)
  statement: string;
  status: string;
  confidence: number;
  relatesTo: string[]; // unresolved target-name hints Claims left for Connect (CLAIMS-10)
}

function parseClaim(md: string, rel: string): ClaimRef | null {
  const fmEnd = md.indexOf('\n---', 3);
  if (fmEnd === -1) return null;
  const fm = md.slice(0, fmEnd);
  const body = md.slice(fmEnd + 4).trim();
  let subject = '';
  let status = '';
  let confidence = 0;
  let relatesTo: string[] = [];
  for (const line of fm.split('\n')) {
    let m: RegExpMatchArray | null;
    if ((m = line.match(/^subject:\s*(.+)$/))) subject = m[1].trim().replace(/^"|"$/g, '');
    else if ((m = line.match(/^status:\s*(.+)$/))) status = m[1].trim();
    else if ((m = line.match(/^confidence:\s*(.+)$/))) confidence = Number(m[1].trim()) || 0;
    else if ((m = line.match(/^relatesTo:\s*(\[.*\])\s*$/))) {
      try {
        const arr = JSON.parse(m[1]) as unknown[];
        if (Array.isArray(arr)) relatesTo = arr.map(String).filter((s) => s.trim().length > 0);
      } catch {
        /* malformed hint list — ignore (links are best-effort, never a dangling guess) */
      }
    }
  }
  if (!subject) return null;
  // Statement = the body's FIRST line. A claim body may carry a trailing "Source: [[…]]" citation
  // (VAULT-13) that is provenance, not the assertion — exclude it so merge-regenerated claims
  // blocks show the statement, not the citation. (Statements are always single-line `oneLine`.)
  const statement = body.split('\n', 1)[0]?.trim() ?? '';
  return { rel, subject, statement, status, confidence, relatesTo };
}

async function readClaims(wtRoot: string): Promise<ClaimRef[]> {
  const out: ClaimRef[] = [];
  async function walk(dir: string): Promise<void> {
    let entries: import('node:fs').Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory() && !e.name.startsWith('.')) await walk(full);
      else if (e.isFile() && e.name.endsWith('.md')) {
        const c = parseClaim(await fs.readFile(full, 'utf8'), path.relative(wtRoot, full));
        if (c) out.push(c);
      }
    }
  }
  await walk(path.join(wtRoot, 'claims'));
  return out;
}

// Claim repoint + canonical claims-block regeneration on merge now live in the shared `mergeNodes`
// core (./mergeNodes) — one impl for Connect's resolve-time merge AND Reflect's approved
// consolidation (SPEC-0024 REFLECT-7). `readClaims`/`parseClaim` above stay here because the
// link-promotion pass (linkOne/readLinkQueue) needs the `relatesTo` hints they parse, which the
// merge core doesn't carry.

// ── Resolve ONE block ──────────────────────────────────────────────────────────────────────

export interface ConnectOneResult {
  blockKey: string;
  ok: boolean;
  nodeRels: string[]; // canonical node files written/updated
  deletedNodeRels: string[]; // loser node files deleted on merge
  setAside: boolean;
  parked?: boolean;
}

/**
 * Resolve ONE candidate set under optimistic concurrency (SPEC-0014 ORCH-17/18/19). Cognition +
 * the node/candidate/audit writes happen OFF the lock, synced to the canonical checkpoint; only the
 * ff-advance runs under `lock`. As the SOLE writer of `entities/` (and an editor of nodes Claims
 * also touches), Connect can same-path-collide — the advance then re-syncs and retries the whole
 * block against the fresh canonical, bounded → set aside (ORCH-19). Uses an inline bounded retry
 * (recursion via `collisionAttempt`) rather than the shared `withOptimisticAdvance` wrapper because
 * the resolve body is large; the semantics are identical. `lock` defaults to a private mutex so a
 * standalone call (tests) still serializes its own advance; the stage passes the shared lock.
 */
export async function connectOne(
  root: string,
  key: string,
  decider: ConnectDecider,
  lock: Mutex = new Mutex(),
  maxAttempts = DEFAULT_MAX_ATTEMPTS,
  maxReviewRounds = DEFAULT_MAX_REVIEW_ROUNDS,
  collisionAttempt = 0,
  log: DevLog = noopDevLog,
  span: ActiveSpan = noopActiveSpan,
): Promise<ConnectOneResult> {
  root = path.resolve(root);
  const checkpoint = await canonicalHead(root); // the canonical commit this block prepares off
  const { wt } = await ensureWorktree(root);
  const wtGit = simpleGit(wt);
  await wtGit.raw('reset', '--hard', checkpoint); // sync to the canonical checkpoint (OFF the lock)
  await wtGit.raw('clean', '-fd', 'candidates', 'entities'); // drop stray files from a prior aborted run

  const runId = ulid();

  // Advance the prepared work-branch commit onto the canonical UNDER the lock (ORCH-18): ff when the
  // canonical is unchanged, cherry-pick replay when it moved with disjoint paths. On a same-path
  // collision, re-sync + retry the whole block (recursion) up to K, then set aside (ORCH-19).
  const advance = async (onSuccess: ConnectOneResult): Promise<ConnectOneResult> => {
    const outcome = await lock.run(() => advanceOrCollide(root, WORK_BRANCH, checkpoint), 'connect:advance');
    if (outcome === 'advanced') return onSuccess;
    if (collisionAttempt < DEFAULT_MAX_COLLISION_RETRIES) {
      return connectOne(root, key, decider, lock, maxAttempts, maxReviewRounds, collisionAttempt + 1, log, span);
    }
    // Persist the set-aside, retrying its OWN advance against a fresh checkpoint — the marker is a
    // disjoint connect-audit append, so this converges. Never silently drop the set-aside (QA #45):
    // if it somehow can't land, surface it rather than return a setAside we failed to commit.
    for (let i = 0; i <= DEFAULT_MAX_COLLISION_RETRIES; i++) {
      const cp = await canonicalHead(root);
      await wtGit.raw('reset', '--hard', cp);
      await wtGit.raw('clean', '-fd', 'candidates', 'entities');
      await appendAudit(wt, auditLine({ runId, blockKey: key, event: 'setaside', reason: 'collision-exhausted' }));
      await wtGit.raw('add', '-A');
      await wtGit.commit(`connect: set aside ${key} (collision-exhausted)`);
      if ((await lock.run(() => advanceOrCollide(root, WORK_BRANCH, cp), 'connect:advance-retry')) === 'advanced') {
        log.warn('connect.setaside', { runId, itemId: key, reason: 'collision-exhausted' });
        return { blockKey: key, ok: false, nodeRels: [], deletedNodeRels: [], setAside: true };
      }
    }
    throw new Error(`connect: could not persist collision-exhausted set-aside for ${key}`);
  };

  // Re-derive the set INSIDE the worktree (authoritative view at this commit).
  const allCandidates = await readCandidates(wt);
  const setCandidates = allCandidates.filter((c) => blockKey(c.kind, c.name) === key).sort((a, b) => (a.id < b.id ? -1 : 1));
  const nodes = await readEntityNodes(wt);
  const sameKeyNodes = nodes.filter((n) => blockKey(n.kind, n.name) === key);
  const kind = setCandidates[0]?.kind ?? sameKeyNodes[0]?.kind ?? key.split('|')[0];

  if (setCandidates.length === 0) {
    return { blockKey: key, ok: true, nodeRels: [], deletedNodeRels: [], setAside: false }; // nothing to do
  }

  try {
    const set: CandidateSet = {
      blockKey: key,
      kind,
      candidates: setCandidates,
      existingNodes: sameKeyNodes.map((n): ExistingNodeRef => ({ id: n.id, name: n.name })),
    };
    const decision = await decider(set, { span });
    const model = decision.agent?.model ?? 'default';
    const nodeById = new Map(nodes.map((n) => [n.id, n] as const));
    const candidateById = new Map(setCandidates.map((c) => [c.id, c] as const));

    // REVIEW-5 / CONNECT-15: if the agent raised reviews, PARK the whole block — apply NO
    // resolution until answered. Cascade cap (REVIEW-8): too many parks → set aside.
    if (decision.reviews && decision.reviews.length > 0) {
      const prior = await readConnectState(wt, key);
      let audit = auditLine({ runId, blockKey: key, model, event: 'start' });
      if (prior.rounds >= maxReviewRounds) {
        audit += auditLine({ runId, blockKey: key, event: 'setaside', reason: 'review-cascade-cap', rounds: prior.rounds });
        await appendAudit(wt, audit);
        await wtGit.raw('add', '-A');
        await wtGit.commit(`connect: set aside ${key} (review cascade cap)`);
        log.warn('connect.setaside', { runId, itemId: key, reason: 'review-cascade-cap', rounds: prior.rounds });
        return advance({ blockKey: key, ok: false, nodeRels: [], deletedNodeRels: [], setAside: true });
      }
      const createdAt = new Date().toISOString();
      const reviewIds: string[] = [];
      for (const req of decision.reviews) {
        const id = ulid();
        // REVIEW-16: enrich the agent's per-candidate glosses into decision-grade subject context —
        // join each {id, gloss} to its candidate's name + source-dir rel (the working Obsidian link).
        // Unknown ids (an agent naming a candidate outside its set) are dropped, never surfaced as a
        // bare ULID-as-name. The agent authors the gloss; the stage owns the name + deterministic path.
        const subjectCandidates = (req.candidates ?? [])
          .map((rc): ReviewSubjectCandidate | null => {
            const cand = candidateById.get(rc.id);
            return cand ? { name: cand.name, gloss: rc.gloss, sourceRel: sourceDirRel(cand.sourceId) } : null;
          })
          .filter((c): c is ReviewSubjectCandidate => c !== null);
        const review: Review = {
          id,
          status: 'open',
          question: req.question,
          detail: req.detail,
          raisedBy: { stage: STAGE, runId, item: { kind: 'block', ref: key }, auditRel: AUDIT_REL, markerKey: { blockKey: key } },
          subject: {
            ...(req.refs ? { refs: req.refs } : {}),
            ...(subjectCandidates.length > 0 ? { candidates: subjectCandidates } : {}),
          },
          createdAt,
        };
        await writeReviewFile(path.join(wt, reviewRel(id)), review);
        reviewIds.push(id);
        audit += auditLine({ runId, blockKey: key, model, event: 'review-raised', reviewId: id, question: req.question });
      }
      audit += auditLine({ runId, blockKey: key, event: 'awaiting-review', reviewIds, round: prior.rounds + 1 });
      await appendAudit(wt, audit);
      await wtGit.raw('add', '-A');
      await wtGit.commit(`connect: parked ${key} for review (${reviewIds.length})`);
      return advance({ blockKey: key, ok: true, nodeRels: [], deletedNodeRels: [], setAside: false, parked: true });
    }

    const now = new Date().toISOString();
    const takenRels = new Set(nodes.map((n) => n.rel));
    const nodeRels: string[] = [];
    const deletedNodeRels: string[] = [];
    const consumedCandidateIds: string[] = [];
    let audit = auditLine({ runId, blockKey: key, model, event: 'start' });

    for (const cluster of decision.clusters) {
      const members = cluster.memberCandidateIds.map((id) => candidateById.get(id)).filter((c): c is Candidate => !!c);
      const memberSources = members.map((m) => sourceDirRel(m.sourceId)); // source-DIR paths (CLAIMS-5)
      consumedCandidateIds.push(...members.map((m) => m.id));

      // Merge targets: the fold-into node + any explicit merge-existing nodes (CONNECT-9/10).
      const mergeIds = unionOrdered(cluster.existingNodeId ? [cluster.existingNodeId] : [], cluster.mergeExistingNodeIds ?? []);
      const mergeTargets = mergeIds.map((id) => nodeById.get(id)).filter((n): n is LocatedNode => !!n);
      // Canonical = the fold-into node if given & present, else the oldest (smallest id) merge node, else new.
      const canonical: LocatedNode | undefined =
        (cluster.existingNodeId ? nodeById.get(cluster.existingNodeId) : undefined) ??
        [...mergeTargets].sort((a, b) => (a.id < b.id ? -1 : 1))[0];
      const losers = mergeTargets.filter((n) => !canonical || n.id !== canonical.id);

      const id = canonical?.id ?? ulid();
      const node: EntityNode = {
        id,
        kind,
        name: cluster.canonicalName,
        confidence: cluster.confidence,
        aliases: unionOrdered(
          canonical?.aliases ?? [id],
          unionOrdered(
            losers.flatMap((l) => unionOrdered([l.id], l.aliases)),
            // fold prior canonical name + loser names as alias breadcrumbs (skip the new name)
            [canonical?.name ?? '', ...losers.map((l) => l.name)].filter((n) => n && n !== cluster.canonicalName),
          ),
        ),
        derivedFrom: unionOrdered(
          canonical?.derivedFrom ?? [],
          unionOrdered(losers.flatMap((l) => l.derivedFrom), memberSources),
        ),
        resolvedFrom: unionOrdered(
          canonical?.resolvedFrom ?? [],
          unionOrdered(losers.flatMap((l) => l.resolvedFrom), members.map((m) => m.id)),
        ),
        // SPEC-0025 META-2/4: the node's `tags:` = the deterministic curated core (`type/<kind>`)
        // + emergent topic tags the agent coined (normalized; META-3), folded over any prior/merged
        // tags. Regenerated WHOLE here so re-resolves/merges converge (idempotent).
        tags: unionOrdered(
          canonical?.tags ?? [],
          unionOrdered(
            losers.flatMap((l) => l.tags),
            [typeTag(kind), ...(cluster.tags ?? []).map(normalizeTag)].filter((t) => t.length > 0),
          ),
        ),
        createdAt: canonical?.createdAt || now,
        updatedAt: now,
        agent: decision.agent,
      };

      const rel = canonical?.rel ?? entityFileRel(kind, cluster.canonicalName, id, takenRels);
      takenRels.add(rel);
      const dest = path.join(wt, rel);
      await fs.mkdir(path.dirname(dest), { recursive: true });
      // Preserve any existing generated blocks (claims) on the canonical node; we only (re)write identity.
      let body = '';
      if (canonical) {
        const existing = await fs.readFile(path.join(wt, canonical.rel), 'utf8');
        const afterFm = existing.indexOf('\n---', 3);
        const bodyAfterHeading = afterFm === -1 ? '' : existing.slice(afterFm + 4).replace(/^\s*#[^\n]*\n?/, '');
        body = bodyAfterHeading.trim();
      }
      const rendered = renderEntityNode(node);
      await fs.writeFile(dest, body ? `${rendered}\n${body}\n` : rendered, 'utf8');
      nodeRels.push(rel);

      // CONNECT-10/11: repoint losers' claims to the canonical node, regenerate its claims block,
      // then delete the loser files — via the shared `mergeNodes` core (one impl, also used by
      // Reflect's approved consolidation, SPEC-0024 REFLECT-7). Losers here are located nodes that
      // exist, so `deleted` mirrors the loser set; the deletion-aware gate propagates it to `main`.
      if (losers.length > 0) {
        const { deleted } = await mergeNodes(wt, rel, losers.map((l) => l.rel));
        deletedNodeRels.push(...deleted);
      }

      audit += auditLine({
        runId,
        blockKey: key,
        model,
        event: 'resolved',
        node: rel,
        candidates: members.length,
        merged: losers.length,
        tags: node.tags, // SPEC-0025 META-10: provenance — which tags this resolve set on the node
      });
    }

    // Consume candidates: delete their files (commit-to-dequeue; CONNECT-17). Lineage survives
    // in each node's resolvedFrom + git history.
    for (const id of consumedCandidateIds) {
      const cand = candidateById.get(id);
      if (cand) await fs.rm(path.join(wt, 'candidates', dateShard(cand.id), `${cand.id}.json`), { force: true });
    }

    for (const sig of decision.signals ?? []) {
      audit += auditLine({ runId, blockKey: key, model, event: 'signal', type: sig.type, note: sig.note, refs: sig.refs });
    }
    audit += auditLine({ runId, blockKey: key, model, event: 'connected', clusters: decision.clusters.length });
    await appendAudit(wt, audit);

    await wtGit.raw('add', '-A');
    await wtGit.commit(`connect: ${key} → ${nodeRels.length} node(s)${deletedNodeRels.length ? `, merged ${deletedNodeRels.length}` : ''}`);
    return advance({ blockKey: key, ok: true, nodeRels, deletedNodeRels, setAside: false });
  } catch (err) {
    // CONNECT-14 / ORCH-12: never lose candidates. Discard partial worktree writes, record the
    // failed attempt durably; set aside after K so a poison block can't head-of-line-block.
    try {
      await wtGit.raw('reset', '--hard', checkpoint);
      await wtGit.raw('clean', '-fd');
    } catch {
      /* best-effort cleanup; the failed/setaside commit below is what matters */
    }
    const error = err instanceof Error ? err.message : String(err);
    const attempt = (await readConnectState(wt, key)).failures + 1;
    const setAside = attempt >= maxAttempts;
    let audit = auditLine({ runId, blockKey: key, event: 'failed', attempt, error });
    if (setAside) audit += auditLine({ runId, blockKey: key, event: 'setaside', attempts: attempt });
    await appendAudit(wt, audit);
    // OBS-4: verbose cause for the structured failed/setaside audit, cross-linked by runId (OBS-3).
    log.error('connect.failed', { runId, itemId: key, attempt, setAside, err });
    await wtGit.raw('add', '-A');
    await wtGit.commit(`connect: failed ${key} (attempt ${attempt}${setAside ? ', set aside' : ''})`);
    return advance({ blockKey: key, ok: false, nodeRels: [], deletedNodeRels: [], setAside });
  }
}

// ── Link promotion (CONNECT-12/13): relatesTo hints → real Obsidian [[wikilinks]] ───────────

export interface LinkOneResult {
  nodeRel: string;
  changed: boolean; // false when the node was byte-identical AND no review was raised (idempotent no-op)
  links: number; // resolved [[wikilink]]s rendered
  unresolved: string[]; // hints left as `note` signals: zero-match unknowns + reject-declined ambiguities (CONNECT-13)
  reviewsRaised: number; // ambiguous (>1 match) hints escalated to a yes/no Review this pass (CONNECT-15)
}

/**
 * The link-promotion queue (CONNECT-12): canonical nodes whose claims carry ≥1 `relatesTo` hint.
 * Idempotency (no churn on already-linked nodes) is NOT enforced here — `linkOne` is a no-op when
 * the regenerated node is unchanged, so re-queuing a done node is cheap. Sorted for deterministic
 * drains. A hint whose subject points at a since-merged loser node is dropped (node must exist).
 */
export async function readLinkQueue(root: string): Promise<string[]> {
  root = path.resolve(root);
  const claims = await readClaims(root);
  const subjects = new Set<string>();
  for (const c of claims) if (c.relatesTo.length > 0) subjects.add(c.subject);
  const existing = new Set((await readEntityNodes(root)).map((n) => n.rel));
  return [...subjects].filter((rel) => existing.has(rel)).sort();
}

/**
 * Promote ONE canonical node's claims' `relatesTo` hints into a regenerated `[[wikilinks]]` block
 * (CONNECT-12). DETERMINISTIC (no agent): each hint name is resolved by normalized name to a
 * canonical node — exactly-one match → a wikilink; zero match (unknown) → a `note` signal, never a
 * dangling guess (CONNECT-13). An **ambiguous** hint (>1 same-named entity) is never guessed: it
 * escalates to a yes/no Review proposing the first match (CONNECT-15) and renders nothing until the
 * Principal answers — confirm → render that target, reject → leave a `note`. The Review's plan rides
 * in its `markerKey` ({kind:'link', nodeRel, hint, targetRel}); this pass is idempotent — it reads
 * the node's existing link-Reviews and never re-raises a hint already asked. The block is
 * regenerated WHOLE, so the node is byte-stable across re-pokes: nothing-to-do is a no-op.
 * MUST be called serialized via the shared canonical-writer lock so the base branch is steady.
 * NOTE: unlike the other stages, the link pass stays COARSE-LOCKED (whole cycle under the lock) —
 * it CONSUMES Claims' `relatesTo` output, so making it optimistic/concurrent with Claims is a
 * producer-consumer ordering concern that needs its own design (deferred slice-2 follow-up).
 */
export async function linkOne(root: string, nodeRel: string, log: DevLog = noopDevLog): Promise<LinkOneResult> {
  root = path.resolve(root);
  const { wt, base } = await ensureWorktree(root);
  const wtGit = boundedGit(wt); // #163: bounded — runs under the canonical-writer lock
  await wtGit.raw('reset', '--hard', base); // sync to the base branch HEAD
  await wtGit.raw('clean', '-fd', 'entities', 'claims'); // drop stray files from a prior aborted run

  const nodePath = path.join(wt, nodeRel);
  let nodeMd: string;
  try {
    nodeMd = await fs.readFile(nodePath, 'utf8');
  } catch {
    return { nodeRel, changed: false, links: 0, unresolved: [], reviewsRaised: 0 }; // node gone (merged away) — nothing to do
  }

  // Collect this node's claims' relatesTo hints (de-duped, order-preserved).
  const claims = await readClaims(wt);
  const hints = unionOrdered(
    [],
    claims.filter((c) => c.subject === nodeRel).flatMap((c) => c.relatesTo),
  );

  // Index every OTHER canonical node by normalized name (target resolution) + every node by rel
  // (display names + existence checks). Sort each name group so the "first match" we propose for an
  // ambiguous hint is deterministic across runs.
  const byName = new Map<string, string[]>();
  const nameByRel = new Map<string, string>();
  for (const n of await readEntityNodes(wt)) {
    nameByRel.set(n.rel, n.name);
    if (n.rel === nodeRel) continue; // never self-link
    const key = normalizeName(n.name);
    const arr = byName.get(key);
    if (arr) arr.push(n.rel);
    else byName.set(key, [n.rel]);
  }
  for (const arr of byName.values()) arr.sort();

  // CONNECT-15: this node's existing link-Reviews, keyed by hint — so an ambiguous hint already
  // asked is never re-raised, an answered one renders/declines, and an open one stays parked.
  const reviewByHint = new Map<string, Review>();
  for (const r of await readAllReviews(wt)) {
    const mk = r.raisedBy.markerKey;
    if (mk.kind === 'link' && mk.nodeRel === nodeRel && mk.hint) reviewByHint.set(mk.hint, r);
  }

  const links: NodeLink[] = [];
  const unresolved: string[] = []; // zero-match unknowns + reject-declined ambiguities → note (CONNECT-13)
  const toRaise: { hint: string; targetRel: string; candidateRels: string[] }[] = [];
  const linkedTargets = new Set<string>();
  const addLink = (rel: string): void => {
    if (!linkedTargets.has(rel)) {
      // VAULT-12: carry the target's display name so the block renders `[[path|Name]]` (the path
      // resolves collision-safe; the human sees the entity name, not the raw path).
      links.push({ targetRel: rel, name: nameByRel.get(rel) });
      linkedTargets.add(rel);
    }
  };
  for (const hint of hints) {
    const matches = byName.get(normalizeName(hint)) ?? [];
    if (matches.length === 1) {
      addLink(matches[0]);
    } else if (matches.length === 0) {
      unresolved.push(hint); // unknown target → note, never a dangling guess (CONNECT-13)
    } else {
      // Ambiguous: >1 entity shares this normalized name (e.g. two distinct "John Smith"). Never
      // guess which — escalate to a yes/no Review (CONNECT-15), resuming from any answer.
      const existing = reviewByHint.get(hint);
      if (existing?.status === 'answered') {
        const target = existing.raisedBy.markerKey.targetRel;
        if (existing.answer?.verdict === 'confirm' && target && target !== nodeRel && nameByRel.has(target)) {
          addLink(target); // Principal confirmed the proposed target (still present) → render it
        } else {
          unresolved.push(hint); // rejected, or the confirmed target has since merged away → note
        }
      } else if (existing?.status === 'open') {
        // parked — awaiting the Principal; render nothing, raise nothing
      } else {
        toRaise.push({ hint, targetRel: matches[0], candidateRels: matches }); // first encounter → ask
      }
    }
  }
  links.sort((a, b) => (a.targetRel < b.targetRel ? -1 : 1)); // deterministic block order

  const newMd = applyLinksBlock(nodeMd, links);
  const nodeChanged = newMd !== nodeMd;
  if (!nodeChanged && toRaise.length === 0) {
    return { nodeRel, changed: false, links: links.length, unresolved, reviewsRaised: 0 }; // byte-stable + nothing to ask
  }

  const runId = ulid();
  if (nodeChanged) await fs.writeFile(nodePath, newMd, 'utf8');
  let audit = auditLine({ runId, event: 'links-start', node: nodeRel });

  // Escalate each newly-ambiguous hint to a yes/no Review proposing the first match (CONNECT-15);
  // the markerKey carries the plan so a later (post-answer) link pass renders or declines it.
  for (const { hint, targetRel, candidateRels } of toRaise) {
    const id = ulid();
    const nodeName = nameByRel.get(nodeRel) ?? nodeRel;
    const targetName = nameByRel.get(targetRel) ?? targetRel;
    const candidateNames = candidateRels.map((r) => nameByRel.get(r) ?? r).join(', ');
    const review: Review = {
      id,
      status: 'open',
      question: `Should "${nodeName}" link to "${targetName}"?`,
      detail: `"${nodeName}" relates to "${hint}", which matches multiple entities: ${candidateNames}. Confirm to link it to "${targetName}" (${targetRel}); reject to leave it unlinked.`,
      raisedBy: { stage: STAGE, runId, item: { kind: 'link', ref: nodeRel }, auditRel: AUDIT_REL, markerKey: { kind: 'link', nodeRel, hint, targetRel } },
      subject: {},
      createdAt: new Date().toISOString(),
    };
    await writeReviewFile(path.join(wt, reviewRel(id)), review);
    audit += auditLine({ runId, event: 'link-review-raised', node: nodeRel, hint, target: targetRel, reviewId: id });
  }
  for (const u of unresolved) {
    audit += auditLine({ runId, event: 'signal', type: 'note', note: `unresolved link target: ${u}`, node: nodeRel });
  }
  audit += auditLine({ runId, event: 'linked', node: nodeRel, links: links.length, unresolved: unresolved.length, reviewsRaised: toRaise.length });
  await appendAudit(wt, audit);
  await wtGit.raw('add', '-A');
  await wtGit.commit(
    `connect: links ${nodeRel} → ${links.length} link(s)${toRaise.length ? `, ${toRaise.length} ambiguous→review` : ''}${unresolved.length ? `, ${unresolved.length} unresolved` : ''}`,
  );
  // Serialized canonical advance through the SAME ORCH-27 discipline every other writer uses (#256
  // second symptom): a raw `merge --ff-only` here bypassed the stale-`index.lock` self-heal +
  // sidecar guard, so a stale lock (the #256 wedge) made every link advance throw `connect.link-error`
  // — links never rendered — while decompose/connect self-healed. We're coarse-locked single-writer, so
  // head === checkpoint and advanceOrCollide takes the guarded ff path (heal-then-advance).
  const checkpoint = await canonicalHead(root);
  await advanceOrCollide(root, WORK_BRANCH, checkpoint, undefined, log);
  return { nodeRel, changed: true, links: links.length, unresolved, reviewsRaised: toRaise.length };
}

/**
 * Connect's post-Claims **within-source claim-dedup** pass (SPEC-0016 CLAIMS-19). Collapses
 * near-duplicate claims that share a source's provenance (the "same assertion restated per-entity"
 * over-extraction dogfooding surfaced) — deterministic, idempotent, grouped strictly by source so
 * cross-source claims are never merged (CLAIMS-17); the symmetric-relationship residual is left for
 * typed links (CONNECT-20) and only counted. Mirrors `linkOne`'s worktree discipline: reset to base,
 * run the pure pass on the worktree, then (only if it changed anything) commit + ff-merge the
 * canonical advance. A no-dupe vault is a byte-stable no-op. MUST be called serialized via the shared
 * canonical-writer lock. Returns the report (for the drain's audit/log) + whether it committed.
 */
export async function dedupClaimsOnce(root: string, log: DevLog = noopDevLog): Promise<DedupReport & { committed: boolean }> {
  root = path.resolve(root);
  const { wt, base } = await ensureWorktree(root);
  const wtGit = boundedGit(wt); // #163: bounded — runs under the canonical-writer lock
  await wtGit.raw('reset', '--hard', base);
  await wtGit.raw('clean', '-fd', 'entities', 'claims');

  const report = await applyClaimDedup(wt); // delete dropped claim files + regenerate affected blocks
  if (report.dropped === 0) return { ...report, committed: false }; // nothing collapsed → byte-stable no-op

  const runId = ulid();
  await appendAudit(
    wt,
    auditLine({
      runId,
      event: 'claim-dedup',
      dropped: report.dropped,
      kept: report.kept,
      affected: report.affectedSubjects.length,
      // The deferred symmetric-relationship residual → CONNECT-20 (logged, not acted on; PM ruling).
      relationalResidual: report.suspectedRelationalResidual,
    }),
  );
  await wtGit.raw('add', '-A');
  await wtGit.commit(`connect: dedup ${report.dropped} within-source duplicate claim(s)`);
  // Serialized canonical advance through the ORCH-27 discipline (heal stale `index.lock` + sidecar
  // guard), same as linkOne — a raw `merge --ff-only` here had the same #256-wedge blind spot.
  const checkpoint = await canonicalHead(root);
  await advanceOrCollide(root, WORK_BRANCH, checkpoint, undefined, log);
  return { ...report, committed: true };
}

/**
 * Owns a vault's Connect stage: a poke/sweep drain loop sharing the canonical-writer lock with
 * the other stages (SPEC-0014 §5). Restartable: re-reads the derived queue and resumes.
 */
export class ConnectStage {
  private readonly root: string;
  private readonly decider: ConnectDecider;
  private readonly lock: Mutex;
  private readonly maxAttempts: number;
  private readonly afterDrain?: () => Promise<void>;
  private readonly log: DevLog;
  private readonly tracer: Tracer;
  private sweepTimer: ReturnType<typeof setInterval> | null = null;
  private draining = false;
  private pending = false;
  private current: Promise<void> | null = null;
  private drainStartedAt: string | null = null; // when the active drain began (OBS/VIZ in-flight dwell)

  /**
   * @param afterDrain optional hook run (serialized under the shared lock) after a drain that
   *   resolved ≥1 block. The pipeline passes the promotion gate here so newly-resolved evergreen
   *   `entities/` are published `staging`→`main` (STAGING-3/11) — otherwise resolved nodes would
   *   sit on `staging`, invisible to Obsidian/`main`. Mirrors the Orchestrator's `afterDrain`.
   */
  constructor(
    root: string,
    decider: ConnectDecider = makeConnectDecider(),
    lock: Mutex = new Mutex(),
    maxAttempts: number = DEFAULT_MAX_ATTEMPTS,
    afterDrain?: () => Promise<void>,
    log: DevLog = noopDevLog,
    tracer: Tracer = noopTracer,
  ) {
    this.root = path.resolve(root);
    this.decider = decider;
    this.lock = lock;
    this.maxAttempts = maxAttempts;
    this.afterDrain = afterDrain;
    this.log = log.child({ scope: 'connect' });
    this.tracer = tracer;
  }

  start(sweepMs = 30_000): void {
    void this.poke();
    if (this.sweepTimer == null) {
      this.sweepTimer = setInterval(() => void this.poke(), sweepMs);
      this.sweepTimer.unref?.();
    }
  }

  stop(): void {
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
  }

  /** Is this stage actively draining right now? (OBS-5 per-stage `running` state.) */
  busy(): boolean {
    return this.draining;
  }

  /** When the current drain began (ISO), or null when idle (SPEC-0032 VIZ-2 in-flight dwell). */
  currentSince(): string | null {
    return this.drainStartedAt;
  }

  poke(): Promise<void> {
    this.pending = true;
    if (!this.draining) {
      this.draining = true;
      this.drainStartedAt = new Date().toISOString();
      this.current = this.runDrains();
    }
    return this.current ?? Promise.resolve();
  }

  private async runDrains(): Promise<void> {
    try {
      while (this.pending) {
        this.pending = false;
        await this.drainOnce();
      }
    } finally {
      this.draining = false;
      this.drainStartedAt = null;
      this.current = null;
    }
  }

  private async drainOnce(): Promise<void> {
    let queue = await readConnectQueue(this.root, this.maxAttempts);
    let worked = false;
    while (queue.length > 0) {
      const key = queue[0].blockKey;
      const span = this.tracer.start(STAGE_RUN_OP, { stage: STAGE, itemId: key });
      try {
        // ORCH-17/18: connectOne prepares OFF the lock and advances UNDER it (shared lock passed in).
        // (The link-promotion pass below stays coarse-locked for slice 1 — narrowing it is a follow-up.)
        // OBS-12: the `stage.run` span wraps the decider's `copilot.invoke` child (incl. collision re-runs).
        const r = await connectOne(this.root, key, this.decider, this.lock, this.maxAttempts, DEFAULT_MAX_REVIEW_ROUNDS, 0, this.log, span);
        span.end(r.ok ? 'ok' : r.setAside ? 'setaside' : 'error');
        worked = true;
      } catch (err) {
        span.end('error');
        this.log.error('connect.drain-error', { itemId: key, err });
        return; // unexpected — stop this pass; a later poke/sweep retries rather than spinning
      }
      queue = await readConnectQueue(this.root, this.maxAttempts);
    }
    // Link-promotion pass (CONNECT-12): once blocks are resolved and Claims has left `relatesTo`
    // hints, promote them into `[[wikilinks]]`. Process each queued node once; `linkOne` is a
    // no-op when unchanged, so idle sweeps don't churn. Per-node failures are best-effort (a
    // later poke/sweep retries) and never abort the whole pass.
    for (const nodeRel of await readLinkQueue(this.root)) {
      // A link write that hits the bounded-git BLOCK TIMEOUT under bulk-writer contention must NOT be
      // silently dropped — that leaves the entity permanently unlinked (no `[[wikilink]]` edge) until a
      // re-derive. Retry the node a bounded number of times in-pass (the lock is released between
      // attempts, so a transient contention spike eases); on exhaustion surface it LOUDLY (`error`, not
      // a swallowed `warn`) so it's visible + reconcilable (REFLECT-3/4). The node stays in the derived
      // link queue while unlinked, so the next sweep retries it once load drops.
      for (let attempt = 1; attempt <= LINK_WRITE_MAX_ATTEMPTS; attempt++) {
        try {
          const res = await this.lock.run(() => linkOne(this.root, nodeRel, this.log), 'connect:link');
          if (res.changed) worked = true;
          break; // landed (or a byte-stable no-op) — done with this node
        } catch (err) {
          if (attempt < LINK_WRITE_MAX_ATTEMPTS) {
            this.log.warn('connect.link-retry', { itemId: nodeRel, attempt, err }); // transient (e.g. block timeout) → retry
          } else {
            this.log.error('connect.link-error', { itemId: nodeRel, attempt, err }); // exhausted; stays queued for the next sweep
          }
        }
      }
    }
    // Within-source claim dedup (CLAIMS-19): collapse the "same assertion restated per-entity"
    // over-extraction once Claims has settled. Coarse-locked like link-promotion (it sweeps all
    // claims), deterministic (no copilot slot), idempotent. A drop must promote (deletions mirror to
    // `main` via the deletion-aware gate), so set `worked` when it committed. Best-effort: a failure
    // is logged and a later poke/sweep retries — it never aborts the rest of the drain.
    try {
      const dedup = await this.lock.run(() => dedupClaimsOnce(this.root, this.log), 'connect:dedup');
      if (dedup.committed) {
        worked = true;
        this.log.info('connect.claim-dedup', {
          dropped: dedup.dropped,
          affected: dedup.affectedSubjects.length,
          relationalResidual: dedup.suspectedRelationalResidual,
        });
      }
    } catch (err) {
      this.log.warn('connect.claim-dedup-error', { err }); // best-effort; a later poke/sweep retries
    }
    // Publish the now-resolved evergreen entities (+ repointed claims + links) staging→main
    // (STAGING-3/11), serialized under the shared lock so promotion never races a stage ref
    // advance. Gated on `worked` so idle sweeps don't churn the gate; promotion is idempotent.
    if (worked && this.afterDrain) await this.lock.run(() => this.afterDrain!(), 'connect:afterDrain');
  }
}
