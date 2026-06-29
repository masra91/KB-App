// Directives (SPEC-0050) — a first-class artifact distinct from sources. Sources are EVIDENCE
// (decomposed into candidates/claims); a directive is durable, human-given INTERPRETATION that is
// NOT decomposed — it nudges a downstream decision rather than adding ground truth. Slice 1 covers
// the DISAMBIGUATION directive (DIR-2/3/4/8): when a Principal answers a Connect "are these two the
// same entity?" review, that verdict graduates to a durable directive keyed on the STABLE block
// identity (`kind|normalizedName`, e.g. `organization|disney`) — NOT the candidate/entity ULIDs.
//
// THE BUG THIS FIXES: the legacy per-pair decision (disambiguationDecisions.ts) is keyed by entity
// ULIDs, which are reborn on every re-derive / Full Replay (entities/ is purged + rebuilt). So a
// settled "Disney is one org" verdict never re-matched the freshly-minted ULIDs and the identical
// review re-raised on every new same-name source AND after every replay (the Principal's "I keep
// answering Disney/Microsoft"). The block identity `organization|disney` is content-derived and
// therefore STABLE across re-derive + replay, so a directive keyed on it stays matched.
//
// STORAGE + DURABILITY: an append-only JSONL under `directives/` — which is EVERGREEN (promoted to
// `main`, staging.ts EVERGREEN_PATHS) and is NOT in replay's PURGE_DIRS, so a directive survives
// reset/replay (unlike the working-zone `connect/disambiguation.jsonl`). Written under the shared
// canonical-writer lock by the review-answer path (it lands in the same commit as the answer) and
// republished to `main` by the promotion gate. Last-wins per identity key, so a later opposite
// verdict revises an earlier one (PRIN-5/6 provenance kept on each record).
import { promises as fs } from 'node:fs';
import path from 'node:path';

/** Evergreen directory holding all directive artifacts (promoted to `main`, never purged). */
export const DIRECTIVES_DIR = 'directives';

/** Repo-relative path of the durable disambiguation-directive log (evergreen). */
export const DISAMBIGUATION_DIRECTIVES_REL = path.join(DIRECTIVES_DIR, 'disambiguation.jsonl');

/** Repo-relative path of the durable consolidation-directive log (evergreen). SPEC-0050 slice-2. */
export const CONSOLIDATION_DIRECTIVES_REL = path.join(DIRECTIVES_DIR, 'consolidation.jsonl');

/** Repo-relative path of the durable correction-directive log (evergreen). SPEC-0050 slice-2b. */
export const CORRECTION_DIRECTIVES_REL = path.join(DIRECTIVES_DIR, 'corrections.jsonl');

/** Repo-relative path of the durable contradiction-lifecycle log (evergreen). SPEC-0036 CONTRA. */
export const CONTRADICTION_DIRECTIVES_REL = path.join(DIRECTIVES_DIR, 'contradictions.jsonl');

/** Repo-relative path of the durable guidance-directive log (evergreen). SPEC-0050 slice-3. */
export const GUIDANCE_DIRECTIVES_REL = path.join(DIRECTIVES_DIR, 'guidance.jsonl');

/** Repo-relative path of the durable revoke-directive log (evergreen). SPEC-0050 slice-3. */
export const REVOKE_DIRECTIVES_REL = path.join(DIRECTIVES_DIR, 'revokes.jsonl');

/** Repo-relative path of the durable enrich-directive log (evergreen). SPEC-0050 slice-3c. */
export const ENRICH_DIRECTIVES_REL = path.join(DIRECTIVES_DIR, 'enrich.jsonl');

/** Repo-relative path of the durable Health-dismissal log (evergreen). SPEC-0060 VUX-16 slice-1. */
export const HEALTH_DISMISSAL_DIRECTIVES_REL = path.join(DIRECTIVES_DIR, 'health-dismissals.jsonl');

export type DirectiveVerdict = 'same' | 'distinct';

/**
 * One durable disambiguation directive. Keyed on `identityKey` — the STABLE block identity
 * (`kind|normalizedName`, the same string Connect blocks on), NOT entity ULIDs. `entities` is kept
 * for provenance/debuggability (the ULIDs decided at answer time) but is never the lookup key.
 */
export interface DisambiguationDirective {
  identityKey: string; // stable block identity, e.g. 'organization|disney' (kind|normalizeName(name))
  verdict: DirectiveVerdict; // 'same' → the same-identity mentions are one entity; 'distinct' → settled-separate
  reviewId: string; // provenance: the answered review that produced this directive (PRIN-5/6)
  decidedAt: string; // ISO; ordering for last-wins revisability
  entities?: [string, string]; // provenance only: the entity ULIDs the pair was decided on (NOT the key)
}

function directivesAbs(root: string): string {
  return path.join(path.resolve(root), DISAMBIGUATION_DIRECTIVES_REL);
}

/**
 * Read every recorded disambiguation directive into a last-wins map keyed by `identityKey` — so a
 * revised verdict (distinct→same later) supersedes the earlier one. Absent/garbled lines are
 * skipped; an absent file yields an empty map (no directives yet). Tolerant of a malformed line so
 * one bad append never blinds the whole store (ENG-16).
 */
export async function readDisambiguationDirectives(root: string): Promise<Map<string, DisambiguationDirective>> {
  let raw: string;
  try {
    raw = await fs.readFile(directivesAbs(root), 'utf8');
  } catch {
    return new Map();
  }
  const out = new Map<string, DisambiguationDirective>();
  for (const line of raw.split('\n')) {
    if (line.trim().length === 0) continue;
    let obj: Partial<DisambiguationDirective>;
    try {
      obj = JSON.parse(line) as Partial<DisambiguationDirective>;
    } catch {
      continue;
    }
    if (typeof obj.identityKey !== 'string' || obj.identityKey.length === 0) continue;
    if (obj.verdict !== 'same' && obj.verdict !== 'distinct') continue;
    // Append order is chronological; the last line for an identityKey wins (revisability).
    out.set(obj.identityKey, {
      identityKey: obj.identityKey,
      verdict: obj.verdict,
      reviewId: typeof obj.reviewId === 'string' ? obj.reviewId : '',
      decidedAt: typeof obj.decidedAt === 'string' ? obj.decidedAt : '',
      ...(Array.isArray(obj.entities) && obj.entities.length === 2
        ? { entities: [String(obj.entities[0]), String(obj.entities[1])] as [string, string] }
        : {}),
    });
  }
  return out;
}

