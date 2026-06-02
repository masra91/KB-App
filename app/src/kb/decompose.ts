// The Decompose stage's decision shape + validation (SPEC-0015 DECOMP). The thin agent
// reads ONE source and returns this decision; the orchestrator does all effects (DECOMP-3).
//
// Two vocabularies here are OPEN and EMERGENT (DATA-6 / DECOMP-7,10): entity `kind` and
// signal `type` are validated ONLY as non-empty strings — never against an allow-list. The
// base sets are PROSE guidance in the prompt template (buildDecomposePrompt), never gated
// in code, so the taxonomy can grow from the material itself.
import type { AgentTrace } from './archivist';

/** One entity node the source mentions. `kind` is an open string (DECOMP-7). */
export interface EntityDecision {
  kind: string; // open vocabulary — non-empty only (DATA-6)
  name: string;
  confidence: number; // 0..1 calibrated belief this is a real, distinct entity (DATA-7)
  mentions: string[]; // verbatim evidence spans from the source (DATA-7)
}

/**
 * An agent signal (DECOMP-9): a typed freeform property-bag put ON THE RECORD that is NOT
 * an entity. Routed to the AUDIT LOG ONLY by the orchestrator — never into the KB. `type`
 * is an open vocabulary (DECOMP-10).
 */
export interface SignalDecision {
  type: string; // open vocabulary — non-empty only
  note: string; // freeform payload (required); for a `research-request` signal this is the *why*
  refs?: string[]; // optional: entity names / mentions this is about
  // Research-request fields (SPEC-0028 RESEARCH-3 / D1) — present only when `type` is
  // 'research-request' (the async signal a stage emits to ask researchers to learn more):
  what?: string; // the term/topic to research
  context?: string; // surrounding text the request rests on (the only KB material egress may use, D6a)
}

/** The whole decision returned by one disposable Decompose session. */
export interface DecomposeDecision {
  sourceId: string;
  entities: EntityDecision[];
  signals?: SignalDecision[];
  /** Provenance of the decision itself (ORCH-16), filled by the decider. */
  agent?: AgentTrace;
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.trim().length > 0;
}

/** Coerce a confidence to a number in [0,1]; throw if absent/out of range. */
function validConfidence(v: unknown): number {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 1) {
    throw new Error(`decompose: confidence must be a number in [0,1], got ${JSON.stringify(v)}`);
  }
  return v;
}

function validMentions(v: unknown): string[] {
  if (!Array.isArray(v)) throw new Error('decompose: entity.mentions must be an array');
  return v.map((m, i) => {
    if (!isNonEmptyString(m)) throw new Error(`decompose: entity.mentions[${i}] must be a non-empty string`);
    return m;
  });
}

function validEntity(v: unknown, i: number): EntityDecision {
  if (typeof v !== 'object' || v === null) throw new Error(`decompose: entities[${i}] must be an object`);
  const o = v as Record<string, unknown>;
  // kind: OPEN vocabulary — only "non-empty string" is enforced (DECOMP-7). NEVER allow-list.
  if (!isNonEmptyString(o.kind)) throw new Error(`decompose: entities[${i}].kind must be a non-empty string`);
  if (!isNonEmptyString(o.name)) throw new Error(`decompose: entities[${i}].name must be a non-empty string`);
  return {
    kind: o.kind,
    name: o.name,
    confidence: validConfidence(o.confidence),
    mentions: validMentions(o.mentions),
  };
}

export function validSignal(v: unknown, i: number): SignalDecision {
  if (typeof v !== 'object' || v === null) throw new Error(`decompose: signals[${i}] must be an object`);
  const o = v as Record<string, unknown>;
  // type: OPEN vocabulary — only "non-empty string" is enforced (DECOMP-10). NEVER allow-list.
  if (!isNonEmptyString(o.type)) throw new Error(`decompose: signals[${i}].type must be a non-empty string`);
  if (!isNonEmptyString(o.note)) throw new Error(`decompose: signals[${i}].note must be a non-empty string`);
  const sig: SignalDecision = { type: o.type, note: o.note };
  if (o.refs !== undefined) {
    if (!Array.isArray(o.refs) || !o.refs.every(isNonEmptyString)) {
      throw new Error(`decompose: signals[${i}].refs must be an array of non-empty strings`);
    }
    sig.refs = o.refs as string[];
  }
  // Research-request fields (SPEC-0028 RESEARCH-3 / D1) — optional, carried through verbatim. `what`
  // is the only field a downstream researcher dispatches on; `context` is the bounded KB material
  // egress may use (D6a). Validated as non-empty strings when present; never allow-listed.
  if (o.what !== undefined) {
    if (!isNonEmptyString(o.what)) throw new Error(`decompose: signals[${i}].what must be a non-empty string`);
    sig.what = o.what;
  }
  if (o.context !== undefined) {
    if (typeof o.context !== 'string') throw new Error(`decompose: signals[${i}].context must be a string`);
    sig.context = o.context;
  }
  return sig;
}

/**
 * Parse + validate one session's stdout into a DecomposeDecision (DECOMP-6). Tolerates
 * surrounding prose/markdown by extracting the first JSON object. Throws on anything off —
 * the orchestrator treats a throw as a failed attempt (retry, then set aside; ORCH-12) and
 * NEVER fabricates entities, so a bad session can't pollute the graph.
 *
 * @param expectedSourceId if given, the decision's sourceId must match (guards against a
 *   stale/confused session decomposing the wrong item).
 */
export function parseDecomposeDecision(stdout: string, expectedSourceId?: string): DecomposeDecision {
  const match = stdout.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('decompose: no JSON object in output');
  const obj = JSON.parse(match[0]) as Record<string, unknown>;

  if (!isNonEmptyString(obj.sourceId)) throw new Error('decompose: missing sourceId');
  if (expectedSourceId && obj.sourceId !== expectedSourceId) {
    throw new Error(`decompose: sourceId mismatch (got ${obj.sourceId}, expected ${expectedSourceId})`);
  }
  if (!Array.isArray(obj.entities)) throw new Error('decompose: entities must be an array');

  const entities = obj.entities.map((e, i) => validEntity(e, i));
  let signals: SignalDecision[] | undefined;
  if (obj.signals !== undefined) {
    if (!Array.isArray(obj.signals)) throw new Error('decompose: signals must be an array when present');
    signals = obj.signals.map((s, i) => validSignal(s, i));
  }

  const decision: DecomposeDecision = { sourceId: obj.sourceId, entities };
  if (signals && signals.length > 0) decision.signals = signals;
  return decision;
}
