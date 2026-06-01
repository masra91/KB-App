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
// INTEGRATION SEAM (KB-Architect owns this): per CANON, all stages eventually work on the
// `staging` branch and a promotion gate advances `main`. Until that lands, Connect bases its
// worktree on `BASE_BRANCH` below. KB-Architect flips this ONE constant to 'staging' during
// the staging retarget; nothing else here changes. This file is NOT wired into pipeline.ts
// here — KB-Architect registers ConnectStage when the staging slices merge.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import simpleGit from 'simple-git';
import { ulid, dateShard } from './ulid';
import { ensureGitIdentity } from './vault';
import { validCandidate, blockKey, type Candidate } from './connect';
import {
  renderEntityNode,
  parseEntityNode,
  entityFileRel,
  unionOrdered,
  type EntityNode,
  type ParsedNode,
} from './connectDoc';
import { applyClaimsBlock, type ClaimBacklink } from './claimDoc';
import { makeConnectDecider, type ConnectDecider, type CandidateSet, type ExistingNodeRef } from './connectAgent';
import { reviewRel, writeReviewFile } from './reviewStore';
import type { Review } from './reviews';
import { Mutex } from './stageLock';

/**
 * The branch Connect's worktree is based on and fast-forwards into. v1 = 'main' (today's
 * single-branch reality). KB-Architect flips this to 'staging' in ONE place during the CANON
 * staging retarget (SPEC-0019 / SPEC-0021); the rest of Connect is base-ref-agnostic.
 */
export const BASE_BRANCH = 'main';

const WORKTREE_REL = path.join('.kb', 'cache', 'worktrees', 'connect');
const WORK_BRANCH = 'kb/connect-work';
const STAGE = 'connect';
/** Append-only stage audit (working zone; keyed by blockKey). The review resume path points here. */
const AUDIT_REL = path.join('connect', 'audit.jsonl');
/** Default attempts before a poison block is set aside (CONNECT-14). */
export const DEFAULT_MAX_ATTEMPTS = 3;
/** Default review rounds (parks) on one block before it is set aside (REVIEW-8 cascade cap). */
export const DEFAULT_MAX_REVIEW_ROUNDS = 3;

const TERMINAL_EVENTS = new Set(['setaside']); // resolution is recorded by candidate deletion, not a marker

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
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
  terminal: boolean; // set aside — leaves the queue for good
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
  let failures = 0;
  let rounds = 0;
  const parkRounds: string[][] = [];
  const answered = new Set<string>();
  for (const line of raw.split('\n')) {
    if (line.trim().length === 0) continue;
    let o: AuditLine;
    try {
      o = JSON.parse(line) as AuditLine;
    } catch {
      continue;
    }
    if (o.stage !== STAGE || o.blockKey !== key) continue;
    if (o.event && TERMINAL_EVENTS.has(o.event)) terminal = true;
    else if (o.event === 'failed') failures += 1;
    else if (o.event === 'awaiting-review') {
      rounds += 1;
      parkRounds.push(o.reviewIds ?? []);
    } else if (o.event === 'review-answered' && o.reviewId) answered.add(o.reviewId);
  }
  const parked = !terminal && parkRounds.some((ids) => ids.some((id) => !answered.has(id)));
  return { terminal, failures, parked, rounds };
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

// ── Worktree + audit helpers (mirror decomposeStage/claimsStage) ───────────────────────────

async function ensureWorktree(root: string): Promise<{ wt: string }> {
  const git = simpleGit(root);
  await ensureGitIdentity(git);
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
    await git.raw('worktree', 'add', '-B', WORK_BRANCH, wt, BASE_BRANCH);
  }
  return { wt };
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

/** Minimal claim view for repointing + regenerating the canonical node's claims block. */
interface ClaimRef {
  rel: string; // repo-relative claim file path
  subject: string; // current subject (entity rel path)
  statement: string;
  status: string;
  confidence: number;
}

