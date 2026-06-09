// The Compose stage runtime (SPEC-0046 COMPOSE-7) — the final Enrich stage, after Claims. The SAME
// SPEC-0014 harness as Decompose/Claims (worktree isolation, a fresh disposable session per item,
// orchestrator-owns-effects, ff-advance under the shared canonical-writer lock), pointed at a
// different work-list (ORCH-9). Work unit = an ENTITY: read its cited claims, compose grounded
// encyclopedic prose, and (re)write ONLY the entity node's prose region (COMPOSE-1..5,8).
//
// Idempotent, regenerated on claim change (COMPOSE-7): the entity's claims block has a content
// SIGNATURE; an entity is "queued for compose" iff it has claims AND its current signature has not
// yet been composed (no `composed` marker for that sig). Recomposing the SAME claims is a no-op.
// When the claims change the signature changes → it re-composes. State is the entity's append-only
// source audit (keyed by entityId, stage='compose'), exactly where Claims records — no new store.
//
// Deterministic fallback (COMPOSE-7): if the Compose agent is unavailable / errors / returns
// un-grounded prose, the attempt is recorded and the node is LEFT as the structured blocks alone
// (today's behaviour) — never a hard failure, and never fabricated/un-grounded prose. After K
// failures for a given signature the entity is set aside for that signature (it re-tries when the
// claims next change). Compose performs NO egress — it reads internal claims only (SPEC-0046 §3).
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import simpleGit from 'simple-git';
import { ulid } from './ulid';
import { CLAIMS_BLOCK_START, CLAIMS_BLOCK_END, oneLine } from './claimDoc';
import { LINKS_BLOCK_START, LINKS_BLOCK_END } from './connectDoc';
import { deriveSourceTitle } from './sourceDoc';
import { parseEntityNode, parseClaimBacklink, findEntityFiles } from './claimsStage';
import { applyProse, renderProse } from './composeDoc';
import type { CitedClaim } from './compose';
import { makeComposeDecider, type ComposeDecider, type ComposeInput } from './composeAgent';
import { Mutex } from './stageLock';
import { epochScopedLines } from './replayEpoch';
import { withConcurrentAdvance, withEphemeralWorktree, advanceOrCollide, canonicalHead, DEFAULT_STAGE_CAP, type PrepareContext } from './canonicalAdvance';
import { noopDevLog, type DevLog } from './devlog';
import { noopTracer, noopActiveSpan, STAGE_RUN_OP, type Tracer, type ActiveSpan } from './tracing';

const STAGE = 'compose';
/** Default attempts (per claims-signature) before an un-composable entity is set aside (ORCH-12). */
export const DEFAULT_MAX_ATTEMPTS = 3;

/** One parsed compose audit line we care about (keyed by entityId, scoped to a claims signature). */
interface ComposeAuditLine {
  stage?: string;
  event?: string;
  entityId?: string;
  sig?: string;
}

/** The compose state for one entity AT a given claims signature (sig-scoped so a claim change — a
 *  new sig — starts fresh, never blocked by the prior content's failures). */
export interface ComposeState {
  composed: boolean; // a `composed` marker exists for this exact signature → no re-compose needed
  failures: number; // `failed` attempts recorded for this signature
  setAside: boolean; // gave up on this signature after K failures (re-tries when claims change)
}

/** The content signature of an entity's claims (everything between the claims-block markers). A
 *  change to any claim — added/removed/edited — changes the block text → a new signature → a
 *  re-compose. Returns '' when the entity has no claims block at all. */
export function claimsBlockSig(entityMd: string): string {
  const start = entityMd.indexOf(CLAIMS_BLOCK_START);
  if (start === -1) return '';
  const endMarker = entityMd.indexOf(CLAIMS_BLOCK_END, start);
  const block = entityMd.slice(start, endMarker === -1 ? undefined : endMarker + CLAIMS_BLOCK_END.length);
  return createHash('sha256').update(block).digest('hex').slice(0, 16);
}

