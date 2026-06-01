// The Connect stage's candidate shape, agent verdict shape, and validation (SPEC-0020
// CONNECT). Connect is the FOURTH user of the SPEC-0014 harness and the first that reasons
// ACROSS items: the orchestrator does deterministic BLOCKING (group candidates by kind +
// normalized name) and the thin agent does MATCHING on ONE bounded candidate set (CONNECT-4/5).
//
// v1 SCOPE: resolver core only — block / match / merge / dedup / born-resolved nodes.
// Link-promotion ([[wikilinks]], CONNECT-12/13) is a DEFERRED later slice: it consumes
// Claims' `relatesTo` hints, which require a Connect re-pass AFTER Claims (the reorder puts
// Connect before Claims, so hints don't exist on the first pass). The agent's `links[]` field
// (SPEC-0020 §3.3) is therefore NOT parsed here yet — it lands with that slice.
import type { AgentTrace } from './archivist';
import { type SignalDecision, validSignal } from './decompose';
import { type ReviewRequest, validReviewRequests } from './reviews';

/**
 * A per-source entity CANDIDATE — Decompose's output once it stops writing `entities/`
 * (CANON-4; the DECOMP→candidates guardrail is KB-Architect's slice 2). This is Connect's
 * INPUT. Schema is KB-Architect's provisional contract (SPEC-0020 §3.1), coded against as
 * stable: `candidates/<dateShard(id)>/<id>.json`.
 */
export interface Candidate {
  id: string; // stable candidate ULID (names the file)
  sourceId: string; // the source this mention came from
  kind: string; // open vocabulary (DATA-6)
  name: string; // surface name as mentioned
  confidence: number; // 0..1 from Decompose
  mentions: string[]; // verbatim evidence spans
}

/** One resolved cluster the agent returns: candidates judged to be the same real thing. */
export interface ClusterDecision {
  canonicalName: string; // the chosen human name for the node
  memberCandidateIds: string[]; // candidate ids in this cluster (≥1)
  existingNodeId?: string; // if set, fold into this existing entities/ node (CONNECT-9)
  /**
   * Optional (CONNECT-10): additional EXISTING node ids the agent judges to be the same
   * real thing as this cluster — they are merged into the canonical (`existingNodeId`, or a
   * fresh node when absent) and their files DELETED (recoverable via git; no tombstones).
   * A faithful v1 extension of SPEC-0020 §3.5's "two existing nodes are the same thing".
   */
  mergeExistingNodeIds?: string[];
  confidence: number; // 0..1 the cluster is correct
}

/** The whole verdict returned by one disposable Connect session (SPEC-0020 §3.3). */
export interface ConnectDecision {
  blockKey: string; // echoes the candidate set's block key (kind|normalized-name)
  clusters: ClusterDecision[]; // one entry per distinct real thing in the set
  reviews?: ReviewRequest[]; // ambiguous merges → park (CONNECT-15)
  signals?: SignalDecision[]; // audit-log-only escape hatch (CONNECT-18)
  /** Provenance of the decision itself (ORCH-16), filled by the decider. */
  agent?: AgentTrace;
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.trim().length > 0;
}

function validConfidence(v: unknown, ctx: string): number {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 1) {
    throw new Error(`connect: ${ctx} confidence must be a number in [0,1], got ${JSON.stringify(v)}`);
  }
  return v;
}

function validStringArray(v: unknown, ctx: string): string[] {
  if (!Array.isArray(v) || v.length === 0) throw new Error(`connect: ${ctx} must be a non-empty array`);
  return v.map((m, i) => {
    if (!isNonEmptyString(m)) throw new Error(`connect: ${ctx}[${i}] must be a non-empty string`);
    return m;
  });
}

// ── Candidate validation (Connect's input; KB-Architect's provisional schema) ─────────────

/** Parse + validate one candidate JSON object; throws on a bad shape (skip, don't crash). */
export function validCandidate(v: unknown): Candidate {
  if (typeof v !== 'object' || v === null) throw new Error('connect: candidate must be an object');
  const o = v as Record<string, unknown>;
  if (!isNonEmptyString(o.id)) throw new Error('connect: candidate.id must be a non-empty string');
  if (!isNonEmptyString(o.sourceId)) throw new Error('connect: candidate.sourceId must be a non-empty string');
  if (!isNonEmptyString(o.kind)) throw new Error('connect: candidate.kind must be a non-empty string');
  if (!isNonEmptyString(o.name)) throw new Error('connect: candidate.name must be a non-empty string');
  return {
    id: o.id,
    sourceId: o.sourceId,
    kind: o.kind,
    name: o.name,
    confidence: validConfidence(o.confidence, 'candidate'),
    mentions: validStringArray(o.mentions, 'candidate.mentions'),
  };
}

// ── Blocking (deterministic; the orchestrator's job, CONNECT-4) ────────────────────────────