function parseClaim(md: string, rel: string): ClaimRef | null {
  const fmEnd = md.indexOf('\n---', 3);
  if (fmEnd === -1) return null;
  const fm = md.slice(0, fmEnd);
  const body = md.slice(fmEnd + 4).trim();
  let subject = '';
  let status = '';
  let confidence = 0;
  for (const line of fm.split('\n')) {
    let m: RegExpMatchArray | null;
    if ((m = line.match(/^subject:\s*(.+)$/))) subject = m[1].trim().replace(/^"|"$/g, '');
    else if ((m = line.match(/^status:\s*(.+)$/))) status = m[1].trim();
    else if ((m = line.match(/^confidence:\s*(.+)$/))) confidence = Number(m[1].trim()) || 0;
  }
  if (!subject) return null;
  return { rel, subject, statement: body, status, confidence };
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

/** Rewrite a claim file's `subject:` line to the canonical node path (CONNECT-11). */
async function repointClaimSubject(wtRoot: string, claimRel: string, newSubject: string): Promise<void> {
  const file = path.join(wtRoot, claimRel);
  const md = await fs.readFile(file, 'utf8');
  const updated = md.replace(/^subject:\s*.+$/m, `subject: ${newSubject}`);
  await fs.writeFile(file, updated, 'utf8');
}

/** Regenerate the canonical node's claims block from all claims now pointing at it (CONNECT-11). */
async function regenClaimsBlock(wtRoot: string, nodeRel: string, claims: ClaimRef[]): Promise<void> {
  const file = path.join(wtRoot, nodeRel);
  const md = await fs.readFile(file, 'utf8');
  const links: ClaimBacklink[] = claims.map((c) => ({
    claimPath: c.rel,
    statement: c.statement,
    // ClaimBacklink.status is typed as ClaimStatus; claims come from the closed set already.
    status: c.status as ClaimBacklink['status'],
    confidence: c.confidence,
  }));
  await fs.writeFile(file, applyClaimsBlock(md, links), 'utf8');
}

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
 * Resolve ONE candidate set. MUST be called serialized via the shared canonical-writer lock
 * so the base branch does not move mid-cycle (the final ff-advance must always apply).
 */
export async function connectOne(
  root: string,
  key: string,
  decider: ConnectDecider,
  maxAttempts = DEFAULT_MAX_ATTEMPTS,
  maxReviewRounds = DEFAULT_MAX_REVIEW_ROUNDS,
): Promise<ConnectOneResult> {
  root = path.resolve(root);
  const { wt } = await ensureWorktree(root);
  const wtGit = simpleGit(wt);
  const rootGit = simpleGit(root);
  await wtGit.raw('reset', '--hard', BASE_BRANCH); // sync to the base branch HEAD
  await wtGit.raw('clean', '-fd', 'candidates', 'entities'); // drop stray files from a prior aborted run

  const runId = ulid();

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
    const decision = await decider(set);
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
        await rootGit.raw('merge', '--ff-only', WORK_BRANCH);
        return { blockKey: key, ok: false, nodeRels: [], deletedNodeRels: [], setAside: true };
      }
      const createdAt = new Date().toISOString();
      const reviewIds: string[] = [];
      for (const req of decision.reviews) {
        const id = ulid();
        const review: Review = {
          id,
          status: 'open',
          question: req.question,
          detail: req.detail,
          raisedBy: { stage: STAGE, runId, item: { kind: 'block', ref: key }, auditRel: AUDIT_REL, markerKey: { blockKey: key } },
          subject: { ...(req.refs ? { refs: req.refs } : {}) },
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
      await rootGit.raw('merge', '--ff-only', WORK_BRANCH);
      return { blockKey: key, ok: true, nodeRels: [], deletedNodeRels: [], setAside: false, parked: true };
    }

    const now = new Date().toISOString();
    const takenRels = new Set(nodes.map((n) => n.rel));
    const nodeRels: string[] = [];
    const deletedNodeRels: string[] = [];
    const consumedCandidateIds: string[] = [];
    let audit = auditLine({ runId, blockKey: key, model, event: 'start' });

    for (const cluster of decision.clusters) {
      const members = cluster.memberCandidateIds.map((id) => candidateById.get(id)).filter((c): c is Candidate => !!c);
      const memberSources = members.map((m) => m.sourceId);
      consumedCandidateIds.push(...members.map((m) => m.id));

      // Merge targets: the fold-into node + any explicit merge-existing nodes (CONNECT-9/10).
      const mergeIds = unionOrdered(cluster.existingNodeId ? [cluster.existingNodeId] : [], cluster.mergeExistingNodeIds ?? []);
      const mergeNodes = mergeIds.map((id) => nodeById.get(id)).filter((n): n is LocatedNode => !!n);
      // Canonical = the fold-into node if given & present, else the oldest (smallest id) merge node, else new.
      const canonical: LocatedNode | undefined =
        (cluster.existingNodeId ? nodeById.get(cluster.existingNodeId) : undefined) ??
        [...mergeNodes].sort((a, b) => (a.id < b.id ? -1 : 1))[0];
      const losers = mergeNodes.filter((n) => !canonical || n.id !== canonical.id);

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

      // CONNECT-10/11: repoint losers' claims to the canonical node, then delete loser files.
      if (losers.length > 0) {
        const claims = await readClaims(wt);
        const loserRels = new Set(losers.map((l) => l.rel));
        for (const claim of claims) {
          if (loserRels.has(claim.subject)) await repointClaimSubject(wt, claim.rel, rel);
        }
        const claimsForCanonical = (await readClaims(wt)).filter((c) => c.subject === rel);
        if (claimsForCanonical.length > 0) await regenClaimsBlock(wt, rel, claimsForCanonical);
        for (const loser of losers) {
          await fs.rm(path.join(wt, loser.rel), { force: true });
          deletedNodeRels.push(loser.rel);
        }
      }

      audit += auditLine({
        runId,
        blockKey: key,
        model,
        event: 'resolved',
        node: rel,
        candidates: members.length,
        merged: losers.length,
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
    await rootGit.raw('merge', '--ff-only', WORK_BRANCH); // serialized canonical advance
    return { blockKey: key, ok: true, nodeRels, deletedNodeRels, setAside: false };
  } catch (err) {
    // CONNECT-14 / ORCH-12: never lose candidates. Discard partial worktree writes, record the
    // failed attempt durably; set aside after K so a poison block can't head-of-line-block.
    try {
      await wtGit.raw('reset', '--hard', BASE_BRANCH);
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
    await wtGit.raw('add', '-A');
    await wtGit.commit(`connect: failed ${key} (attempt ${attempt}${setAside ? ', set aside' : ''})`);
    await rootGit.raw('merge', '--ff-only', WORK_BRANCH);
    return { blockKey: key, ok: false, nodeRels: [], deletedNodeRels: [], setAside };
  }
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
  private sweepTimer: ReturnType<typeof setInterval> | null = null;
  private draining = false;
  private pending = false;
  private current: Promise<void> | null = null;

  constructor(root: string, decider: ConnectDecider = makeConnectDecider(), lock: Mutex = new Mutex(), maxAttempts: number = DEFAULT_MAX_ATTEMPTS) {
    this.root = path.resolve(root);
    this.decider = decider;
    this.lock = lock;
    this.maxAttempts = maxAttempts;
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

  poke(): Promise<void> {
    this.pending = true;
    if (!this.draining) {
      this.draining = true;
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
      this.current = null;
    }
  }

  private async drainOnce(): Promise<void> {
    let queue = await readConnectQueue(this.root, this.maxAttempts);
    while (queue.length > 0) {
      const key = queue[0].blockKey;
      try {
        await this.lock.run(() => connectOne(this.root, key, this.decider, this.maxAttempts));
      } catch {
        return; // unexpected — stop this pass; a later poke/sweep retries rather than spinning
      }
      queue = await readConnectQueue(this.root, this.maxAttempts);
    }
  }
}