/** The claim-file paths an entity's claims block references (its `[[claims/…]]` wikilinks). */
function claimBlockPaths(entityMd: string): string[] {
  const start = entityMd.indexOf(CLAIMS_BLOCK_START);
  if (start === -1) return [];
  const endMarker = entityMd.indexOf(CLAIMS_BLOCK_END, start);
  const block = entityMd.slice(start, endMarker === -1 ? undefined : endMarker);
  const out: string[] = [];
  const re = /\[\[(claims\/[^\]|]+)\]\]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(block)) !== null) out.push(m[1]);
  return out;
}

/** Whether the entity actually has derived claims (a real `[[claims/…]]` row, not just the
 *  placeholder) — only such entities are worth composing. */
export function hasClaims(entityMd: string): boolean {
  return claimBlockPaths(entityMd).length > 0;
}

/** The display names of the entities this one links to (from the generated links block) — handed to
 *  the agent so it can weave `[[Name]]` cross-links into the prose (COMPOSE-4). Obsidian resolves a
 *  bare `[[Name]]` by basename, which post-COMPOSE-6 is the entity's human filename. */
export function linkedEntityNames(entityMd: string): string[] {
  const start = entityMd.indexOf(LINKS_BLOCK_START);
  if (start === -1) return [];
  const endMarker = entityMd.indexOf(LINKS_BLOCK_END, start);
  const block = entityMd.slice(start, endMarker === -1 ? undefined : endMarker);
  const out: string[] = [];
  const seen = new Set<string>();
  const re = /\[\[([^\]]+)\]\]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(block)) !== null) {
    const target = m[1];
    // `path|Name` → Name; bare `path.md` → the human basename (the filename, post-COMPOSE-6).
    const name = target.includes('|') ? target.slice(target.indexOf('|') + 1).trim() : path.basename(target.trim(), '.md');
    if (name && !seen.has(name)) {
      seen.add(name);
      out.push(name);
    }
  }
  return out;
}

/**
 * Read one entity's compose state at a given claims signature from its source's append-only
 * audit.jsonl (keyed by entityId, scoped to `sig`). A claim change yields a NEW sig, so prior
 * failures/set-asides never block the fresh content (they were about the old claims).
 */
export async function readComposeState(sourceDir: string, entityId: string, sig: string): Promise<ComposeState> {
  let raw: string;
  try {
    raw = await fs.readFile(path.join(sourceDir, 'audit.jsonl'), 'utf8');
  } catch {
    return { composed: false, failures: 0, setAside: false };
  }
  let composed = false;
  let failures = 0;
  let setAside = false;
  for (const line of epochScopedLines(raw)) {
    if (line.trim().length === 0) continue;
    let obj: ComposeAuditLine;
    try {
      obj = JSON.parse(line) as ComposeAuditLine;
    } catch {
      continue;
    }
    if (obj.stage !== STAGE || obj.entityId !== entityId || obj.sig !== sig) continue;
    if (obj.event === 'composed') composed = true;
    else if (obj.event === 'failed') failures += 1;
    else if (obj.event === 'setaside') setAside = true;
  }
  return { composed, failures, setAside };
}

/** An entity is pending compose iff it has claims AND its current claims signature hasn't been
 *  composed, isn't set aside, and hasn't exhausted its attempts. The audit home is the entity's
 *  first source (deterministic; node order). */
async function isPendingCompose(baseDir: string, entityRel: string, entityMd: string, maxAttempts: number): Promise<boolean> {
  if (!hasClaims(entityMd)) return false;
  const sig = claimsBlockSig(entityMd);
  let sources: string[];
  try {
    sources = parseEntityNode(entityMd).sources;
  } catch {
    return false;
  }
  const state = await readComposeState(path.join(baseDir, sources[0]), path.basename(entityRel, '.md'), sig);
  return !state.composed && !state.setAside && state.failures < maxAttempts;
}

