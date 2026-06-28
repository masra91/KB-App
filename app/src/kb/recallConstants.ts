// SPEC-0026 ASK-17/19 — the PURE recall budget constants + clamps: the interactive **time** budget
// (ASK-17) and the retrieval **tool-call** budget (F3 / dogfood #5; ASK-19 raise). Deliberately free
// of any node import (no `node:fs`/`node:path`), so the RENDERER (the "Recall & Ask" Settings card)
// can import these bounds without pulling the node-only `instanceConfig`/`recall` modules into the
// Vite bundle (the renderer→node-builtin boundary). `instanceConfig.ts` (time) and `recall.ts`
// (tool-calls) re-export these, so existing main-process import sites stay unchanged.

// --- Time budget (ASK-17): the SDK `session.idle` wall-clock a grounded query is given ---

/** Recall's interactive work budget (ASK-17): the wall-clock the SDK `session.idle` wait is given
 *  before recall stops and returns its best grounded partial. The interactive instance of the
 *  JOBS-17 work-depth knob. The shipped 60s default was too tight for a real grounded multi-hop over
 *  a large KB (1007 entities) — raised to 4min. Principal-configurable (Settings) within sane bounds:
 *  a query the human is actively waiting on should finish, but never hang unboundedly. */
export const DEFAULT_RECALL_BUDGET_MS = 240_000;
export const RECALL_BUDGET_MS_MIN = 60_000; // never below the old hard 60s
export const RECALL_BUDGET_MS_MAX = 600_000; // 10min ceiling — an interactive op must stay bounded

/** Clamp a configured recall time budget into the sane bounds (ASK-17); a non-finite value → default. */
export function clampRecallBudgetMs(v: unknown): number {
  const n = typeof v === 'number' ? v : Number.NaN;
  if (!Number.isFinite(n)) return DEFAULT_RECALL_BUDGET_MS;
  return Math.max(RECALL_BUDGET_MS_MIN, Math.min(RECALL_BUDGET_MS_MAX, n));
}

// --- Retrieval tool-call budget (F3 / dogfood #5; ASK-19): the per-question hop/tool-call ceiling ---

/** Retrieval-budget bounds (F3 / dogfood #5). The budget SCALES TO GRAPH SIZE: a tiny KB is fully
 *  traversable in a few hops, so a fixed budget just let the agent loop (the dogfood saw 12 calls
 *  + `truncated` on a ~6-node KB). Small KB → small cap; large KB → headroom up to MAX.
 *
 *  ASK-19 RAISE (Principal-reported, fresh dogfood): grounded multi-hop recall over the real KB ran
 *  out of search room before it could finish, so `BASE 2→4` (every query starts with more steps) and
 *  `MAX 16→24` (a big KB gets real headroom). The retrieval budget is now also **per-instance
 *  configurable** (an explicit override wins over this scaled default — see `recallMaxToolCalls`). */
export const RECALL_BUDGET = { MIN: 4, BASE: 4, PER_NODE: 0.5, MAX: 24 } as const;

/**
 * Scale the retrieval tool-call budget to the entity-graph size (pure; F3 / dogfood #5).
 * `clamp(MIN, BASE + ceil(PER_NODE · nodeCount), MAX)` — e.g. 0→4, 6→7, 40+→24. Entities are the
 * nodes the agent hops (claims/sources are leaves), so `nodeCount` is the entity count.
 */
export function recallBudget(nodeCount: number): number {
  const scaled = RECALL_BUDGET.BASE + Math.ceil(RECALL_BUDGET.PER_NODE * Math.max(0, nodeCount));
  return Math.min(RECALL_BUDGET.MAX, Math.max(RECALL_BUDGET.MIN, scaled));
}

/** Clamp a configured explicit retrieval tool-call override into [{@link RECALL_BUDGET.MIN},
 *  {@link RECALL_BUDGET.MAX}] (ASK-19). A non-finite value → `undefined` (no override ⇒ the scaled
 *  {@link recallBudget} default applies). Mirrors `clampCopilotCeiling`'s number|undefined contract. */
export function clampRecallMaxToolCalls(v: unknown): number | undefined {
  if (typeof v !== 'number' || !Number.isFinite(v)) return undefined;
  return Math.max(RECALL_BUDGET.MIN, Math.min(RECALL_BUDGET.MAX, Math.floor(v)));
}

/** Resolve a Settings write of the retrieval tool-call override (ASK-19), mirroring the ceiling's
 *  three-state contract (#102): `undefined` PRESERVES the prior value (preserve-on-omission), `null`
 *  CLEARS it back to the scaled default ("scale to KB size"), a number sets the clamped override. */
export function resolveRecallMaxToolCallsWrite(prior: number | undefined, incoming: number | null | undefined): number | undefined {
  if (incoming === undefined) return prior;
  if (incoming === null) return undefined;
  return clampRecallMaxToolCalls(incoming);
}

// --- Effort (SPEC-0060 VUX-11): the Ask "Quick vs Considered" depth toggle ---

/** The Ask effort level (the v3 "recall settings on Ask" IA-lock). `quick` = a fast, shallow lookup;
 *  `considered` = the full configured/graph-scaled depth (the prior default). The copilot CLI exposes
 *  ONLY `--model` (reasoning effort is model-side — see copilotModel.ts), so effort is expressed
 *  HONESTLY through recall's own depth levers — the retrieval hop budget + the interactive time budget —
 *  NOT a fake model swap (no recall-quick/-considered model exists in the catalog). */
export type RecallEffort = 'quick' | 'considered';

/** Quick's fixed shallow ceilings: the floor hop budget (a few targeted lookups) + the 60s floor time
 *  budget. A quick answer trades multi-hop depth for latency the human feels immediately. */
export const RECALL_EFFORT_QUICK = { maxToolCalls: RECALL_BUDGET.BASE, sessionBudgetMs: RECALL_BUDGET_MS_MIN } as const;

/**
 * Map an Ask effort onto concrete recall depth levers, RELATIVE to the caller's configured `considered`
 * baseline (pure; renderer-safe). `quick` forces the floor hop budget + the 60s floor time (never
 * EXCEEDING the baseline, so a tightly-configured instance stays tight); `considered`/`undefined` pass
 * the baseline through unchanged (full back-compat — a request with no effort behaves exactly as before).
 */
export function recallEffortLevers(
  effort: RecallEffort | undefined,
  base: { maxToolCalls?: number; sessionBudgetMs: number },
): { maxToolCalls?: number; sessionBudgetMs: number } {
  if (effort !== 'quick') return base; // 'considered' or undefined → the configured baseline (unchanged)
  return {
    maxToolCalls: Math.min(base.maxToolCalls ?? RECALL_BUDGET.MAX, RECALL_EFFORT_QUICK.maxToolCalls),
    sessionBudgetMs: Math.min(base.sessionBudgetMs, RECALL_EFFORT_QUICK.sessionBudgetMs),
  };
}
