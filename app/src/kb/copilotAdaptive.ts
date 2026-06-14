// SPEC-0048 SCALE-7/8 — the adaptive global-ceiling controller (AIMD) + the copilot error classifier.
//
// Slice 1 (the escape hatch) let the Principal pin a manual ceiling or fall back to a static
// cores-derived default. Slice 2 makes the "let the app decide" (Auto) path SMART: instead of guessing
// a number, climb the ceiling while healthy and back off the moment the CLI/API signals it's
// rate-limited — "rather deal with 429s + throttle off that than pick a random number" (the Principal).
//
// AIMD = Additive-Increase / Multiplicative-Decrease (the classic congestion-control shape): nudge up
// by 1 after a healthy streak, halve on a rate-limit signal, then re-probe upward once the cooldown
// passes. Self-finds the box/account's real concurrency headroom without a human picking it.
//
// This module is PURE: no node imports, no dependency on the semaphore — just the classifier + the
// controller state machine, with the clock injected. `copilotConcurrency.ts` owns the runtime singleton
// that feeds it outcomes and resizes the shared semaphore (one-directional import, no cycle), so the
// decision logic here is deterministically unit-testable in isolation.

/** The outcome of one copilot call, from the controller's perspective. `ok` = clean success;
 *  `rate-limit` = the CLI/API pushed back on capacity (429 / overloaded / quota) — the ONLY backoff
 *  signal; `content` = a malformed/truncated model response (parse failure, the truncated-JSON class)
 *  — NOT a capacity problem, must never trigger backoff; `other` = any other failure (also not
 *  capacity). Distinguishing `rate-limit` from `content`/`other` is the load-bearing requirement:
 *  backing off on a content error would needlessly throttle a perfectly healthy pipeline. */
export type CopilotOutcome = 'ok' | 'rate-limit' | 'content' | 'other';

/** The non-`ok` classes {@link classifyCopilotError} resolves a failure into. */
export type CopilotErrorClass = Exclude<CopilotOutcome, 'ok'>;

// Case-insensitive signatures. Kept conservative + specific so a normal content/tooling error is never
// mis-read as a rate-limit (which would wrongly throttle the pipeline).
//
// TEXTUAL signals are unambiguous capacity language — always a rate-limit.
const TEXTUAL_RATE_LIMIT_PATTERNS: RegExp[] = [
  /rate[\s_-]?limit/i,
  /too many requests/i,
  /overloaded/i,
  /\bquota\b/i,
  /quota exceeded/i,
  /resource[\s_-]?exhausted/i, // gRPC RESOURCE_EXHAUSTED
  /usage limit/i,
  /\bthrottl/i, // throttle / throttled / throttling
];

// A bare HTTP-ish numeric code (429 Too Many Requests / 503 Service Unavailable / 529 Anthropic
// "overloaded") is a rate-limit signal — UNLESS it's a JSON parse CHARACTER OFFSET (e.g. "Unterminated
// string in JSON at position 429"), which is a truncated-JSON CONTENT error, not capacity. QD-2's #357
// catch: `\b429\b` matched "position 429" and wrongly halved the ceiling. We disambiguate by rejecting a
// numeric code that sits in a parse-offset context (`position|offset|index|char|column|line … <code>`).
const NUMERIC_RATE_CODE = /\b(?:429|503|529)\b/;
const PARSE_POSITION_CODE = /(?:position|offset|index|char(?:acter)?|column|line)\s*:?\s*(?:429|503|529)\b/i;

const CONTENT_PATTERNS: RegExp[] = [
  /unexpected end of (json|input|file)/i,
  /unterminated string/i,
  /is not valid json/i,
  /invalid json/i,
  /unexpected token/i,
  /\bsyntaxerror\b/i,
  /truncat/i, // truncated response (backlog #11 — the truncated-JSON class)
  /could not parse/i,
  /failed to parse/i,
];

/** Extract a matchable string from an arbitrary thrown value (Error message, else stringified). */
function errorText(err: unknown): string {
  if (err instanceof Error) return `${err.message}${err.stack ? '\n' + err.stack : ''}`;
  if (typeof err === 'string') return err;
  try {
    return JSON.stringify(err) ?? String(err);
  } catch {
    return String(err);
  }
}

/**
 * Classify a copilot failure into the controller's error classes (SCALE-8). Rate-limit signatures are
 * checked FIRST (they're the actionable capacity signal); then the malformed-content/parse class; else
 * `other`. A clean success is never passed here — the caller records `ok` directly. Pure + total: any
 * input resolves to exactly one class.
 */
export function classifyCopilotError(err: unknown): CopilotErrorClass {
  const text = errorText(err);
  // Unambiguous capacity language → rate-limit.
  if (TEXTUAL_RATE_LIMIT_PATTERNS.some((re) => re.test(text))) return 'rate-limit';
  // A bare 429/503/529 → rate-limit ONLY when it isn't a JSON parse offset ("…at position 429"), which
  // is a truncated-content error that must NOT back the ceiling off (QD-2 #357).
  if (NUMERIC_RATE_CODE.test(text) && !PARSE_POSITION_CODE.test(text)) return 'rate-limit';
  if (CONTENT_PATTERNS.some((re) => re.test(text))) return 'content';
  return 'other';
}