/**
 * The compose work queue (COMPOSE-7): entity nodes whose current claims signature still needs prose
 * — they have claims and that signature hasn't been composed/exhausted. Repo-relative entity paths,
 * sorted by entity id so drains are deterministic.
 */
export async function readComposeQueue(root: string, maxAttempts = DEFAULT_MAX_ATTEMPTS): Promise<string[]> {
  root = path.resolve(root);
  const files = await findEntityFiles(root);
  const queued: string[] = [];
  for (const rel of files) {
    let md: string;
    try {
      md = await fs.readFile(path.join(root, rel), 'utf8');
    } catch {
      continue;
    }
    if (await isPendingCompose(root, rel, md, maxAttempts)) queued.push(rel);
  }
  return queued.sort((a, b) => (path.basename(a) < path.basename(b) ? -1 : 1));
}

/** The rigid audit envelope (SPEC-0016 §3.4 / AUDIT-1) — orchestrator-owned fields wrap the payload. */
function auditLine(fields: Record<string, unknown>): string {
  return JSON.stringify({ ts: new Date().toISOString(), stage: STAGE, ...fields }) + '\n';
}

/** Read the entity's cited claims as CitedClaim[] (statement + source dir + human source title),
 *  reading ONLY the entity's own claim files (its block's `[[claims/…]]`), then resolving each
 *  source's human title via `deriveSourceTitle` (COMPOSE-8; never a ULID). Claims whose source can't
 *  be read still contribute (titled with the neutral generic the resolver returns for absent input). */
async function readCitedClaims(wt: string, entityMd: string, entityRel: string): Promise<CitedClaim[]> {
  const paths = Array.from(new Set(claimBlockPaths(entityMd)));
  const titleCache = new Map<string, string>();
  const out: CitedClaim[] = [];
  for (const rel of paths) {
    let claimMd: string;
    try {
      claimMd = await fs.readFile(path.join(wt, rel), 'utf8');
    } catch {
      continue; // a referenced claim file is gone (e.g. dedup) — skip
    }
    const link = parseClaimBacklink(claimMd, rel, entityRel);
    if (!link || !link.source || link.statement.length === 0) continue;
    let title = titleCache.get(link.source);
    if (title === undefined) {
      let sourceMd = '';
      try {
        sourceMd = await fs.readFile(path.join(wt, link.source, 'source.md'), 'utf8');
      } catch {
        /* source.md absent — deriveSourceTitle('') returns the neutral generic, never a ULID */
      }
      title = deriveSourceTitle(sourceMd);
      titleCache.set(link.source, title);
    }
    out.push({ statement: link.statement, sourceRel: link.source, title });
  }
  // Deterministic order (replay-stable): by claim file path.
  return out.sort((a, b) => (a.sourceRel < b.sourceRel ? -1 : a.sourceRel > b.sourceRel ? 1 : 0));
}

export interface ComposeOneResult {
  entityId: string;
  ok: boolean;
  composed: boolean; // wrote prose
  setAside: boolean;
}

/**
 * Compose ONE entity under optimistic concurrency (SPEC-0014 ORCH-17/18/19). Cognition + the
 * prose write + the audit happen OFF the lock, synced to a canonical checkpoint; only the canonical
 * ff-advance runs under `lock`. Because Compose EDITS the entity node (its prose region only), it can
 * same-path-collide with a concurrent Connect/Claims rewrite of that node — the advance detects it and
 * retries against the fresh canonical, bounded → set aside (ORCH-19).
 */
