// Configurable work-depth (SPEC-0023 JOBS-17) — ONE consistent "how hard does this work each item"
// knob, shared by every job (internal + external) AND every stage agent (Decompose/Connect/Claims/
// Reflect) AND researchers. Today the depth/effort budget (tool-call ceiling, recursion/hops,
// timeout) is exposed only for researchers; this makes it a first-class, Principal-configurable
// control everywhere, with a SAFE default per work-kind and an opt-in-deeper-with-warning escalation.
//
// Two invariants the Principal's ruling pins (consistency is key):
//  1. Depth scales **per-item effort, never total parallelism** — the global Copilot ceiling
//     (ORCH-23, `researchCeiling`) stays the HARD wall and is a SEPARATE mechanism from this knob.
//     Nothing here can raise concurrency; it only changes how much one item is worked.
//  2. Opt-in-deeper carries a **warning** (mirrors the per-stage concurrency ruling) — deeper is more
//     thorough but more cost/time — and every field is **clamped under a hard per-item ceiling**, so a
//     hand-edited config can't blow the per-item bound.
//
// Reusable by design (DEV-3 Reflect coverage / DEV-7 recall budget consume the same shape): a
// work-kind declares a `WorkDepthSpec` (its default level + per-level numbers + ceiling); callers
// resolve a stored `WorkDepthConfig` into a concrete, clamped `ResolvedWorkDepth`. Pure, no deps.

export const DEPTH_LEVELS = ['shallow', 'standard', 'deep'] as const;
export type DepthLevel = (typeof DEPTH_LEVELS)[number];

/** The safe default when a job/agent has never been configured. */
export const DEFAULT_DEPTH_LEVEL: DepthLevel = 'standard';

/** Ordinal for "deeper than" comparisons (shallow < standard < deep). */
const LEVEL_RANK: Record<DepthLevel, number> = { shallow: 0, standard: 1, deep: 2 };

/** The concrete per-item effort budget — "how hard this item is worked." Per-item effort ONLY; the
 *  global Copilot ceiling (ORCH-23) bounds total parallelism separately and always. */
export interface WorkDepth {
  level: DepthLevel;
  /** Tool-call ceiling for one item (retrieval/agent tool calls). */
  maxToolCalls: number;
  /** Wall-clock ceiling for one item, ms. */
  timeoutMs: number;
  /** Recursion / hop depth — present only for kinds that recurse (researchers); omitted otherwise. */
  maxDepth?: number;
}

/** One level's numbers for a work-kind. */
export interface DepthProfile {
  maxToolCalls: number;
  timeoutMs: number;
  maxDepth?: number;
}

/** A work-kind's depth contract: its safe default level, the per-level profiles, and the hard
 *  per-item ceiling. Stage agents, researchers, and jobs each declare one — same knob, kind numbers. */
export interface WorkDepthSpec {
  /** Human work-kind label (for the warning + the Control Panel). */
  kind: string;
  /** Safe default level — `deep` (and any over-default override) is opt-in-with-warning. */
  defaultLevel: DepthLevel;
  /** Numbers for each level. */
  profiles: Record<DepthLevel, DepthProfile>;
  /** Hard per-item ceiling — opt-in-deeper + explicit overrides clamp under this. NOT the global
   *  ORCH-23 parallelism wall (that's separate + always applies). */
  ceiling: DepthProfile;
}

/** What the Principal stored for one job/agent. All optional — absent fields take the kind's default. */
export interface WorkDepthConfig {
  level?: DepthLevel;
  maxToolCalls?: number;
  timeoutMs?: number;
  maxDepth?: number;
}

export interface ResolvedWorkDepth extends WorkDepth {
  /** Set iff the resolved effort exceeds the kind's safe default — the opt-in-deeper warning to surface. */
  warning?: string;
}

/** Choose the override iff it's a positive finite number, else the profile base; then clamp into
 *  1..ceiling. A `0` / `NaN` / negative override is treated as ABSENT (falls back to the base), so a
 *  bad config can never silently zero-out an item's effort. */
