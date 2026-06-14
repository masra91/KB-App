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