export async function composeOne(
  root: string,
  entityRel: string,
  decider: ComposeDecider,
  lock: Mutex = new Mutex(),
  maxAttempts = DEFAULT_MAX_ATTEMPTS,
  log: DevLog = noopDevLog,
  span: ActiveSpan = noopActiveSpan,
): Promise<ComposeOneResult> {
  root = path.resolve(root);
  const entityId = path.basename(entityRel, '.md');
  let result: ComposeOneResult = { entityId, ok: false, composed: false, setAside: false };

  const prepare = async ({ wt, base }: PrepareContext): Promise<boolean> => {
    const wtGit = simpleGit(wt);
    const entityPathWt = path.join(wt, entityRel);
    const entityMd = await fs.readFile(entityPathWt, 'utf8');
    // Re-check pending off this fresh checkpoint — a concurrent writer may have composed it already.
    if (!(await isPendingCompose(wt, entityRel, entityMd, maxAttempts))) {
      result = { entityId, ok: true, composed: false, setAside: false };
      return false; // nothing to advance
    }
    const ref = parseEntityNode(entityMd);
    const sig = claimsBlockSig(entityMd);
    const sourceRel = ref.sources[0];
    const auditPath = path.join(wt, sourceRel, 'audit.jsonl');
    const runId = ulid();
    try {
      const cited = await readCitedClaims(wt, entityMd, entityRel);
      if (cited.length === 0) {
        // The block linked claims but none resolved (all deleted/empty) — nothing to ground prose in.
        result = { entityId, ok: true, composed: false, setAside: false };
        return false;
      }
      const input: ComposeInput = {
        entityId,
        kind: ref.kind,
        name: ref.name,
        claims: cited.map((c) => ({ statement: c.statement, title: c.title })),
        links: linkedEntityNames(entityMd),
      };
      const decision = await decider(input, { span });
      const model = decision.agent?.model ?? 'default';
      const prose = renderProse(decision, cited);
      // Write ONLY the prose region; the kb:links / kb:claims blocks stay below, untouched (COMPOSE-5).
      await fs.writeFile(entityPathWt, applyProse(entityMd, prose), 'utf8');

      let audit = auditLine({ runId, entityId, sig, model, event: 'start' });
      audit += auditLine({ runId, entityId, sig, model, event: 'composed', sections: decision.sections.length, claims: cited.length });
      await fs.mkdir(path.dirname(auditPath), { recursive: true });
      await fs.appendFile(auditPath, audit, 'utf8');

      await wtGit.raw('add', '-A');
      await wtGit.commit(`compose: ${entityId} (${decision.sections.length} section(s), ${cited.length} claim(s))`);
      result = { entityId, ok: true, composed: true, setAside: false };
      return true;
    } catch (err) {
      // Deterministic fallback (COMPOSE-7): never fabricate / write un-grounded prose. Discard any
      // partial write (the node stays blocks-only — today's behaviour), record the failed attempt,
      // and set aside (for THIS signature) after K so it can't churn forever. It re-tries when the
      // claims next change (a new sig) or copilot recovers and the sig is retried under the cap.
      await wtGit.raw('reset', '--hard', base);
      const error = err instanceof Error ? err.message : String(err);
      const prior = await readComposeState(path.join(wt, sourceRel), entityId, sig);
      const attempt = prior.failures + 1;
      const setAside = attempt >= maxAttempts;
      let audit = auditLine({ runId, entityId, sig, event: 'failed', attempt, error: oneLine(error) });
      if (setAside) audit += auditLine({ runId, entityId, sig, event: 'setaside', attempts: attempt });
      await fs.mkdir(path.dirname(auditPath), { recursive: true });
      await fs.appendFile(auditPath, audit, 'utf8');
      log.warn('compose.failed', { runId, itemId: entityId, attempt, setAside, err });
      await wtGit.raw('add', '-A');
      await wtGit.commit(`compose: failed ${entityId} (attempt ${attempt}${setAside ? ', set aside' : ''})`);
      result = { entityId, ok: false, composed: false, setAside };
      return true;
    }
  };

  // Same-path collision exhaustion (ORCH-19): set aside this entity for its current signature so it
  // can't head-of-line-block. It re-tries when the claims next change.
  const onExhausted = async (): Promise<void> => {
    const base = await canonicalHead(root);
    await withEphemeralWorktree(root, STAGE, base, async ({ wt, workBranch }) => {
      const entityMd = await fs.readFile(path.join(wt, entityRel), 'utf8');
      const ref = parseEntityNode(entityMd);
      const sig = claimsBlockSig(entityMd);
      const auditPath = path.join(wt, ref.sources[0], 'audit.jsonl');
      await fs.mkdir(path.dirname(auditPath), { recursive: true });
      await fs.appendFile(auditPath, auditLine({ runId: ulid(), entityId, sig, event: 'setaside', reason: 'collision-exhausted' }), 'utf8');
      const wtGit = simpleGit(wt);
      await wtGit.raw('add', '-A');
      await wtGit.commit(`compose: set aside ${entityId} (collision-exhausted)`);
      await lock.run(() => advanceOrCollide(root, workBranch, base), 'compose:setaside-advance');
    });
    log.warn('compose.setaside', { itemId: entityId, reason: 'collision-exhausted' });
    result = { ...result, ok: false, setAside: true };
  };

  await withConcurrentAdvance({ root, lock, stage: STAGE }, prepare, onExhausted);
  return result;
}