/** The settled directive for a block identity, or undefined if that identity has never been decided. */
export function directiveForIdentity(
  directives: Map<string, DisambiguationDirective>,
  identityKey: string,
): DisambiguationDirective | undefined {
  return directives.get(identityKey);
}

/**
 * Append a durable disambiguation directive. Does NOT commit — the caller (the review-answer path)
 * is already inside the shared canonical-writer lock and stages/commits the working tree, so the
 * directive lands in the same commit as the answer (atomic, recorded at answer-time) and is then
 * promoted to `main`. Idempotent enough: re-recording the same verdict just appends a duplicate the
 * last-wins read collapses; a later opposite verdict supersedes.
 */
export async function recordDisambiguationDirective(
  root: string,
  directive: {
    identityKey: string;
    verdict: DirectiveVerdict;
    reviewId: string;
    decidedAt: string;
    entities?: [string, string];
  },
): Promise<DisambiguationDirective> {
  const rec: DisambiguationDirective = {
    identityKey: directive.identityKey,
    verdict: directive.verdict,
    reviewId: directive.reviewId,
    decidedAt: directive.decidedAt,
    ...(directive.entities ? { entities: directive.entities } : {}),
  };
  const file = directivesAbs(root);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.appendFile(file, JSON.stringify(rec) + '\n', 'utf8');
  return rec;
}

// ── Consolidation directives (SPEC-0050 slice-2: ad-hoc merge / distinct) ──────────────────────
//
// Slice 1 made the CONNECT disambiguation verdict durable (within-block "are these same-name mentions
// one entity?", keyed on a SINGLE block identity). The same rebirth bug lives in REFLECT consolidation
// (SPEC-0024): Reflect proposes merging two SEPARATE entities (`organization|disney` + `organization|
// walt disney company`) and the Principal's answer is recorded only as a per-PAIR decision keyed on the
// entity ULIDs (disambiguationDecisions.ts). Those ULIDs are reborn on every re-derive / Full Replay, so
// a settled "no, keep them separate" (or "yes, merge") goes blind and Reflect re-raises the identical
// finding every run (REFLECT-14's "same reviews every run", durable only until the next rebuild).
//
// The fix mirrors slice 1: graduate the answer to a durable directive keyed on the STABLE pair of BLOCK
// IDENTITIES (`kind|normalizedName` each), which are content-derived and therefore stable across rebirth.
// Unlike the disambiguation directive (one identity), a consolidation verdict is inherently about a PAIR
// of distinct identities, so it is keyed on an order-independent `directivePairKey`. Stored evergreen
// under `directives/consolidation.jsonl` (promoted to `main`, never purged), last-wins per pair.
//
// This is the SHARED primitive coordinated with SPEC-0051's orphan-linker: the linker MUST NOT link a
// pair the Principal settled `distinct`, so it consults `consolidationDirectiveForPair` with the same
// `directivePairKey`. One pair-key, two callers (Reflect suppression + linker link-guard).

export type ConsolidationVerdict = 'merge' | 'distinct';

/**
 * One durable consolidation directive. Keyed on `pairKey` — the order-independent stable key of the two
 * BLOCK IDENTITIES (`kind|normalizedName`), NOT entity ULIDs. `identities` keeps the (sorted) pair for
 * provenance + lookup; `verdict` is `merge` (one entity) or `distinct` (settled-separate).
 */
export interface ConsolidationDirective {
  pairKey: string; // directivePairKey(identityA, identityB) — stable across re-derive/replay
  identities: [string, string]; // the two block identities, sorted (kind|normalizedName each)
  verdict: ConsolidationVerdict; // merge → the pair is one entity; distinct → settled-separate
  reviewId: string; // provenance: the answered consolidation review (PRIN-5/6)
  decidedAt: string; // ISO; ordering for last-wins revisability
}

/**
 * Order-independent stable key for a pair of BLOCK IDENTITIES (e.g. `organization|disney` +
 * `organization|walt disney company`). Content-derived (each identity is `kind|normalizedName`), so the
 * key is stable across the ULID rebirth that defeats the entity-ULID-keyed decision store. The `::`
 * separator never occurs inside a block identity (normalizeName strips punctuation to spaces).
 */
export function directivePairKey(a: string, b: string): string {
  return (a < b ? [a, b] : [b, a]).join('::');
}

function consolidationAbs(root: string): string {
  return path.join(path.resolve(root), CONSOLIDATION_DIRECTIVES_REL);
}

/**
 * Read every recorded consolidation directive into a last-wins map keyed by `pairKey` — a revised
 * verdict (distinct→merge later) supersedes the earlier one. Absent/garbled lines are skipped; an
 * absent file yields an empty map. Tolerant of a malformed line (ENG-16).
 */
export async function readConsolidationDirectives(root: string): Promise<Map<string, ConsolidationDirective>> {
  let raw: string;
  try {
    raw = await fs.readFile(consolidationAbs(root), 'utf8');
  } catch {
    return new Map();
  }
  const out = new Map<string, ConsolidationDirective>();
  for (const line of raw.split('\n')) {
    if (line.trim().length === 0) continue;
    let obj: Partial<ConsolidationDirective>;
    try {
      obj = JSON.parse(line) as Partial<ConsolidationDirective>;
    } catch {
      continue;
    }
    if (typeof obj.pairKey !== 'string' || obj.pairKey.length === 0) continue;
    if (obj.verdict !== 'merge' && obj.verdict !== 'distinct') continue;
    if (!Array.isArray(obj.identities) || obj.identities.length !== 2) continue;
    // Append order is chronological; the last line for a pairKey wins (revisability).
    out.set(obj.pairKey, {
      pairKey: obj.pairKey,
      identities: [String(obj.identities[0]), String(obj.identities[1])],
      verdict: obj.verdict,
      reviewId: typeof obj.reviewId === 'string' ? obj.reviewId : '',
      decidedAt: typeof obj.decidedAt === 'string' ? obj.decidedAt : '',
    });
  }
  return out;
}

/** The settled directive for a pair of block identities, or undefined if never decided. */
export function consolidationDirectiveForPair(
  directives: Map<string, ConsolidationDirective>,
  identityA: string,
  identityB: string,
): ConsolidationDirective | undefined {
  return directives.get(directivePairKey(identityA, identityB));
}