/** AIMD controller tuning. All overridable (tests inject tight values); the defaults are sane for a
 *  real desktop pipeline (slow, patient climb; decisive halving; a 1-minute throttled cooldown). */
export interface AdaptiveConfig {
  /** Absolute floor — the ceiling never adapts below this (keeps the pipeline from collapsing to serial). */
  min: number;
  /** Probe cap — the ceiling never climbs above this. */
  max: number;
  /** Seed value the controller starts at (typically the cores-derived default). */
  start: number;
  /** Consecutive clean successes required before one additive +1 step (the healthy streak / re-probe gate). */
  increaseAfter: number;
  /** Multiplicative back-off factor applied on a rate-limit (0.5 = halve). */
  decreaseFactor: number;
  /** After a rate-limit, how long (ms) to stay "throttled" — no climbing + the indicator shows — before
   *  re-probing upward. The cooldown is what makes the re-probe *periodic* rather than instant-rebound. */
  cooldownMs: number;
}

/** The shipped defaults (SCALE-7/8). */
export const DEFAULT_ADAPTIVE_CONFIG: Omit<AdaptiveConfig, 'start' | 'min' | 'max'> = {
  increaseAfter: 8,
  decreaseFactor: 0.5,
  cooldownMs: 60_000,
};

/**
 * The AIMD state machine. Fed one {@link CopilotOutcome} at a time with an injected `now` (epoch ms);
 * `onOutcome` returns whether the target ceiling changed so the caller can resize the live semaphore
 * only when needed. Holds no timers and no global state — a pure, deterministic decision unit.
 */
export class AdaptiveCeilingController {
  private target: number;
  private healthy = 0;
  /** Epoch ms until which we're throttled (no climbing; indicator on). 0 = never throttled yet. */
  private throttledUntil = 0;
  /** High-water mark — the healthiest ceiling we've sustained (SCALE-7/8 UI). The "throttled" caption
   *  shows `effective N of {reference} M` while a rate-limit has us backed off below it; once we
   *  re-probe back up to the reference the indicator clears (effective is no longer < reference). */
  private reference: number;
  private readonly cfg: AdaptiveConfig;

  constructor(cfg: AdaptiveConfig) {
    this.cfg = cfg;
    this.target = clamp(cfg.start, cfg.min, cfg.max);
    this.reference = this.target;
  }

  /** The current target ceiling (what the semaphore should be sized to). */
  get ceiling(): number {
    return this.target;
  }

  /** The high-water reference ceiling — the "M" in "effective N of M" (the healthy level we climb back
   *  toward after a back-off). Equals `ceiling` when fully recovered (then the indicator is absent). */
  get referenceCeiling(): number {
    return this.reference;
  }

  /** Whether a rate-limit currently has us backed off below the reference (drives the UI indicator —
   *  render the "easing off rate limits" caption only while this is true). */
  get isBackedOff(): boolean {
    return this.target < this.reference;
  }

  /** Whether we're inside the post-rate-limit cooldown window at `now` (drives the "throttled" indicator). */
  isThrottled(now: number): boolean {
    return now < this.throttledUntil;
  }

  /**
   * Feed one outcome. Returns `true` iff the target ceiling changed (→ caller resizes the semaphore).
   * - `rate-limit` → multiplicative-decrease (halve, floored at min) + reset the streak + open a cooldown.
   * - `ok` → grow the healthy streak; once the cooldown has elapsed AND the streak hits `increaseAfter`
   *   AND we're below max, additive-increase by 1 and reset the streak (this is the periodic re-probe).
   * - `content` / `other` → NEUTRAL: not a capacity signal, so no back-off and no streak credit (an
   *   intermittent parse error must never throttle, nor should errors fuel a climb).
   */
  onOutcome(outcome: CopilotOutcome, now: number): boolean {
    const before = this.target;
    switch (outcome) {
      case 'rate-limit':
        this.healthy = 0;
        this.throttledUntil = now + this.cfg.cooldownMs;
        this.target = Math.max(this.cfg.min, Math.floor(this.target * this.cfg.decreaseFactor));
        break;
      case 'ok':
        this.healthy++;
        if (now >= this.throttledUntil && this.healthy >= this.cfg.increaseAfter && this.target < this.cfg.max) {
          this.target++;
          this.healthy = 0;
          if (this.target > this.reference) this.reference = this.target; // new sustained high-water
        }
        break;
      case 'content':
      case 'other':
        // Neutral — see above. Intentionally no state change.
        break;
    }
    return this.target !== before;
  }

  /** Diagnostic: the current healthy streak (test/inspection only). */
  get healthyStreak(): number {
    return this.healthy;
  }
}

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.floor(v)));
}
