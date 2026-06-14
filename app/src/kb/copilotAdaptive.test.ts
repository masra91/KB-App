// SPEC-0048 SCALE-7/8 — the adaptive ceiling controller (AIMD) + copilot error classifier. Pure unit
// tests with the clock injected: classification (rate-limit vs content vs other), additive-increase on
// a healthy streak, multiplicative-decrease on a rate-limit, the throttled cooldown, and the re-probe.
import { describe, it, expect } from 'vitest';
import { classifyCopilotError, AdaptiveCeilingController, type AdaptiveConfig } from './copilotAdaptive';

describe('classifyCopilotError (SCALE-8 — rate-limit vs content vs other)', () => {
  it('flags the rate-limit / overloaded / quota family as rate-limit', () => {
    for (const msg of [
      'Request failed with status 429',
      'HTTP 503 Service Unavailable',
      'overloaded_error: 529',
      'rate limit exceeded',
      'rate-limit reached, retry later',
      'Too Many Requests',
      'You have exceeded your quota',
      'gRPC error: RESOURCE_EXHAUSTED',
      'usage limit reached for this account',
      'request was throttled',
    ]) {
      expect(classifyCopilotError(new Error(msg)), msg).toBe('rate-limit');
    }
  });

  it('flags malformed/truncated model output as content (the truncated-JSON class, backlog #11)', () => {
    for (const msg of [
      'Unexpected end of JSON input',
      'Unexpected end of input',
      'Unterminated string in JSON at position 4096',
      'is not valid JSON',
      'Invalid JSON returned by the model',
      'SyntaxError: Unexpected token < in JSON',
      'the response was truncated',
      'could not parse the model output',
      'failed to parse claims block',
    ]) {
      expect(classifyCopilotError(new Error(msg)), msg).toBe('content');
    }
  });

  it('everything else is other (never mis-read as a capacity signal)', () => {
    expect(classifyCopilotError(new Error('ENOENT: no such file or directory'))).toBe('other');
    expect(classifyCopilotError(new Error('copilot: command not found'))).toBe('other');
    expect(classifyCopilotError(new Error('git index.lock exists'))).toBe('other');
  });

  it('handles non-Error throwables (string / object / null) totally', () => {
    expect(classifyCopilotError('429 too many requests')).toBe('rate-limit');
    expect(classifyCopilotError({ message: 'overloaded' })).toBe('rate-limit');
    expect(classifyCopilotError('Unexpected end of JSON input')).toBe('content');
    expect(classifyCopilotError(null)).toBe('other');
    expect(classifyCopilotError(undefined)).toBe('other');
  });

  it('checks rate-limit BEFORE content (a 429 that LEADS — not a parse offset — is a rate-limit)', () => {
    expect(classifyCopilotError(new Error('429: could not parse error json'))).toBe('rate-limit');
  });

  // QD-2 #357 regression: a JSON parse character-offset that happens to land on 429/503/529 is a
  // truncated-CONTENT error, NOT a rate-limit — must never back the ceiling off. `\b429\b` used to
  // match "position 429" and misfire. The class the dispatch said must never throttle.
  it('a parse character-offset numerically equal to a rate-limit code is CONTENT, not rate-limit', () => {
    expect(classifyCopilotError(new Error('Unterminated string in JSON at position 429'))).toBe('content');
    expect(classifyCopilotError(new Error('Unexpected token < at position 503'))).toBe('content');
    expect(classifyCopilotError(new Error('Unexpected end of JSON input at offset 529'))).toBe('content');
    expect(classifyCopilotError(new Error('SyntaxError: Unexpected token at line 429'))).toBe('content');
    expect(classifyCopilotError('Invalid JSON returned at index 503')).toBe('content');
  });

  it('still flags a genuine numeric rate-limit code that is NOT in a parse-offset context', () => {
    expect(classifyCopilotError(new Error('Request failed with status 429'))).toBe('rate-limit');
    expect(classifyCopilotError(new Error('HTTP 503 from the gateway'))).toBe('rate-limit');
    expect(classifyCopilotError(new Error('overloaded_error 529'))).toBe('rate-limit');
  });
});

const cfg = (over: Partial<AdaptiveConfig> = {}): AdaptiveConfig => ({
  min: 1,
  max: 8,
  start: 4,
  increaseAfter: 3,
  decreaseFactor: 0.5,
  cooldownMs: 1000,
  ...over,
});