/**
 * Append a durable consolidation directive for the pair {identityA, identityB}. Does NOT commit — the
 * caller (the review-answer path) is already inside the shared canonical-writer lock and stages/commits
 * the working tree, so the directive lands in the same commit as the answer (atomic, recorded at
 * answer-time) and is then promoted to `main`. Idempotent enough: re-recording the same verdict appends
 * a duplicate the last-wins read collapses; a later opposite verdict supersedes.
 */
export async function recordConsolidationDirective(
  root: string,
  directive: {
    identityA: string;
    identityB: string;
    verdict: ConsolidationVerdict;
    reviewId: string;
    decidedAt: string;
  },
): Promise<ConsolidationDirective> {
  const { identityA, identityB } = directive;
  const identities: [string, string] = identityA < identityB ? [identityA, identityB] : [identityB, identityA];
  const rec: ConsolidationDirective = {
    pairKey: directivePairKey(identityA, identityB),
    identities,
    verdict: directive.verdict,
    reviewId: directive.reviewId,
    decidedAt: directive.decidedAt,
  };
  const file = consolidationAbs(root);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.appendFile(file, JSON.stringify(rec) + '\n', 'utf8');
  return rec;
}

// ── Correction directives (SPEC-0050 slice-2b: content corrections — retract) ──────────────────
//
// A CORRECTION is a durable Principal ruling on a CLAIM: "this claim is wrong — suppress it" (retract;
// reattribute "it belongs to entity B" is a later sibling). Like the other directives it is durable +
// rebirth-proof, so a retracted claim STAYS suppressed across a re-derive / Full Replay.
//
// THE KEYING PROBLEM: a claim file's id is a ULID (reborn on replay) and its `subject` is an entity PATH
// (also reborn), so neither is a stable key. The only content-derived anchors are the SUBJECT ENTITY'S
// block identity (`kind|normalizedName`, stable) + the claim STATEMENT text. So a correction is keyed on
// `correctionClaimKey(identityKey, statement)`. Caveat: claim statements are LLM-authored, so a
// re-derive can REWORD the same fact — a substantially-reworded statement won't match (it gets a fresh
// confidence pass instead; the SPEC-0047 line). `normalizeStatement` absorbs casing/punctuation/spacing
// drift (the common case) but not genuine rewording — documented, not silently lossy.
//
// Stored evergreen under `directives/corrections.jsonl` (promoted to `main`, never purged), last-wins.
// ENFORCEMENT (the live half): the Claims block-regen (`entityBacklinks`) and Compose's cited-claim read
// (`readCitedClaims`) drop any claim whose (identity, statement) is retracted. The CREATE affordance
// ("correct this" UI → IPC) is slice-3; `recordCorrectionDirective` is the seam it calls.

export type CorrectionType = 'retract' | 'reattribute';

/**
 * One durable claim correction. Keyed on `correctionKey` = `correctionClaimKey(identityKey, statement)`
 * — the WRONG subject's STABLE block identity + the normalized statement (content-derived, ULID-free).
 * `statement` is kept verbatim for provenance / the Rules surface (never the lookup key).
 *
 * - `retract`: the claim is wrong → suppress it from `identityKey`'s surfaces.
 * - `reattribute`: the claim is on the WRONG subject (`identityKey`) → suppress it there, and `toIdentity`
 *   is the corrected subject. (Slice-2c v1 enforces the suppress-on-wrong-subject half; SURFACING the
 *   claim ON `toIdentity` is a documented follow-up — it needs cross-entity claim injection that touches
 *   the CLAIMS-21 perf path. `toIdentity` is recorded now so the Rules surface + that follow-up have it.)
 */
export interface CorrectionDirective {
  type: CorrectionType;
  correctionKey: string; // correctionClaimKey(identityKey, statement)
  identityKey: string; // the (wrong) subject entity block identity (kind|normalizedName)
  statement: string; // verbatim claim statement (provenance/display)
  toIdentity?: string; // reattribute only: the CORRECTED subject's block identity
  reviewId: string; // provenance: the answer/correction that produced this (PRIN-5/6)
  decidedAt: string; // ISO; ordering for last-wins revisability
}

/** Normalize a claim statement for content-keyed matching: lowercase, punctuation→space, collapse
 *  whitespace, trim. Absorbs casing/punctuation/spacing drift across a re-derive; NOT genuine rewording. */
