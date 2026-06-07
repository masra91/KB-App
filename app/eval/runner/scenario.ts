// SPEC-0042 EVAL Slice-1 — scenario schema + types (EVAL-1). A scenario is DECLARATIVE DATA (YAML/JSON)
// describing a seeded-KB cognition eval: a seed, an ordered script of the KB's REAL verbs, and the
// expectations to score. This module is PURE + fork-independent (no pipeline, no I/O) — the loader reads
// YAML and hands the parsed object here for schema validation; a malformed scenario fails FAST with a
// clear error, never a partial run (EVAL-1). Generalizes today's hand-wired eval/ fixtures.

/** The capability a scenario primarily exercises (its `meta` tag). */
export const EVAL_CAPABILITIES = ['ingest', 'decompose', 'connect', 'claims', 'recall', 'research', 'reflect', 'jobs'] as const;
export type EvalCapability = (typeof EVAL_CAPABILITIES)[number];

/** How the clean-world KB is seeded before the action script runs. */
export type SeedSpec =
  | { kind: 'empty' }
  | { kind: 'files'; ref: string } // a fixtures dir of vault files
  | { kind: 'snapshot'; ref: string }; // a restorable KB snapshot

/**
 * One action = a single-key object naming a REAL KB verb + its args (EVAL-1). Kept as a discriminated
 * union so the action driver (actions.ts) maps each to the real pipeline exhaustively. Slice-1 wires
 * ingest/awaitDrain/ask (+ stubs for runJob/dispatchResearcher/setConfig, filled per their slices).
 */
export type ScenarioAction =
  | { ingest: { text?: string; files?: string[]; id?: string } }
  | { awaitDrain: { stages: Array<'decompose' | 'connect' | 'claims'> } }
  | { ask: { query: string } }
  | { runJob: { id: string } }
  | { dispatchResearcher: { id: string } }
  | { setConfig: Record<string, unknown> };

/** A named deterministic check + its params (EVAL-3) — resolved against the validator library. */
export interface DeterministicCheck {
  check: string; // e.g. 'entitiesInclude' | 'entitiesExclude' | 'claimCitations' | 'recallCites'
  args?: unknown;
}

/** An agent-judge check (EVAL-4) — DEFERRED to Slice-2; typed here so the schema is forward-stable. */
export interface JudgeCheck {
  rubric: string;
  runs?: number;
  threshold?: number;
}

export interface ScenarioExpect {
  deterministic?: DeterministicCheck[];
  judge?: JudgeCheck[]; // Slice-2
}

/** A config variant for the matrix (EVAL-7) — DEFERRED to Slice-2; typed for forward-stability. */
export interface ScenarioVariant {
  model?: string;
  promptVersion?: string;
  toolConfig?: Record<string, unknown>;
  budget?: Record<string, unknown>;
}

export interface Scenario {
  id: string;
  capability: EvalCapability;
  seed: SeedSpec;
  actions: ScenarioAction[];
  expect: ScenarioExpect;
  variants?: ScenarioVariant[];
  meta?: Record<string, unknown>;
}

/** The single verb key an action object must carry. */
const ACTION_VERBS = ['ingest', 'awaitDrain', 'ask', 'runJob', 'dispatchResearcher', 'setConfig'] as const;

/** Validation outcome — fail-fast with a precise error (EVAL-1), never a partial scenario. */
export type ScenarioParse = { ok: true; scenario: Scenario } | { ok: false; error: string };

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Validate an already-parsed (YAML/JSON) value into a typed Scenario, or return a clear error (EVAL-1). */
export function validateScenario(raw: unknown): ScenarioParse {
  if (!isObj(raw)) return { ok: false, error: 'scenario must be a mapping' };
  if (typeof raw.id !== 'string' || !raw.id.trim()) return { ok: false, error: 'scenario.id must be a non-empty string' };
  if (!EVAL_CAPABILITIES.includes(raw.capability as EvalCapability)) {
    return { ok: false, error: `scenario.capability must be one of ${EVAL_CAPABILITIES.join('|')} (got ${JSON.stringify(raw.capability)})` };
  }
  const seed = raw.seed;
  if (!isObj(seed) || (seed.kind !== 'empty' && seed.kind !== 'files' && seed.kind !== 'snapshot')) {
    return { ok: false, error: "scenario.seed.kind must be 'empty' | 'files' | 'snapshot'" };
  }
  if ((seed.kind === 'files' || seed.kind === 'snapshot') && typeof seed.ref !== 'string') {
    return { ok: false, error: `scenario.seed.ref is required for kind '${seed.kind}'` };
  }
  if (!Array.isArray(raw.actions) || raw.actions.length === 0) return { ok: false, error: 'scenario.actions must be a non-empty list' };
  for (let i = 0; i < raw.actions.length; i++) {
    const a = raw.actions[i];
    if (!isObj(a)) return { ok: false, error: `actions[${i}] must be a mapping` };
    const keys = Object.keys(a);
    if (keys.length !== 1) return { ok: false, error: `actions[${i}] must have exactly one verb key (got ${keys.join(', ') || 'none'})` };
    if (!ACTION_VERBS.includes(keys[0] as (typeof ACTION_VERBS)[number])) {
      return { ok: false, error: `actions[${i}] unknown verb '${keys[0]}' (allowed: ${ACTION_VERBS.join('|')})` };
    }
  }
  if (!isObj(raw.expect)) return { ok: false, error: 'scenario.expect must be a mapping' };
  const det = (raw.expect as Record<string, unknown>).deterministic;
  if (det !== undefined && !Array.isArray(det)) return { ok: false, error: 'scenario.expect.deterministic must be a list' };
  if (Array.isArray(det)) {
    for (let i = 0; i < det.length; i++) {
      if (!isObj(det[i]) || typeof (det[i] as Record<string, unknown>).check !== 'string') {
        return { ok: false, error: `expect.deterministic[${i}] must have a string 'check' name` };
      }
    }
  }
  return { ok: true, scenario: raw as unknown as Scenario };
}