/**
 * Normalize a name for blocking: lowercase, trim, collapse internal whitespace, strip
 * surrounding punctuation. Deliberately LOOSE (recall-first): it over-groups cheaply and the
 * agent splits false positives (SPEC-0020 §3.2). Not for display — display name is the
 * agent's `canonicalName`.
 */
export function normalizeName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ') // punctuation → space
    .replace(/\s+/g, ' ')
    .trim();
}

/** The block key groups candidates (and existing nodes) that MIGHT be the same thing. */
export function blockKey(kind: string, name: string): string {
  return `${kind.trim().toLowerCase()}|${normalizeName(name)}`;
}

// ── Verdict validation (the agent's output, CONNECT-14) ────────────────────────────────────

function validCluster(v: unknown, i: number): ClusterDecision {
  if (typeof v !== 'object' || v === null) throw new Error(`connect: clusters[${i}] must be an object`);
  const o = v as Record<string, unknown>;
  if (!isNonEmptyString(o.canonicalName)) throw new Error(`connect: clusters[${i}].canonicalName must be a non-empty string`);
  const cluster: ClusterDecision = {
    canonicalName: o.canonicalName,
    memberCandidateIds: validStringArray(o.memberCandidateIds, `clusters[${i}].memberCandidateIds`),
    confidence: validConfidence(o.confidence, `clusters[${i}]`),
  };
  if (o.existingNodeId !== undefined) {
    if (!isNonEmptyString(o.existingNodeId)) throw new Error(`connect: clusters[${i}].existingNodeId must be a non-empty string when present`);
    cluster.existingNodeId = o.existingNodeId;
  }
  if (o.mergeExistingNodeIds !== undefined) {
    if (!Array.isArray(o.mergeExistingNodeIds) || !o.mergeExistingNodeIds.every(isNonEmptyString)) {
      throw new Error(`connect: clusters[${i}].mergeExistingNodeIds must be an array of non-empty strings when present`);
    }
    if (o.mergeExistingNodeIds.length > 0) cluster.mergeExistingNodeIds = o.mergeExistingNodeIds as string[];
  }
  return cluster;
}

/**
 * Parse + validate one session's stdout into a ConnectDecision (CONNECT-14). Tolerates
 * surrounding prose/markdown by extracting the first JSON object. Throws on anything off —
 * the stage treats a throw as a failed attempt (retry, then set aside; ORCH-12) and NEVER
 * fabricates a resolution, so a bad session can't conflate or duplicate nodes.
 *
 * Validates that every clustered candidate id belongs to `allowedCandidateIds` (when given)
 * and that the verdict covers each member exactly once — guarding against a stale/confused
 * session resolving candidates outside its set or dropping/duplicating members.
 *
 * @param expectedBlockKey if given, the verdict's blockKey must match (stale-session guard).
 * @param allowedCandidateIds if given, every memberCandidateId must be in this set, and every
 *   id in the set must be covered by exactly one cluster.
 */
export function parseConnectDecision(
  stdout: string,
  expectedBlockKey?: string,
  allowedCandidateIds?: readonly string[],
): ConnectDecision {
  const match = stdout.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('connect: no JSON object in output');
  const obj = JSON.parse(match[0]) as Record<string, unknown>;

  if (!isNonEmptyString(obj.blockKey)) throw new Error('connect: missing blockKey');
  if (expectedBlockKey && obj.blockKey !== expectedBlockKey) {
    throw new Error(`connect: blockKey mismatch (got ${obj.blockKey}, expected ${expectedBlockKey})`);
  }
  if (!Array.isArray(obj.clusters) || obj.clusters.length === 0) {
    throw new Error('connect: clusters must be a non-empty array');
  }
  const clusters = obj.clusters.map((c, i) => validCluster(c, i));

  // Coverage check: each clustered id is allowed, and the partition is exact (no drops/dupes).
  if (allowedCandidateIds) {
    const allowed = new Set(allowedCandidateIds);
    const seen = new Set<string>();
    for (const cl of clusters) {
      for (const id of cl.memberCandidateIds) {
        if (!allowed.has(id)) throw new Error(`connect: cluster references unknown candidate id ${id}`);
        if (seen.has(id)) throw new Error(`connect: candidate id ${id} appears in more than one cluster`);
        seen.add(id);
      }
    }
    if (seen.size !== allowed.size) {
      throw new Error(`connect: verdict covers ${seen.size} of ${allowed.size} candidates (must partition all)`);
    }
  }

  const decision: ConnectDecision = { blockKey: obj.blockKey, clusters };
  if (obj.signals !== undefined) {
    if (!Array.isArray(obj.signals)) throw new Error('connect: signals must be an array when present');
    const signals = obj.signals.map((s, i) => validSignal(s, i));
    if (signals.length > 0) decision.signals = signals;
  }
  const reviews = validReviewRequests(obj.reviews); // [] when absent (REVIEW-14)
  if (reviews.length > 0) decision.reviews = reviews;
  return decision;
}