function pickClamped(override: number | undefined, base: number, ceiling: number): number {
  const chosen = typeof override === 'number' && Number.isFinite(override) && override > 0 ? Math.floor(override) : base;
  return Math.min(Math.max(1, chosen), Math.max(1, Math.floor(ceiling)));
}

/** Normalize a possibly-unknown level to a valid one, or undefined. */
export function asDepthLevel(v: unknown): DepthLevel | undefined {
  return typeof v === 'string' && (DEPTH_LEVELS as readonly string[]).includes(v) ? (v as DepthLevel) : undefined;
}

/**
 * Resolve a stored {@link WorkDepthConfig} against a {@link WorkDepthSpec} into a concrete, clamped
 * {@link ResolvedWorkDepth}. Precedence per field: explicit override → the chosen level's profile,
 * then clamp under the ceiling. A `maxDepth` is produced only when the kind has one (its ceiling
 * defines `maxDepth`). A `warning` is attached when the resolved effort is deeper than the safe
 * default (a deeper level, or an override above the default profile) — the opt-in-deeper signal.
 */
export function resolveWorkDepth(spec: WorkDepthSpec, config: WorkDepthConfig = {}): ResolvedWorkDepth {
  const level = asDepthLevel(config.level) ?? spec.defaultLevel;
  const base = spec.profiles[level];
  const defaults = spec.profiles[spec.defaultLevel];

  const maxToolCalls = pickClamped(config.maxToolCalls, base.maxToolCalls, spec.ceiling.maxToolCalls);
  const timeoutMs = pickClamped(config.timeoutMs, base.timeoutMs, spec.ceiling.timeoutMs);

  let maxDepth: number | undefined;
  if (spec.ceiling.maxDepth !== undefined) {
    maxDepth = pickClamped(config.maxDepth, base.maxDepth ?? 1, spec.ceiling.maxDepth);
  }

  // Deeper-than-default = a higher level, OR any resolved field above the default-level profile.
  const deeper =
    LEVEL_RANK[level] > LEVEL_RANK[spec.defaultLevel] ||
    maxToolCalls > defaults.maxToolCalls ||
    timeoutMs > defaults.timeoutMs ||
    (maxDepth !== undefined && defaults.maxDepth !== undefined && maxDepth > defaults.maxDepth);

  const resolved: ResolvedWorkDepth = {
    level,
    maxToolCalls,
    timeoutMs,
    ...(maxDepth !== undefined ? { maxDepth } : {}),
  };
  if (deeper) {
    resolved.warning = `Deeper than the safe default for ${spec.kind} — more thorough, but more cost and time. The global Copilot ceiling still bounds total parallelism.`;
  }
  return resolved;
}

/** Whether a config asks for more than the kind's safe default (drives the Control-Panel warning UI
 *  without resolving). Pure mirror of the `warning` condition in {@link resolveWorkDepth}. */
export function isDeeperThanDefault(spec: WorkDepthSpec, config: WorkDepthConfig = {}): boolean {
  return resolveWorkDepth(spec, config).warning !== undefined;
}

/** Validate/sanitize a stored config blob into a {@link WorkDepthConfig} (registry read boundary) —
 *  drops non-finite / non-positive numbers + unknown levels, never throws. */
export function asWorkDepthConfig(v: unknown): WorkDepthConfig | undefined {
  if (typeof v !== 'object' || v === null) return undefined;
  const o = v as Record<string, unknown>;
  const out: WorkDepthConfig = {};
  const lvl = asDepthLevel(o.level);
  if (lvl) out.level = lvl;
  for (const k of ['maxToolCalls', 'timeoutMs', 'maxDepth'] as const) {
    const n = o[k];
    if (typeof n === 'number' && Number.isFinite(n) && n > 0) out[k] = Math.floor(n);
  }
  return Object.keys(out).length > 0 ? out : undefined;
}
