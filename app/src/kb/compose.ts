// Compose (SPEC-0046) — the types + the grounding validator for the encyclopedic-prose layer.
// Pure: no I/O, no agent. The Compose AGENT (composeAgent.ts) produces a ComposeDecision; the
// STAGE (composeStage.ts) reads the entity's cited claims and renders the prose (composeDoc.ts).
//
// Grounding is the non-negotiable (SPEC-0046 §3 / COMPOSE-3): the prose is **synthesis, not
// generation** — every sentence is composed ONLY from the entity's existing cited claims, and every
// sentence MUST carry at least one citation into those claims. We enforce that structurally: the
// agent returns sentences each tagged with the claim index/indices it draws on, so an un-grounded
// sentence (no citation, or a citation to a claim that doesn't exist) is a *parse-time* defect —
// rejected like any failed attempt, after which the stage's deterministic fallback (the structured
// blocks alone — today's behaviour) keeps the page from ever hard-failing (COMPOSE-7).
import type { AgentTrace } from './archivist';

/**
 * A claim presented to Compose as evidence — the ONLY material it may synthesize from (COMPOSE-3).
 * The claims are presented to the agent numbered 1..N (1-based) in array order; a sentence cites a
 * claim by that number.
 */
export interface CitedClaim {
  /** The claim's statement (the substance). */
  statement: string;
  /** The source DIR this claim derives from (`sources/<shard>/<ULID>`) — its provenance. */
  sourceRel: string;
  /** The source's human title (`deriveSourceTitle`) — for the References section; NEVER a ULID
   *  (COMPOSE-2/8, PRIN-24). */
  title: string;
}

/** One composed sentence + the claim(s) it is grounded in (1-based indices into the CitedClaim[]
 *  the agent was given). An empty `claims` is a grounding DEFECT (COMPOSE-3). The text may carry
 *  woven `[[Entity]]` links (COMPOSE-4); it must NOT carry its own `[^n]` markers — Compose renders
 *  those deterministically from `claims` so the citations always trace to a real source. */
export interface ComposeSentence {
  text: string;
  claims: number[];
}

/** A prose section: an optional `## heading` + its sentences. The first section is typically the
 *  lede and has no heading. */
export interface ComposeSection {
  heading?: string;
  sentences: ComposeSentence[];
}

/** The Compose agent's decision for one entity (the ORCH-21 seam's output). */
export interface ComposeDecision {
  entityId: string;
  sections: ComposeSection[];
  /** Truthful agent trace (ORCH-16); stamped by the decider. */
  agent?: AgentTrace;
}

/**
 * Validate the grounding invariants on a decision (COMPOSE-3) against the number of claims the
 * agent was given. Returns a list of human-readable defects — empty means grounded. Pure.
 *
 * Invariants:
 *  - there is at least one sentence (an entity reaching Compose has ≥1 claim, so it must yield prose);
 *  - every sentence has non-empty text;
 *  - every sentence cites at least one claim (an un-cited sentence is an un-grounded statement);
 *  - every citation is an in-range 1-based claim index (no citing a claim that doesn't exist).
 */
export function validateGrounding(decision: ComposeDecision, claimCount: number): string[] {
  const errors: string[] = [];
  const sections = decision.sections;
  if (!Array.isArray(sections) || sections.length === 0) {
    errors.push('no sections — Compose must produce a prose body when the entity has claims');
    return errors;
  }
  let sentenceCount = 0;
  sections.forEach((section, si) => {
    if (!Array.isArray(section.sentences) || section.sentences.length === 0) {
      errors.push(`section ${si} ("${section.heading ?? 'lede'}") has no sentences`);
      return;
    }
    section.sentences.forEach((s, idx) => {
      sentenceCount += 1;
      const where = `section ${si} sentence ${idx}`;
      if (typeof s.text !== 'string' || s.text.trim().length === 0) {
        errors.push(`${where}: empty sentence text`);
      }
      if (!Array.isArray(s.claims) || s.claims.length === 0) {
        // The core grounding defect: a sentence with no citation (COMPOSE-3).
        errors.push(`${where}: un-cited sentence (no claim) — un-grounded prose is a defect`);
        return;
      }
      for (const n of s.claims) {
        if (!Number.isInteger(n) || n < 1 || n > claimCount) {
          errors.push(`${where}: citation [${n}] is out of range (1..${claimCount})`);
        }
      }
    });
  });
  if (sentenceCount === 0) errors.push('no sentences in any section');
  return errors;
}

/** Extract the first balanced top-level JSON object from agent stdout (copilot may wrap it in
 *  prose/markdown fences). Returns the substring or null. Mirrors the other stages' parse seam. */
export function firstJsonObject(stdout: string): string | null {
  const start = stdout.indexOf('{');
  if (start === -1) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < stdout.length; i++) {
    const ch = stdout[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return stdout.slice(start, i + 1);
    }
  }
  return null;
}

/** Strip leading markdown heading hashes from a model-provided heading STRING. The agent is asked to
 *  return BARE heading text, but intermittently returns e.g. `"## Family"`; composeDoc prepends its own
 *  `## `, so an un-stripped value renders as `## ## Family`. Repeats the prefix so a doubled `"## ## X"`
 *  collapses to `"X"` too. Returns trimmed bare text. */
export function stripLeadingHashes(s: string): string {
  return s.trim().replace(/^(?:#+\s*)+/, '').trim();
}

/**
 * Parse + validate the Compose agent's raw output into a grounded ComposeDecision (the ORCH-21
 * parse seam). Throws on malformed JSON, a shape mismatch, OR a grounding defect — so the stage
 * treats un-grounded prose exactly like a failed attempt (retry, then the deterministic fallback).
 */
export function parseComposeDecision(stdout: string, entityId: string, claimCount: number): ComposeDecision {
  const json = firstJsonObject(stdout);
  if (!json) throw new Error('compose: no JSON object in agent output');
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch (e) {
    throw new Error(`compose: agent output is not valid JSON (${(e as Error).message})`);
  }
  if (typeof raw !== 'object' || raw === null) throw new Error('compose: agent output is not an object');
  const obj = raw as Record<string, unknown>;
  const rawSections = obj.sections;
  if (!Array.isArray(rawSections)) throw new Error('compose: `sections` must be an array');

  const sections: ComposeSection[] = rawSections.map((sec, si) => {
    if (typeof sec !== 'object' || sec === null) throw new Error(`compose: section ${si} is not an object`);
    const s = sec as Record<string, unknown>;
    const heading = s.heading === undefined || s.heading === null ? undefined : stripLeadingHashes(String(s.heading)) || undefined;
    const rawSentences = s.sentences;
    if (!Array.isArray(rawSentences)) throw new Error(`compose: section ${si} `+'`sentences` must be an array');
    const sentences: ComposeSentence[] = rawSentences.map((sn, ni) => {
      if (typeof sn !== 'object' || sn === null) throw new Error(`compose: section ${si} sentence ${ni} is not an object`);
      const o = sn as Record<string, unknown>;
      const text = typeof o.text === 'string' ? o.text.trim() : '';
      const claimsRaw = Array.isArray(o.claims) ? o.claims : [];
      const claims = claimsRaw.map((n) => Number(n)).filter((n) => Number.isFinite(n));
      return { text, claims };
    });
    return { heading, sentences };
  });

  const decision: ComposeDecision = { entityId, sections };
  const errors = validateGrounding(decision, claimCount);
  if (errors.length > 0) {
    throw new Error(`compose: un-grounded output (${errors.length} defect(s)): ${errors.slice(0, 3).join('; ')}`);
  }
  return decision;
}
