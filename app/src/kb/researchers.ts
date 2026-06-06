// Researchers — shared types + pure helpers (SPEC-0028 RESEARCH). The KB's EXTERNAL enrichment: a
// parallel registry of Principal-configured agents (generic core = prompt + tools/MCP + egress tier
// + budget + scope) that reach OUTSIDE the KB to corroborate and expand (RESEARCH-1). This module
// owns the data contracts + pure logic the framework shares; I/O lives in `researcherRegistry.ts`,
// routing in `researchDispatcher.ts`, and per-template cognition behind the agent seam.
//
// LOCKED v1 posture (SPEC-0028 §8): the dispatcher is the sole router (D5); a `research-request` is
// a signal ANY producer emits (D1); egress is least-privilege (D6a — Slice-1 Web builds queries
// ONLY from the explicit request, never arbitrary KB content); findings default to a cited note
// (D4). Scheduled researchers reuse the SPEC-0023 JOBS scheduler (D5) — so we reuse its posture +
// schedule vocab here rather than re-inventing it.
import type { SchedulePreset, AutonomyPosture } from './jobs';

/**
 * Egress tier (RESEARCH-8) — where a researcher's traffic may go, and (later) the max KB-content
 * sensitivity the dispatcher may feed it. Ordered least→most trusted DESTINATION:
 * `public-web` (open internet) < `internal-tenant` (the org's M365 tenant) < `local-only` (never
 * leaves the machine). NB: the concrete tier↔sensitivity mapping is escalated to the Principal
 * (SPEC-0028 D6, governs Slices 2/3); Slice 1 (Web) gates by request-only egress (D6a), not tier.
 */
export const EGRESS_TIERS = ['public-web', 'internal-tenant', 'local-only'] as const;
export type EgressTier = (typeof EGRESS_TIERS)[number];

/** Built-in templates over the generic core (RESEARCH-1/16). Slice 1 ships `web`; `code`/`m365`
 *  land in Slices 2/3; `custom` is the bare generic core (own prompt + MCP + tools). */
export const RESEARCHER_TEMPLATES = ['web', 'code', 'm365', 'custom'] as const;
export type ResearcherTemplate = (typeof RESEARCHER_TEMPLATES)[number];

/** Default egress tier per built-in template (RESEARCH-4 §4). `custom` declares its own. */
export const TEMPLATE_DEFAULT_EGRESS: Record<Exclude<ResearcherTemplate, 'custom'>, EgressTier> = {
  web: 'public-web',
  code: 'local-only',
  m365: 'internal-tenant',
};

/**
 * Per-researcher bounds (RESEARCH-11). `maxToolCalls` caps one pass (the SDK loop's retrieval
 * budget, mirroring Recall); `maxDepth` bounds research→finding→`research-request` chains before
 * the researcher escalates to Review ("continue?"); both sit under a global per-Instance ceiling
 * (the hard backstop, enforced by the dispatcher, see RESEARCH_GLOBAL_CEILING).
 */
export interface ResearcherBudget {
  /** Max tool/retrieval calls in a single research pass. */
  maxToolCalls: number;
  /** Max research→finding→request chain depth before escalate-to-Review. */
  maxDepth: number;
}

// Default per-pass retrieval budget. `maxToolCalls` raised 8 → 15 (RESEARCH-17): the live test showed
// 8 fetches yield only a thin précis — the secondary source (and the claims Decompose derives from it)
// needs more reads to reach genuine depth. User-editable per researcher (RESEARCH-15), and the Principal
// expects to push it past 15; the global per-Instance ceiling (RESEARCH_INSTANCE_CEILING) still backstops
// total egress regardless of per-researcher budgets.
export const DEFAULT_RESEARCHER_BUDGET: ResearcherBudget = { maxToolCalls: 15, maxDepth: 2 };

// Per-pass session timeout for the live SDK research session (the `sendAndWait` idle wait). This is a
// STUCK-SESSION BACKSTOP, not a cost bound: the agent bills tokens/tools — bounded by `maxToolCalls`
// (RESEARCH-11) and the global per-Instance egress ceiling — never wall-clock time, so a clock-based
// cap can only ever be a guess at "too long for real work." We make it generous (15 min, vs the SDK's
// 60s default) so a legitimately deep multi-fetch pass never false-fails, and finite ONLY so a wedged
// session eventually releases the one global copilot slot it holds for its lifetime (ORCH-23) instead
// of starving the pipeline. User-editable per researcher (RESEARCH-15), alongside the budget.
export const DEFAULT_RESEARCH_SESSION_TIMEOUT_MS = 15 * 60_000;

