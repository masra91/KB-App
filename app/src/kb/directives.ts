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
