// The Claims stage's decision shape + validation (SPEC-0016 CLAIMS). The thin agent reads
// ONE entity node + the WHOLE source it derives from and returns this decision; the
// orchestrator does all effects (CLAIMS-3). Mirrors decompose.ts so the harness pattern is
// reused, not reinvented (ORCH-9).
//
// Epistemic vocabulary (CLAIMS-7/8): `status` is a CLOSED set {fact, interpretation,
// hypothesis} — validated against an allow-list, because a node is an identity anchor with
// no truth-value while an *assertion about* it does (this is where DECOMP-15 deferred
// `status` to land). Contrast the OPEN `kind`/signal-`type` vocabularies in decompose,
// which are non-empty-only. Signal `type` stays OPEN here too (CLAIMS-13), so the signal
// validator is shared with decompose.ts rather than duplicated.
import type { AgentTrace } from './archivist';
import { type SignalDecision, validSignal } from './decompose';
import { type ReviewRequest, validReviewRequests } from './reviews';

/** The CLOSED set of epistemic statuses a claim may carry (CLAIMS-8; DATA-7 / PRIN-3). */
export const CLAIM_STATUSES = ['fact', 'interpretation', 'hypothesis'] as const;
export type ClaimStatus = (typeof CLAIM_STATUSES)[number];

/** One assertion a source makes ABOUT the subject entity (CLAIMS-6). Single-subject: the
 *  subject is the queue-item entity, never restated here (CLAIMS-10). */
export interface ClaimDecision {
  statement: string; // NL assertion about the subject entity, grounded in the source
  status: ClaimStatus; // CLOSED set (CLAIMS-8)
  confidence: number; // 0..1 calibrated belief the claim is real + correctly parsed (DATA-7)
  mentions: string[]; // verbatim evidence spans from the source (DATA-7)
  /** Soft, UNRESOLVED hints at other entities the statement touches — breadcrumbs for
   *  Connect, NOT typed links (CLAIMS-10). Optional, usually absent. */
  relatesTo?: string[];
}

/** The whole decision returned by one disposable Claims session. */
export interface ClaimsDecision {
  entityId: string;
  claims: ClaimDecision[];
  signals?: SignalDecision[];
  /** Yes/no escalations the agent raises instead of guessing (SPEC-0018 REVIEW-14). When
   *  present, the orchestrator PARKS this item and applies no claims until answered. */
  reviews?: ReviewRequest[];
  /** Provenance of the decision itself (ORCH-16), filled by the decider. */
  agent?: AgentTrace;
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.trim().length > 0;
}

/** Coerce a confidence to a number in [0,1]; throw if absent/out of range. */
function validConfidence(v: unknown): number {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 1) {
    throw new Error(`claims: confidence must be a number in [0,1], got ${JSON.stringify(v)}`);
  }
  return v;
}

function isClaimStatus(v: unknown): v is ClaimStatus {
  return typeof v === 'string' && (CLAIM_STATUSES as readonly string[]).includes(v);
}

function validMentions(v: unknown): string[] {
  if (!Array.isArray(v)) throw new Error('claims: claim.mentions must be an array');
  return v.map((m, i) => {
    if (!isNonEmptyString(m)) throw new Error(`claims: claim.mentions[${i}] must be a non-empty string`);
    return m;
  });
}

function validRelatesTo(v: unknown): string[] | undefined {
  if (v === undefined) return undefined;
  if (!Array.isArray(v) || !v.every(isNonEmptyString)) {
    throw new Error('claims: claim.relatesTo must be an array of non-empty strings when present');
  }
  return v.length > 0 ? (v as string[]) : undefined;
}

function validClaim(v: unknown, i: number): ClaimDecision {
  if (typeof v !== 'object' || v === null) throw new Error(`claims: claims[${i}] must be an object`);
  const o = v as Record<string, unknown>;
  if (!isNonEmptyString(o.statement)) throw new Error(`claims: claims[${i}].statement must be a non-empty string`);
  // status: CLOSED set — validated against the allow-list (CLAIMS-8), unlike open kind/type.
  if (!isClaimStatus(o.status)) {
    throw new Error(`claims: claims[${i}].status must be one of ${CLAIM_STATUSES.join('|')}, got ${JSON.stringify(o.status)}`);
  }
  const claim: ClaimDecision = {
    statement: o.statement,
    status: o.status,
    confidence: validConfidence(o.confidence),
    mentions: validMentions(o.mentions),
  };
  const relatesTo = validRelatesTo(o.relatesTo);
  if (relatesTo) claim.relatesTo = relatesTo;
  return claim;
}

/**
 * Parse + validate one session's stdout into a ClaimsDecision (CLAIMS-12). Tolerates
 * surrounding prose/markdown by extracting the first JSON object. Throws on anything off —
 * the orchestrator treats a throw as a failed attempt (retry, then set aside; ORCH-12) and
 * NEVER fabricates claims, so a bad session can't pollute the graph.
 *
 * @param expectedEntityId if given, the decision's entityId MUST match (guards against a
 *   stale/confused session claiming the wrong entity; CLAIMS-12).
 */
export function parseClaimsDecision(stdout: string, expectedEntityId?: string): ClaimsDecision {
  const match = stdout.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('claims: no JSON object in output');
  const obj = JSON.parse(match[0]) as Record<string, unknown>;

  if (!isNonEmptyString(obj.entityId)) throw new Error('claims: missing entityId');
  if (expectedEntityId && obj.entityId !== expectedEntityId) {
    throw new Error(`claims: entityId mismatch (got ${obj.entityId}, expected ${expectedEntityId})`);
  }
  if (!Array.isArray(obj.claims)) throw new Error('claims: claims must be an array');

  const claims = obj.claims.map((c, i) => validClaim(c, i));
  let signals: SignalDecision[] | undefined;
  if (obj.signals !== undefined) {
    if (!Array.isArray(obj.signals)) throw new Error('claims: signals must be an array when present');
    signals = obj.signals.map((s, i) => validSignal(s, i));
  }
  const reviews = validReviewRequests(obj.reviews); // [] when absent (REVIEW-14)

  const decision: ClaimsDecision = { entityId: obj.entityId, claims };
  if (signals && signals.length > 0) decision.signals = signals;
  if (reviews.length > 0) decision.reviews = reviews;
  return decision;
}