/** Per-DISPATCH burst cap: total researcher passes one `dispatchResearch` fan-out will run, across all
 *  researchers, regardless of per-researcher budgets (RESEARCH-11). Bounds a single inline sweep's burst;
 *  the cross-dispatch/standing backstop is {@link RESEARCH_INSTANCE_CEILING}. */
export const RESEARCH_GLOBAL_CEILING = 24;

/**
 * The **global per-Instance egress ceiling** (RESEARCH-11) — the cross-researcher HARD backstop on the
 * total number of research passes (external egress) this Instance performs in a rolling window, layered
 * ON TOP of per-researcher budgets + the per-dispatch burst cap. It catches a runaway the per-dispatch
 * cap can't: passes accumulating across ticks/standing schedules over time. Enforced at the single pass
 * chokepoint (`runResearcher`), so it bounds inline dispatch AND scheduled standing passes alike. It is
 * a **safety backstop, not a normal-use limit**, and **self-healing** — passes age out of the window, so
 * capacity returns automatically. The default is **tunable** (KB-PM ratified). NB: purely a runaway/
 * volume backstop — the egress-tier ↔ content-sensitivity policy is a separate Principal item (D6), not
 * conflated here. */
export const RESEARCH_INSTANCE_CEILING = 100;
/** The rolling window the per-Instance ceiling counts passes over (24h). Tunable with the ceiling. */
export const RESEARCH_INSTANCE_WINDOW_MS = 24 * 60 * 60 * 1000;

/** Max researchers a single `research-request` may fan out to (RESEARCH-4 max-fan-out). */
export const DEFAULT_MAX_FANOUT = 4;

/**
 * One registered researcher — the generic core (RESEARCH-1). `template` selects built-in behavior +
 * its typed config; `egressTier` + `scope` gate eligibility (RESEARCH-8); `schedule`/`posture` reuse
 * the JOBS vocab for the scheduled-as-a-job path (D5). `enabled:false` is inert. `topics` is the
 * deterministic pre-filter hint (D3) so the dispatcher narrows the eligible set before any paid
 * self-nomination check.
 */
export interface ResearcherConfig {
  id: string;
  template: ResearcherTemplate;
  /** Human label (Researchers view); defaults to the template name. */
  label?: string;
  /** The researcher's standing prompt / instruction (its system message). */
  prompt: string;
  /** Where its traffic may go (RESEARCH-8). */
  egressTier: EgressTier;
  /** Declared scope — which KB scope(s) it serves; `global` in v1 (sensitivity hardcoded). */
  scope: string;
  /** Bounds (RESEARCH-11). */
  budget: ResearcherBudget;
  /** Cadence for the scheduled path (reuses JOBS presets; `off` = inline/on-demand only). */
  schedule: SchedulePreset;
  /** Autonomy posture (reuses JOBS posture; guarded = findings route to Review by default). */
  posture: AutonomyPosture;
  enabled: boolean;
  /** Deterministic eligibility hint (D3): topic tokens this researcher cares about. Empty = no
   *  topic pre-filter (relies on egress/scope + self-nomination only). */
  topics?: string[];
  /** Per-researcher tool/MCP allowlist (RESEARCH-12 defense-in-depth). Template provides defaults. */
  allowedTools?: string[];
  /** Template-specific typed config (allowed domains, repo path, M365 surfaces, …). */
  config?: Record<string, unknown>;
}

/**
 * Citation-rich provenance stamped on a secondary source a researcher produces (RESEARCH-6): which
 * researcher, the request it answered, the outbound query, the external origin(s)/URL(s) it rests
 * on, and when. Findings are marked externally-sourced (RESEARCH-12). Carried on the capture meta so
 * it lands in the secondary source's `source.md` and re-enters the pipeline cited.
 */
export interface ResearchProvenance {
  researcherId: string;
  requestId: string;
  /** The outbound query/term actually researched (built from the request only, D6a). */
  query: string;
  /** External sources the finding cites (URLs / external refs) — RESEARCH-6. */
  citations: string[];
  /** ISO timestamp the external fetch happened. */
  fetchedAt: string;
}

/** The signal type a producer emits to request research (D1). Carried on the existing `signals[]`. */
export const RESEARCH_REQUEST_SIGNAL = 'research-request';