describe('AdaptiveCeilingController (SCALE-7 — AIMD)', () => {
  it('seeds the target clamped into [min, max]', () => {
    expect(new AdaptiveCeilingController(cfg({ start: 99 })).ceiling).toBe(8);
    expect(new AdaptiveCeilingController(cfg({ start: 0 })).ceiling).toBe(1);
    expect(new AdaptiveCeilingController(cfg({ start: 4 })).ceiling).toBe(4);
  });

  it('additive-increase: +1 only after `increaseAfter` consecutive successes', () => {
    const c = new AdaptiveCeilingController(cfg({ start: 4, increaseAfter: 3 }));
    expect(c.onOutcome('ok', 0)).toBe(false); // streak 1
    expect(c.onOutcome('ok', 0)).toBe(false); // streak 2
    expect(c.ceiling).toBe(4);
    expect(c.onOutcome('ok', 0)).toBe(true); // streak 3 → +1
    expect(c.ceiling).toBe(5);
    expect(c.healthyStreak).toBe(0); // streak reset after a step
  });

  it('never climbs past max', () => {
    const c = new AdaptiveCeilingController(cfg({ start: 8, max: 8, increaseAfter: 1 }));
    expect(c.onOutcome('ok', 0)).toBe(false); // already at max → no change
    expect(c.ceiling).toBe(8);
  });

  it('multiplicative-decrease: a rate-limit halves the target (floored at min) + resets the streak', () => {
    const c = new AdaptiveCeilingController(cfg({ start: 8, min: 1, decreaseFactor: 0.5 }));
    c.onOutcome('ok', 0);
    expect(c.onOutcome('rate-limit', 0)).toBe(true);
    expect(c.ceiling).toBe(4); // 8 → 4
    expect(c.healthyStreak).toBe(0);
    c.onOutcome('rate-limit', 0); // 4 → 2
    c.onOutcome('rate-limit', 0); // 2 → 1
    expect(c.ceiling).toBe(1);
    expect(c.onOutcome('rate-limit', 0)).toBe(false); // already at floor → no change
    expect(c.ceiling).toBe(1);
  });

  it('content/other are NEUTRAL — never back off, never credit the streak', () => {
    const c = new AdaptiveCeilingController(cfg({ start: 4, increaseAfter: 2 }));
    expect(c.onOutcome('content', 0)).toBe(false);
    expect(c.onOutcome('other', 0)).toBe(false);
    expect(c.ceiling).toBe(4);
    expect(c.healthyStreak).toBe(0); // no credit from errors
    // a content error between successes must not block the eventual climb, nor accelerate it
    c.onOutcome('ok', 0); // streak 1
    c.onOutcome('content', 0); // neutral
    expect(c.onOutcome('ok', 0)).toBe(true); // streak 2 → +1
    expect(c.ceiling).toBe(5);
  });

  it('throttled cooldown: after a rate-limit, successes do NOT climb until the cooldown elapses (re-probe)', () => {
    const c = new AdaptiveCeilingController(cfg({ start: 8, increaseAfter: 1, cooldownMs: 1000 }));
    c.onOutcome('rate-limit', 0); // 8 → 4, throttled until t=1000
    expect(c.ceiling).toBe(4);
    expect(c.isThrottled(500)).toBe(true);
    // within cooldown: a success grows the streak but must NOT climb
    expect(c.onOutcome('ok', 500)).toBe(false);
    expect(c.ceiling).toBe(4);
    // after cooldown: the next success re-probes upward (+1)
    expect(c.isThrottled(1000)).toBe(false);
    expect(c.onOutcome('ok', 1000)).toBe(true);
    expect(c.ceiling).toBe(5);
  });

  it('isThrottled is false before any rate-limit and after the window passes', () => {
    const c = new AdaptiveCeilingController(cfg());
    expect(c.isThrottled(0)).toBe(false);
    c.onOutcome('rate-limit', 100); // throttled until 1100
    expect(c.isThrottled(1099)).toBe(true);
    expect(c.isThrottled(1100)).toBe(false);
  });

  // SCALE-7/8 UI: the reference high-water drives the "effective N of M" indicator (effective < reference).
  it('reference high-water: starts at the seed; a rate-limit leaves reference at the pre-backoff level', () => {
    const c = new AdaptiveCeilingController(cfg({ start: 8, min: 1, increaseAfter: 1 }));
    expect(c.referenceCeiling).toBe(8);
    expect(c.isBackedOff).toBe(false); // healthy at the high-water
    c.onOutcome('rate-limit', 0); // 8 → 4
    expect(c.ceiling).toBe(4);
    expect(c.referenceCeiling).toBe(8); // reference stays at the level we climb back toward → "4 of 8"
    expect(c.isBackedOff).toBe(true);
  });

  it('clears the backed-off state once it re-probes back up to the reference', () => {
    const c = new AdaptiveCeilingController(cfg({ start: 8, min: 1, increaseAfter: 1, cooldownMs: 0 }));
    c.onOutcome('rate-limit', 0); // 8 → 4, reference 8
    expect(c.isBackedOff).toBe(true);
    for (let t = 1; c.ceiling < 8; t++) c.onOutcome('ok', t); // climb 4→5→6→7→8
    expect(c.ceiling).toBe(8);
    expect(c.isBackedOff).toBe(false); // recovered to reference → indicator clears
  });

  it('reference follows the high-water when it re-probes ABOVE the prior reference', () => {
    const c = new AdaptiveCeilingController(cfg({ start: 4, max: 8, min: 1, increaseAfter: 1, cooldownMs: 0 }));
    expect(c.referenceCeiling).toBe(4);
    c.onOutcome('ok', 1); // 4 → 5 (new high)
    expect(c.referenceCeiling).toBe(5);
    expect(c.isBackedOff).toBe(false);
  });
});