/**
 * Owns a vault's Compose stage: a poke/sweep drain loop sharing the canonical-writer lock with the
 * other Enrich stages (SPEC-0014 §5). Restartable: re-reads the derived queue and resumes.
 */
export class ComposeStage {
  private readonly root: string;
  private readonly decider: ComposeDecider;
  private readonly lock: Mutex;
  private readonly maxAttempts: number;
  private readonly afterDrain?: () => Promise<void>;
  private readonly cap: number;
  private readonly log: DevLog;
  private readonly tracer: Tracer;
  private sweepTimer: ReturnType<typeof setInterval> | null = null;
  private draining = false;
  private pending = false;
  private current: Promise<void> | null = null;
  private drainStartedAt: string | null = null;

  /**
   * @param afterDrain optional hook run (serialized under the shared lock) after a drain that
   *   composed ≥1 entity. The pipeline passes the promotion gate here so the entity nodes' newly
   *   (re)written prose is published `staging`→`main` (entities/ are evergreen; STAGING-3/11).
   */
  constructor(
    root: string,
    decider: ComposeDecider = makeComposeDecider(),
    lock: Mutex = new Mutex(),
    maxAttempts: number = DEFAULT_MAX_ATTEMPTS,
    afterDrain?: () => Promise<void>,
    cap: number = DEFAULT_STAGE_CAP,
    log: DevLog = noopDevLog,
    tracer: Tracer = noopTracer,
  ) {
    this.root = path.resolve(root);
    this.decider = decider;
    this.lock = lock;
    this.maxAttempts = maxAttempts;
    this.afterDrain = afterDrain;
    this.cap = cap;
    this.log = log.child({ scope: 'compose' });
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

  busy(): boolean {
    return this.draining;
  }

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
    let queue = await readComposeQueue(this.root, this.maxAttempts);
    let worked = false;
    while (queue.length > 0) {
      const batch = queue.slice(0, this.cap);
      try {
        await Promise.all(
          batch.map((entityRel) => {
            const span = this.tracer.start(STAGE_RUN_OP, { stage: STAGE, itemId: path.basename(entityRel, '.md') });
            return composeOne(this.root, entityRel, this.decider, this.lock, this.maxAttempts, this.log, span).then(
              (r) => {
                span.end(r.composed ? 'ok' : r.setAside ? 'setaside' : 'ok');
                return r;
              },
              (err) => {
                span.end('error');
                throw err;
              },
            );
          }),
        );
        worked = true;
      } catch (err) {
        this.log.error('compose.drain-error', { err });
        return;
      }
      queue = await readComposeQueue(this.root, this.maxAttempts);
    }
    if (worked && this.afterDrain) await this.lock.run(() => this.afterDrain!(), 'compose:afterDrain');
  }
}