/**
 * A `research-request` (RESEARCH-3, D1) — emitted as a `signals[]` entry by ANY producer (a pipeline
 * stage that hit an unknown term, or Reflect). Async + non-blocking: the producer never waits on the
 * network. The dispatcher routes it. `context` is the surrounding text the request rests on — and in
 * Slice 1 it is the ONLY KB-derived material a Web researcher may use to build outbound queries
 * (D6a least-privilege egress).
 */
export interface ResearchRequest {
  /** Stable id for this request (ULID). */
  id: string;
  /** ISO timestamp emitted. */
  ts: string;
  /** Who asked + what it's about. */
  by: { stage: string; sourceId?: string; entityId?: string };
  /** The term/topic to learn about. */
  what: string;
  /** Why it's worth researching (the producer's rationale). */
  why: string;
  /** Surrounding context the request rests on (the ONLY KB material egress may use in Slice 1). */
  context: string;
  /** Optional hint at which egress tier should handle it (advisory; the filter still decides). */
  egressHint?: EgressTier;
  /** Coalescing key so the same request doesn't fan out repeatedly (D2). */
  dedupKey: string;
  /**
   * Chain depth of this request (RESEARCH-11 depth limit). A request born from a PRIMARY source is
   * depth 1; one born from a research-produced (`origin:'secondary'`) finding is one deeper than that
   * finding's own chain, and so on (research→finding→`research-request`→research…). Stamped at
   * creation — by `collectResearchRequests` (from audit lineage) for inline requests, `1` for a
   * scheduler standing pass — and ENFORCED by the dispatcher against the running researcher's
   * `budget.maxDepth` (over-depth → escalate-to-Review, no egress). Absent ⇒ treated as `1`.
   */
  depth?: number;
}

/** Normalize a string for dedup/topic matching: lowercase, collapse whitespace, trim. */
export function normalizeTerm(s: string): string {
  return s.toLowerCase().replace(/\s+/g, ' ').trim();
}

/**
 * The outbound topic a researcher researches when no explicit per-request `what` exists — i.e. a
 * standing/scheduled pass or a Control-Panel "Run now" (WS1 #6). Falls back topic → label → **id**,
 * NEVER to `template`: the template is a generic kind word ("code"/"web"), so the old `?? r.template`
 * default degenerated the query (and the run-now confirm) to "code" instead of the researcher's real
 * name. The `id` is the slugified name the Principal gave it, so it's a meaningful query + label.
 */
export function researchWhatFor(r: Pick<ResearcherConfig, 'topics' | 'label' | 'id'>): string {
  return r.topics?.[0] ?? r.label ?? r.id;
}

/**
 * Deterministic dedup key for a request (D2): the normalized `what` + the subject it's about
 * (entity preferred, else source, else none). Two requests about the same term+subject collapse, so
 * a busy Decompose can't fan the same research out repeatedly.
 */
export function dedupKeyFor(input: { what: string; by: { sourceId?: string; entityId?: string } }): string {
  const subject = input.by.entityId ?? input.by.sourceId ?? '';
  const what = normalizeTerm(input.what);
  return subject ? `${what}::${subject}` : what;
}

/**
 * A researcher `id` MUST be a bare slug — it is consumed directly into filesystem paths (the
 * per-researcher journal `.kb/researchers/<id>/…`, and the scheduled-as-a-job worktree/branch via
 * the JOBS engine). A separator or `..` would escape the working zone and turn a hand-/foreign-edited
 * registry into an arbitrary-write vector — the same class as JOBS-10 / #29. Validate at every
 * boundary an id enters (registry read + write + run sink). Mirrors `isSafeJobId`.
 */
export function isSafeResearcherId(v: unknown): v is string {
  return typeof v === 'string' && /^[a-z0-9][a-z0-9-]*$/i.test(v);
}

/**
 * Deterministic eligibility (RESEARCH-4 stage 1): is `r` eligible for `req` BEFORE any paid
 * self-nomination check (D3)? Filters by enabled + egress (an `egressHint` must match the tier when
 * present) + a topic pre-filter (if the researcher declares `topics`, the request's what/context
 * must mention one). Pure — the dispatcher calls this to narrow the fan-out set cheaply.
 */
export function isEligible(r: ResearcherConfig, req: ResearchRequest): boolean {
  if (!r.enabled) return false;
  if (req.egressHint && req.egressHint !== r.egressTier) return false;
  if (r.topics && r.topics.length > 0) {
    const hay = `${normalizeTerm(req.what)} ${normalizeTerm(req.context)}`;
    if (!r.topics.some((t) => hay.includes(normalizeTerm(t)))) return false;
  }
  return true;
}