export function normalizeStatement(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Stable, content-derived key for a claim correction: subject block identity + normalized statement. */
export function correctionClaimKey(identityKey: string, statement: string): string {
  return `${identityKey}::${normalizeStatement(statement)}`;
}

function correctionsAbs(root: string): string {
  return path.join(path.resolve(root), CORRECTION_DIRECTIVES_REL);
}

/**
 * Read every recorded correction into a last-wins map keyed by `correctionKey`. Absent/garbled lines are
 * skipped; an absent file yields an empty map. Tolerant of a malformed line (ENG-16).
 */
export async function readCorrectionDirectives(root: string): Promise<Map<string, CorrectionDirective>> {
  let raw: string;
  try {
    raw = await fs.readFile(correctionsAbs(root), 'utf8');
  } catch {
    return new Map();
  }
  const out = new Map<string, CorrectionDirective>();
  for (const line of raw.split('\n')) {
    if (line.trim().length === 0) continue;
    let obj: Partial<CorrectionDirective>;
    try {
      obj = JSON.parse(line) as Partial<CorrectionDirective>;
    } catch {
      continue;
    }
    if (obj.type !== 'retract' && obj.type !== 'reattribute') continue;
    if (typeof obj.correctionKey !== 'string' || obj.correctionKey.length === 0) continue;
    if (typeof obj.identityKey !== 'string' || obj.identityKey.length === 0) continue;
    if (typeof obj.statement !== 'string') continue;
    // reattribute requires a corrected target identity; a malformed one is dropped (ENG-16).
    if (obj.type === 'reattribute' && (typeof obj.toIdentity !== 'string' || obj.toIdentity.length === 0)) continue;
    out.set(obj.correctionKey, {
      type: obj.type,
      correctionKey: obj.correctionKey,
      identityKey: obj.identityKey,
      statement: obj.statement,
      ...(obj.type === 'reattribute' ? { toIdentity: obj.toIdentity as string } : {}),
      reviewId: typeof obj.reviewId === 'string' ? obj.reviewId : '',
      decidedAt: typeof obj.decidedAt === 'string' ? obj.decidedAt : '',
    });
  }
  return out;
}

/** Whether the claim {subject identity, statement} is SUPPRESSED on that subject by a durable correction —
 *  true for BOTH `retract` (it's wrong) and `reattribute` (it's on the wrong subject). The block-regen +
 *  compose read paths gate on this so a corrected claim leaves the wrong entity's surfaces. */
export function isClaimSuppressed(
  corrections: Map<string, CorrectionDirective>,
  identityKey: string,
  statement: string,
): boolean {
  const t = corrections.get(correctionClaimKey(identityKey, statement))?.type;
  return t === 'retract' || t === 'reattribute';
}

/** Whether the claim {subject identity, statement} has specifically been RETRACTED (not reattributed). */
export function isClaimRetracted(
  corrections: Map<string, CorrectionDirective>,
  identityKey: string,
  statement: string,
): boolean {
  return corrections.get(correctionClaimKey(identityKey, statement))?.type === 'retract';
}

/** The corrected target identity for a REATTRIBUTED claim, or undefined if not reattributed. Used by the
 *  Rules surface (display) and the future surface-on-target follow-up. */
export function reattributedTarget(
  corrections: Map<string, CorrectionDirective>,
  identityKey: string,
  statement: string,
): string | undefined {
  const d = corrections.get(correctionClaimKey(identityKey, statement));
  return d?.type === 'reattribute' ? d.toIdentity : undefined;
}

/**
 * Append a durable correction directive. Does NOT commit — the caller (the correction-record path) is
 * inside the shared canonical-writer lock and stages/commits, so it lands atomically. Last-wins: a later
 * record for the same claim supersedes (a future revoke/reattribute is a sibling type).
 */
export async function recordCorrectionDirective(
  root: string,
  correction: { type: CorrectionType; identityKey: string; statement: string; toIdentity?: string; reviewId: string; decidedAt: string },
): Promise<CorrectionDirective> {
  if (correction.type === 'reattribute' && (!correction.toIdentity || correction.toIdentity.length === 0)) {
    throw new Error('directives: a reattribute correction requires a non-empty toIdentity (the corrected subject)');
  }
  const rec: CorrectionDirective = {
    type: correction.type,
    correctionKey: correctionClaimKey(correction.identityKey, correction.statement),
    identityKey: correction.identityKey,
    statement: correction.statement,
    ...(correction.type === 'reattribute' ? { toIdentity: correction.toIdentity } : {}),
    reviewId: correction.reviewId,
    decidedAt: correction.decidedAt,
  };
  const file = correctionsAbs(root);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.appendFile(file, JSON.stringify(rec) + '\n', 'utf8');
  return rec;
}

// ── Contradiction lifecycle (SPEC-0036 CONTRA) ─────────────────────────────────────────────────
//
// A CONTRADICTION is a first-class, durable object tracking a DISAGREEMENT between ≥2 claims about ONE
// entity (a bio says "born 1815", another "born 1816") through a small lifecycle to resolution — instead
// of silently holding both and asserting one at recall (CONTRA-1). It is NOT a directive the human gives;
// it is detected by agent judgment (REFLECT, CONTRA-2). But it shares the directive family's defining
// property and lives in the SAME evergreen `directives/` tree precisely so the ENTITY FLAG it raises is
// REBIRTH-PROOF: keyed on the entity's STABLE block identity (`kind|normalizedName`) + the conflicting
// statements — never an entity ULID — so a flag raised before a re-derive / Full Replay still points at
// the same entity afterward (the same durability my corrections/disambiguation directives have).
//
// THE STATE MACHINE (§2): detected → resolved | accepted | needs-you, re-openable. v1 collapses to the
// states that matter for the FLAG + recall:
//   - needs-you : detected and routed to the #192 Review queue (CONTRA-5) — an OPEN flag on the entity.
//   - resolved  : a newer/stronger claim superseded the other; the loser is RETAINED + marked, never
//                 deleted (CONTRA-4). Flag CLEARS; recall no longer contests (one answer won).
//   - accepted  : both legitimately stand, attributed (a genuine disagreement). Flag CLEARS from the
//                 needs-you queue, but recall still surfaces it as CONTESTED (CONTRA-6) — both cited.
// `detected` is the transient pre-routing state (a finding before the Review lands); in v1 the producer
// records `needs-you` directly (detection and routing are one step). Re-open = a later `needs-you` record
// for the same key after a terminal state — last-wins handles it (a new conflicting claim re-raises).
//
// STORAGE: append-only `directives/contradictions.jsonl`, evergreen (promoted to `main`, never purged),
// garbled-line tolerant (ENG-16), last-wins per `contradictionKey` so the lifecycle transition (and any
// re-open) collapses to the current state. The OPEN-FLAG read (`openContradictionsForIdentity`) and the
// CONTESTED-recall read (`contestedContradictionsForIdentity`) are the two consumers.

/** The contradiction lifecycle states tracked in v1 (SPEC-0036 §2). */
export type ContradictionState = 'detected' | 'needs-you' | 'resolved' | 'accepted';

/** OPEN states — a contradiction in one of these flags its entity (in the needs-you queue + entity view). */
const OPEN_CONTRADICTION_STATES: ReadonlySet<ContradictionState> = new Set(['detected', 'needs-you']);
/** CONTESTED states — recall must surface the fact as disputed + cite both (open OR accepted; CONTRA-6). */
const CONTESTED_CONTRADICTION_STATES: ReadonlySet<ContradictionState> = new Set(['detected', 'needs-you', 'accepted']);

/**
 * One tracked contradiction. Keyed on `contradictionKey` = entity block identity + the order-independent
 * pair of NORMALIZED statements (content-derived, ULID-free → stable across rebirth). `statements` is kept
 * verbatim for provenance / the recall "sources disagree" surface. `reviewId` is the Review this routed to
 * (CONTRA-5 needs-you); `decidedAt` orders last-wins so a lifecycle transition supersedes the prior state.
 */
export interface ContradictionDirective {
  contradictionKey: string; // contradictionClaimKey(identityKey, statementA, statementB)
  identityKey: string; // the entity's STABLE block identity (kind|normalizedName) — the flag anchor
  statements: [string, string]; // the two conflicting claim statements, verbatim (sorted for stability)
  state: ContradictionState;
  reviewId: string; // provenance: the Review the contradiction routed to (PRIN-5/6)
  decidedAt: string; // ISO; ordering for last-wins lifecycle transitions + re-open
}

/**
 * Stable, content-derived key for a contradiction: the entity block identity + an ORDER-INDEPENDENT pair
 * of normalized statements. Order independence means "1815 vs 1816" and "1816 vs 1815" are ONE
 * contradiction (so a re-detection updates, never duplicates). `normalizeStatement` (shared with
 * corrections) absorbs casing/punctuation/spacing drift across a re-derive; genuine rewording won't match
 * (documented — a reworded pair is a fresh contradiction, same caveat as retract).
 */
export function contradictionClaimKey(identityKey: string, statementA: string, statementB: string): string {
  const a = normalizeStatement(statementA);
  const b = normalizeStatement(statementB);
  const [lo, hi] = a < b ? [a, b] : [b, a];
  return `${identityKey}::${lo}::${hi}`;
}

function contradictionsAbs(root: string): string {
  return path.join(path.resolve(root), CONTRADICTION_DIRECTIVES_REL);
}

function isContradictionState(v: unknown): v is ContradictionState {
  return v === 'detected' || v === 'needs-you' || v === 'resolved' || v === 'accepted';
}

/**
 * Read every recorded contradiction into a last-wins map keyed by `contradictionKey` — a lifecycle
 * transition (needs-you → resolved/accepted) or a re-open (terminal → needs-you) supersedes the earlier
 * record. Absent/garbled lines are skipped; an absent file yields an empty map (ENG-16 tolerant).
 */
export async function readContradictionDirectives(root: string): Promise<Map<string, ContradictionDirective>> {
  let raw: string;
  try {
    raw = await fs.readFile(contradictionsAbs(root), 'utf8');
  } catch {
    return new Map();
  }
  const out = new Map<string, ContradictionDirective>();
  for (const line of raw.split('\n')) {
    if (line.trim().length === 0) continue;
    let obj: Partial<ContradictionDirective>;
    try {
      obj = JSON.parse(line) as Partial<ContradictionDirective>;
    } catch {
      continue;
    }
    if (typeof obj.contradictionKey !== 'string' || obj.contradictionKey.length === 0) continue;
    if (typeof obj.identityKey !== 'string' || obj.identityKey.length === 0) continue;
    if (!isContradictionState(obj.state)) continue;
    if (!Array.isArray(obj.statements) || obj.statements.length !== 2) continue;
    out.set(obj.contradictionKey, {
      contradictionKey: obj.contradictionKey,
      identityKey: obj.identityKey,
      statements: [String(obj.statements[0]), String(obj.statements[1])],
      state: obj.state,
      reviewId: typeof obj.reviewId === 'string' ? obj.reviewId : '',
      decidedAt: typeof obj.decidedAt === 'string' ? obj.decidedAt : '',
    });
  }
  return out;
}

/** The tracked contradiction for a specific key, or undefined if never recorded. */
export function contradictionForKey(
  contradictions: Map<string, ContradictionDirective>,
  identityKey: string,
  statementA: string,
  statementB: string,
): ContradictionDirective | undefined {
  return contradictions.get(contradictionClaimKey(identityKey, statementA, statementB));
}

/** The OPEN contradictions flagging an entity (state detected|needs-you) — the durable ENTITY FLAG that
 *  persists until resolved (CONTRA-7). Empty when the entity has no open disagreement. */
export function openContradictionsForIdentity(
  contradictions: Map<string, ContradictionDirective>,
  identityKey: string,
): ContradictionDirective[] {
  return [...contradictions.values()].filter((c) => c.identityKey === identityKey && OPEN_CONTRADICTION_STATES.has(c.state));
}

/** The CONTESTED contradictions for an entity (open OR accepted) — what recall surfaces as "sources
 *  disagree" and cites both for (CONTRA-6). `resolved` is excluded (one claim won — no longer contested). */
export function contestedContradictionsForIdentity(
  contradictions: Map<string, ContradictionDirective>,
  identityKey: string,
): ContradictionDirective[] {
  return [...contradictions.values()].filter((c) => c.identityKey === identityKey && CONTESTED_CONTRADICTION_STATES.has(c.state));
}

/** Whether a specific claim statement participates in a CONTESTED contradiction on the entity (per-claim
 *  recall flag — the claim is rendered "disputed", CONTRA-6). Matched on the normalized statement so
 *  casing/punctuation drift across a re-derive still flags it. */
export function isStatementContested(
  contradictions: Map<string, ContradictionDirective>,
  identityKey: string,
  statement: string,
): boolean {
  const norm = normalizeStatement(statement);
  for (const c of contestedContradictionsForIdentity(contradictions, identityKey)) {
    if (normalizeStatement(c.statements[0]) === norm || normalizeStatement(c.statements[1]) === norm) return true;
  }
  return false;
}

/**
 * Append a contradiction-lifecycle record. Does NOT commit — the caller (the detection path in jobStage,
 * or the resolution path in answerReview) is inside the shared canonical-writer lock / a stage worktree and
 * stages/commits, so the record lands in the SAME commit as the Review it raises (detection) or the answer
 * that resolves it (resolution) and is promoted to `main`. Statements are sorted so the same pair always
 * serializes identically. Last-wins: a later record for the same key supersedes (transition / re-open).
 */
export async function recordContradictionDirective(
  root: string,
  contradiction: {
    identityKey: string;
    statementA: string;
    statementB: string;
    state: ContradictionState;
    reviewId: string;
    decidedAt: string;
  },
): Promise<ContradictionDirective> {
  const { identityKey, statementA, statementB } = contradiction;
  const statements: [string, string] = statementA <= statementB ? [statementA, statementB] : [statementB, statementA];
  const rec: ContradictionDirective = {
    contradictionKey: contradictionClaimKey(identityKey, statementA, statementB),
    identityKey,
    statements,
    state: contradiction.state,
    reviewId: contradiction.reviewId,
    decidedAt: contradiction.decidedAt,
  };
  const file = contradictionsAbs(root);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.appendFile(file, JSON.stringify(rec) + '\n', 'utf8');
  return rec;
}

// ── The directive FAMILY taxonomy + revoke (SPEC-0050 slice-3) ──────────────────────────────────
//
// Slices 1/2 each introduced a directive family (disambiguation, consolidation, correction,
// contradiction). Slice 3 adds two cross-cutting pieces:
//   - `guidance`: a durable, freeform human STEER for an entity (or global) — "keep her page oriented
//     toward her publications", "treat this org as defunct". Not a verdict; a nudge the relevant stage
//     prompt folds in. Keyed on the entity block identity (or a GLOBAL sentinel), last-wins.
//   - `revoke`: cancels a PRIOR directive of ANY family — "I take that back". Because every directive is
//     keyed on a content-derived KEY (not a ULID), a revoke targets `(family, key)`. A revoke and a later
//     RE-assertion of the same directive both carry `decidedAt`, so the rule is timestamp-ordered: a
//     directive is revoked iff the latest revoke for its `(family, key)` is **at or after** the directive's
//     own `decidedAt` (re-asserting it later un-revokes — last-wins across the two logs).
//
// These are the substrate for the slice-3 READ-ONLY "Rules" surface (active = revokes applied) and the
// "correct this" affordances. Both live under the evergreen `directives/` tree (durable across replay).

/** The directive families a `revoke` can target — each is a distinct evergreen JSONL keyed on a stable key. */
export type DirectiveFamily = 'disambiguation' | 'consolidation' | 'correction' | 'contradiction' | 'guidance' | 'enrich';

/** Sentinel identity for a GLOBAL guidance steer (applies everywhere, not one entity). Never collides with a
 *  real block identity: `blockKey` always contains a `|`, and this token has none. */
export const GLOBAL_GUIDANCE_KEY = '*global*';

/**
 * One durable guidance steer. Keyed on `identityKey` — an entity's STABLE block identity (rebirth-proof)
 * or `GLOBAL_GUIDANCE_KEY`. `guidance` is the freeform human text the consuming stage prompt folds in.
 * Last-wins per key (a later steer revises the earlier); a `revoke` for `('guidance', identityKey)` cancels it.
 */
export interface GuidanceDirective {
  identityKey: string; // block identity (kind|normalizedName) or GLOBAL_GUIDANCE_KEY
  guidance: string; // the freeform durable steer (verbatim)
  reviewId: string; // provenance (PRIN-5/6)
  decidedAt: string; // ISO; last-wins ordering + revoke comparison
}

function guidanceAbs(root: string): string {
  return path.join(path.resolve(root), GUIDANCE_DIRECTIVES_REL);
}

/**
 * Read every guidance steer into a last-wins map keyed by `identityKey`. Absent/garbled lines skipped; an
 * absent file → empty map (ENG-16 tolerant). Does NOT apply revokes — use `activeGuidanceForIdentity`
 * (or filter with `isDirectiveRevoked`) for the revoke-aware ACTIVE view.
 */
export async function readGuidanceDirectives(root: string): Promise<Map<string, GuidanceDirective>> {
  let raw: string;
  try {
    raw = await fs.readFile(guidanceAbs(root), 'utf8');
  } catch {
    return new Map();
  }
  const out = new Map<string, GuidanceDirective>();
  for (const line of raw.split('\n')) {
    if (line.trim().length === 0) continue;
    let obj: Partial<GuidanceDirective>;
    try {
      obj = JSON.parse(line) as Partial<GuidanceDirective>;
    } catch {
      continue;
    }
    if (typeof obj.identityKey !== 'string' || obj.identityKey.length === 0) continue;
    if (typeof obj.guidance !== 'string' || obj.guidance.trim().length === 0) continue;
    out.set(obj.identityKey, {
      identityKey: obj.identityKey,
      guidance: obj.guidance,
      reviewId: typeof obj.reviewId === 'string' ? obj.reviewId : '',
      decidedAt: typeof obj.decidedAt === 'string' ? obj.decidedAt : '',
    });
  }
  return out;
}

/**
 * Append a guidance steer. Does NOT commit — the caller is inside the shared canonical-writer lock /
 * a stage worktree and stages/commits, so it lands atomically + promotes. Last-wins per `identityKey`.
 * `identityKey` defaults to GLOBAL when omitted/empty (a global steer). Throws on empty guidance text.
 */
export async function recordGuidanceDirective(
  root: string,
  guidance: { identityKey?: string; guidance: string; reviewId: string; decidedAt: string },
): Promise<GuidanceDirective> {
  if (!guidance.guidance || guidance.guidance.trim().length === 0) {
    throw new Error('directives: a guidance steer requires non-empty guidance text');
  }
  const rec: GuidanceDirective = {
    identityKey: guidance.identityKey && guidance.identityKey.length > 0 ? guidance.identityKey : GLOBAL_GUIDANCE_KEY,
    guidance: guidance.guidance,
    reviewId: guidance.reviewId,
    decidedAt: guidance.decidedAt,
  };
  const file = guidanceAbs(root);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.appendFile(file, JSON.stringify(rec) + '\n', 'utf8');
  return rec;
}

// ── Revoke ──────────────────────────────────────────────────────────────────────────────────────

/** One durable revoke: cancels the directive identified by `(family, targetKey)` as of `decidedAt`. */
export interface RevokeDirective {
  family: DirectiveFamily; // which family the target directive lives in
  targetKey: string; // the target directive's content-derived key (identityKey / pairKey / correctionKey / …)
  reviewId: string; // provenance (PRIN-5/6)
  decidedAt: string; // ISO; the revoke takes effect at/after this — a later re-assertion un-revokes
}

/** Order-independent map key for a revoke target (family + the directive's stable key). */
function revokeKey(family: DirectiveFamily, targetKey: string): string {
  return `${family}::${targetKey}`;
}

function revokesAbs(root: string): string {
  return path.join(path.resolve(root), REVOKE_DIRECTIVES_REL);
}

const DIRECTIVE_FAMILIES: ReadonlySet<string> = new Set(['disambiguation', 'consolidation', 'correction', 'contradiction', 'guidance', 'enrich']);

/**
 * Read every revoke into a last-wins map keyed by `(family, targetKey)` — the LATEST revoke per target wins
 * (its `decidedAt` is what `isDirectiveRevoked` compares against, so re-revoking just moves the timestamp).
 * Absent/garbled lines skipped; an absent file → empty map (ENG-16 tolerant).
 */
export async function readRevokeDirectives(root: string): Promise<Map<string, RevokeDirective>> {
  let raw: string;
  try {
    raw = await fs.readFile(revokesAbs(root), 'utf8');
  } catch {
    return new Map();
  }
  const out = new Map<string, RevokeDirective>();
  for (const line of raw.split('\n')) {
    if (line.trim().length === 0) continue;
    let obj: Partial<RevokeDirective>;
    try {
      obj = JSON.parse(line) as Partial<RevokeDirective>;
    } catch {
      continue;
    }
    if (typeof obj.family !== 'string' || !DIRECTIVE_FAMILIES.has(obj.family)) continue;
    if (typeof obj.targetKey !== 'string' || obj.targetKey.length === 0) continue;
    const rec: RevokeDirective = {
      family: obj.family as DirectiveFamily,
      targetKey: obj.targetKey,
      reviewId: typeof obj.reviewId === 'string' ? obj.reviewId : '',
      decidedAt: typeof obj.decidedAt === 'string' ? obj.decidedAt : '',
    };
    const k = revokeKey(rec.family, rec.targetKey);
    const prev = out.get(k);
    // Keep the LATEST revoke per target (string ISO compare is chronological for the same format).
    if (!prev || prev.decidedAt <= rec.decidedAt) out.set(k, rec);
  }
  return out;
}

/**
 * Whether a directive `(family, key)` decided at `directiveDecidedAt` is currently REVOKED: true iff the
 * latest revoke for that target is **at or after** the directive's own timestamp. A later re-assertion of
 * the directive (a newer `directiveDecidedAt`) is NOT revoked by an older revoke — last-wins across the two
 * logs, so a human can revoke then later re-assert. An empty/absent `directiveDecidedAt` is treated as
 * always-revocable by any revoke (the conservative read — a record with no timestamp can't out-order one).
 */
export function isDirectiveRevoked(
  revokes: Map<string, RevokeDirective>,
  family: DirectiveFamily,
  key: string,
  directiveDecidedAt: string,
): boolean {
  const r = revokes.get(revokeKey(family, key));
  if (!r) return false;
  if (!directiveDecidedAt) return true; // no timestamp on the directive → any revoke cancels it
  return r.decidedAt >= directiveDecidedAt;
}

/**
 * Append a revoke for `(family, targetKey)`. Does NOT commit — the caller is inside the shared
 * canonical-writer lock / a stage worktree and stages/commits (atomic + promoted). Throws on an unknown
 * family or empty target key (a revoke that can't be matched is a silent no-op we refuse to write).
 */
export async function recordRevokeDirective(
  root: string,
  revoke: { family: DirectiveFamily; targetKey: string; reviewId: string; decidedAt: string },
): Promise<RevokeDirective> {
  if (!DIRECTIVE_FAMILIES.has(revoke.family)) {
    throw new Error(`directives: revoke has unknown family ${JSON.stringify(revoke.family)}`);
  }
  if (!revoke.targetKey || revoke.targetKey.length === 0) {
    throw new Error('directives: a revoke requires a non-empty targetKey');
  }
  const rec: RevokeDirective = { family: revoke.family, targetKey: revoke.targetKey, reviewId: revoke.reviewId, decidedAt: revoke.decidedAt };
  const file = revokesAbs(root);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.appendFile(file, JSON.stringify(rec) + '\n', 'utf8');
  return rec;
}

/**
 * The ACTIVE guidance steer for an entity identity (revokes applied) — what a consuming stage prompt folds
 * in, or `undefined` if there is none or it has been revoked. This is the revoke-aware read; raw
 * `readGuidanceDirectives` is the pre-revoke view.
 */
export function activeGuidanceForIdentity(
  guidance: Map<string, GuidanceDirective>,
  revokes: Map<string, RevokeDirective>,
  identityKey: string,
): GuidanceDirective | undefined {
  const g = guidance.get(identityKey);
  if (!g) return undefined;
  return isDirectiveRevoked(revokes, 'guidance', identityKey, g.decidedAt) ? undefined : g;
}

/**
 * REVOKE-aware claim suppression: like `isClaimSuppressed`, but a correction that has been REVOKED no
 * longer suppresses (the Principal took the retraction/reattribution back → the claim returns to its
 * surfaces). The correction's revoke target key is its `correctionClaimKey`, family `'correction'`. The
 * Claims block-regen + Compose read paths use THIS (revoke-aware) variant so a revoke is functional, not
 * just a Rules-surface annotation. With an empty revokes map it is identical to `isClaimSuppressed`.
 */
export function isClaimSuppressedActive(
  corrections: Map<string, CorrectionDirective>,
  revokes: Map<string, RevokeDirective>,
  identityKey: string,
  statement: string,
): boolean {
  const key = correctionClaimKey(identityKey, statement);
  const d = corrections.get(key);
  if (!d || (d.type !== 'retract' && d.type !== 'reattribute')) return false;
  return !isDirectiveRevoked(revokes, 'correction', key, d.decidedAt);
}

// ── Enrich (SPEC-0050 slice-3c: "keep enriching X toward Y") ────────────────────────────────────
//
// An ENRICH directive is a durable Principal steer for RESEARCH: "keep enriching <entity> toward <facet>"
// (e.g. "Ada Lovelace → her publications"). It is the research analogue of `guidance` (which steers
// Compose): keyed on the entity's STABLE block identity, last-wins, revocable. The CONSUMER is the
// researcher's orient phase (SPEC-0028 RESEARCH-24): the active `toward` facet is offered to `chooseAngle`
// as a TOP-PRIORITY missing-gap facet, so a re-run pursues the Principal's standing target before the
// auto-detected gap. (The orient wire is coordinated with DEV-2, who owns `researchOrient.ts`;
// `activeEnrichTowardForIdentity` is the seam it reads.)

/** One durable enrich steer. Keyed on `identityKey` (the entity's block identity, rebirth-proof); `toward`
 *  is the facet to keep pursuing. Last-wins per identity; a `revoke` for `('enrich', identityKey)` cancels it. */
export interface EnrichDirective {
  identityKey: string; // entity block identity (kind|normalizedName)
  toward: string; // the enrichment facet/angle to keep pursuing (verbatim)
  reviewId: string; // provenance (PRIN-5/6)
  decidedAt: string; // ISO; last-wins ordering + revoke comparison
}

function enrichAbs(root: string): string {
  return path.join(path.resolve(root), ENRICH_DIRECTIVES_REL);
}

/**
 * Read every enrich steer into a last-wins map keyed by `identityKey`. Absent/garbled lines skipped; an
 * absent file → empty map (ENG-16 tolerant). Does NOT apply revokes — use `activeEnrichTowardForIdentity`
 * (or filter with `isDirectiveRevoked`) for the revoke-aware ACTIVE view the orient consumer reads.
 */
export async function readEnrichDirectives(root: string): Promise<Map<string, EnrichDirective>> {
  let raw: string;
  try {
    raw = await fs.readFile(enrichAbs(root), 'utf8');
  } catch {
    return new Map();
  }
  const out = new Map<string, EnrichDirective>();
  for (const line of raw.split('\n')) {
    if (line.trim().length === 0) continue;
    let obj: Partial<EnrichDirective>;
    try {
      obj = JSON.parse(line) as Partial<EnrichDirective>;
    } catch {
      continue;
    }
    if (typeof obj.identityKey !== 'string' || obj.identityKey.length === 0) continue;
    if (typeof obj.toward !== 'string' || obj.toward.trim().length === 0) continue;
    out.set(obj.identityKey, {
      identityKey: obj.identityKey,
      toward: obj.toward,
      reviewId: typeof obj.reviewId === 'string' ? obj.reviewId : '',
      decidedAt: typeof obj.decidedAt === 'string' ? obj.decidedAt : '',
    });
  }
  return out;
}

/**
 * Append an enrich steer. Does NOT commit — the caller is inside the shared canonical-writer lock / a stage
 * worktree and stages/commits (atomic + promoted). Last-wins per `identityKey`. Throws on empty `toward`.
 */
export async function recordEnrichDirective(
  root: string,
  enrich: { identityKey: string; toward: string; reviewId: string; decidedAt: string },
): Promise<EnrichDirective> {
  if (!enrich.identityKey || enrich.identityKey.length === 0) {
    throw new Error('directives: an enrich steer requires a non-empty identityKey (the entity block identity)');
  }
  if (!enrich.toward || enrich.toward.trim().length === 0) {
    throw new Error('directives: an enrich steer requires a non-empty toward facet');
  }
  const rec: EnrichDirective = { identityKey: enrich.identityKey, toward: enrich.toward, reviewId: enrich.reviewId, decidedAt: enrich.decidedAt };
  const file = enrichAbs(root);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.appendFile(file, JSON.stringify(rec) + '\n', 'utf8');
  return rec;
}

/**
 * The ACTIVE enrich `toward` facet for an entity identity (revokes applied), or `undefined` if none / revoked.
 * The orient consumer (RESEARCH-24) offers this to `chooseAngle` as the top-priority gap facet so a research
 * pass pursues the Principal's standing steer first. This is the revoke-aware read; `readEnrichDirectives`
 * is the pre-revoke view.
 */
export function activeEnrichTowardForIdentity(
  enrich: Map<string, EnrichDirective>,
  revokes: Map<string, RevokeDirective>,
  identityKey: string,
): string | undefined {
  const e = enrich.get(identityKey);
  if (!e) return undefined;
  return isDirectiveRevoked(revokes, 'enrich', identityKey, e.decidedAt) ? undefined : e.toward;
}

// ── Health dismissals (SPEC-0060 VUX-16 slice-1) ─────────────────────────────────────────────────
// The Principal said "ignore this Health finding". Keyed by the finding's STABLE identity
// (`<class>:<blockKey>` for an entity finding, `dangling:<fromKey>→<target>` for a dead link — see
// `healthFindingKey` in healthRemediation.ts), so a dismissal survives re-derive/replay even though the
// entity's ULID is reborn. `dismissed` is last-wins per key: a `false` record un-dismisses (re-surfaces),
// so the store stays append-only like its siblings while still supporting a future "restore" affordance.

/** One durable Health-finding dismissal. `findingKey` is content-stable (NOT a ULID). */
export interface HealthDismissalDirective {
  findingKey: string;
  kind: string; // the finding class — 'orphan' | 'thin' | 'dangling' (kept generic, like the others)
  dismissed: boolean; // last-wins: true = ignore the finding; false = un-dismiss (re-surface)
  reason?: string; // optional human note
  decidedAt: string; // ISO provenance (PRIN-5/6)
}

function healthDismissalsAbs(root: string): string {
  return path.join(path.resolve(root), HEALTH_DISMISSAL_DIRECTIVES_REL);
}

/**
 * Read every Health dismissal into a last-wins map keyed by `findingKey` (latest record per finding wins,
 * so a later `dismissed:false` un-dismisses). Absent/garbled lines skipped; absent file → empty (ENG-16).
 */
export async function readHealthDismissals(root: string): Promise<Map<string, HealthDismissalDirective>> {
  let raw: string;
  try {
    raw = await fs.readFile(healthDismissalsAbs(root), 'utf8');
  } catch {
    return new Map();
  }
  const out = new Map<string, HealthDismissalDirective>();
  for (const line of raw.split('\n')) {
    if (line.trim().length === 0) continue;
    let obj: Partial<HealthDismissalDirective>;
    try {
      obj = JSON.parse(line) as Partial<HealthDismissalDirective>;
    } catch {
      continue;
    }
    if (typeof obj.findingKey !== 'string' || obj.findingKey.length === 0) continue;
    const rec: HealthDismissalDirective = {
      findingKey: obj.findingKey,
      kind: typeof obj.kind === 'string' ? obj.kind : '',
      dismissed: obj.dismissed !== false, // default true (a record with no flag is a dismissal)
      reason: typeof obj.reason === 'string' ? obj.reason : undefined,
      decidedAt: typeof obj.decidedAt === 'string' ? obj.decidedAt : '',
    };
    const prev = out.get(rec.findingKey);
    if (!prev || prev.decidedAt <= rec.decidedAt) out.set(rec.findingKey, rec); // latest wins
  }
  return out;
}

/** True iff `findingKey` is currently dismissed (latest record says so). */
export function isHealthFindingDismissed(dismissals: Map<string, HealthDismissalDirective>, findingKey: string): boolean {
  return dismissals.get(findingKey)?.dismissed === true;
}

/**
 * Append a Health-dismissal record. Does NOT commit — the caller is inside the shared canonical-writer
 * lock and stages/commits (atomic + promoted). Throws on an empty `findingKey` (an un-keyable dismissal
 * is a silent no-op we refuse to write).
 */
export async function recordHealthDismissal(
  root: string,
  d: { findingKey: string; kind: string; dismissed?: boolean; reason?: string; decidedAt: string },
): Promise<HealthDismissalDirective> {
  if (!d.findingKey || d.findingKey.length === 0) {
    throw new Error('directives: a Health dismissal requires a non-empty findingKey');
  }
  const rec: HealthDismissalDirective = {
    findingKey: d.findingKey,
    kind: d.kind,
    dismissed: d.dismissed !== false,
    ...(d.reason ? { reason: d.reason } : {}),
    decidedAt: d.decidedAt,
  };
  const file = healthDismissalsAbs(root);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.appendFile(file, JSON.stringify(rec) + '\n', 'utf8');
  return rec;
}
