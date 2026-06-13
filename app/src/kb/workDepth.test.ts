// SPEC-0023 JOBS-17 — the reusable work-depth knob: levels, clamping, opt-in-deeper-with-warning.
import { describe, it, expect } from 'vitest';
import {
  resolveWorkDepth,
  isDeeperThanDefault,
  asWorkDepthConfig,
  asDepthLevel,
  DEPTH_LEVELS,
  DEFAULT_DEPTH_LEVEL,
  type WorkDepthSpec,
} from './workDepth';

// A recursing kind (researcher-like): has maxDepth in its ceiling.
const RESEARCHER: WorkDepthSpec = {
  kind: 'researcher',
  defaultLevel: 'standard',
  profiles: {
    shallow: { maxToolCalls: 5, timeoutMs: 60_000, maxDepth: 1 },
    standard: { maxToolCalls: 15, timeoutMs: 180_000, maxDepth: 2 },
    deep: { maxToolCalls: 30, timeoutMs: 360_000, maxDepth: 3 },
  },
  ceiling: { maxToolCalls: 50, timeoutMs: 600_000, maxDepth: 4 },
};

// A non-recursing kind (stage agent): no maxDepth.
const CLAIMS: WorkDepthSpec = {
  kind: 'claims',
  defaultLevel: 'standard',
  profiles: {
    shallow: { maxToolCalls: 3, timeoutMs: 30_000 },
    standard: { maxToolCalls: 8, timeoutMs: 90_000 },
    deep: { maxToolCalls: 16, timeoutMs: 180_000 },
  },
  ceiling: { maxToolCalls: 24, timeoutMs: 300_000 },
};

describe('resolveWorkDepth — levels + defaults', () => {
  it('an empty config resolves to the safe default level, no warning', () => {
    const r = resolveWorkDepth(RESEARCHER);
    expect(r).toMatchObject({ level: 'standard', maxToolCalls: 15, timeoutMs: 180_000, maxDepth: 2 });
    expect(r.warning).toBeUndefined();
  });

  it('a shallower level is not "deeper" → no warning', () => {
    const r = resolveWorkDepth(RESEARCHER, { level: 'shallow' });
    expect(r).toMatchObject({ level: 'shallow', maxToolCalls: 5, maxDepth: 1 });
    expect(r.warning).toBeUndefined();
  });

  it('a deeper level warns (opt-in-deeper-with-warning) and keeps the global-ceiling note', () => {
    const r = resolveWorkDepth(RESEARCHER, { level: 'deep' });
    expect(r).toMatchObject({ level: 'deep', maxToolCalls: 30, maxDepth: 3 });
    expect(r.warning).toMatch(/Deeper than the safe default for researcher/);
    expect(r.warning).toMatch(/global Copilot ceiling still bounds total parallelism/);
  });

  it('omits maxDepth for a non-recursing kind (no ceiling.maxDepth)', () => {
    const r = resolveWorkDepth(CLAIMS, { level: 'deep' });
    expect(r.maxDepth).toBeUndefined();
    expect(r).toMatchObject({ level: 'deep', maxToolCalls: 16, timeoutMs: 180_000 });
    expect(r.warning).toBeDefined();
  });
});

describe('resolveWorkDepth — explicit overrides + clamping', () => {
  it('an explicit override above the default profile wins AND warns', () => {
    const r = resolveWorkDepth(CLAIMS, { maxToolCalls: 12 }); // > standard's 8
    expect(r.maxToolCalls).toBe(12);
    expect(r.warning).toBeDefined();
  });

  it('clamps every field under the hard per-item ceiling (a hand-edited config cannot blow it)', () => {
    const r = resolveWorkDepth(RESEARCHER, { maxToolCalls: 9999, timeoutMs: 9_999_999, maxDepth: 99 });
    expect(r.maxToolCalls).toBe(50); // ceiling
    expect(r.timeoutMs).toBe(600_000); // ceiling
    expect(r.maxDepth).toBe(4); // ceiling
    expect(r.warning).toBeDefined();
  });

  it('floors a non-positive / non-finite override to a sane minimum (never 0 or NaN work)', () => {
    const r = resolveWorkDepth(CLAIMS, { maxToolCalls: 0 });
    expect(r.maxToolCalls).toBe(8); // falls back to the level profile, not 0
    const r2 = resolveWorkDepth(CLAIMS, { maxToolCalls: Number.NaN });
    expect(r2.maxToolCalls).toBe(8);
  });

  it('an unknown level falls back to the kind default', () => {
    const r = resolveWorkDepth(CLAIMS, { level: 'turbo' as never });
    expect(r.level).toBe('standard');
  });
});

describe('isDeeperThanDefault (Control-Panel warning gate)', () => {
  it('true for a deep level, false for default/shallow', () => {
    expect(isDeeperThanDefault(RESEARCHER, { level: 'deep' })).toBe(true);
    expect(isDeeperThanDefault(RESEARCHER, {})).toBe(false);
    expect(isDeeperThanDefault(RESEARCHER, { level: 'shallow' })).toBe(false);
  });
  it('true when an override exceeds the default profile even at the default level', () => {
    expect(isDeeperThanDefault(CLAIMS, { maxToolCalls: 20 })).toBe(true);
  });
});

describe('asWorkDepthConfig / asDepthLevel — registry-read sanitization', () => {
  it('keeps valid level + positive numbers, drops junk', () => {
    expect(asWorkDepthConfig({ level: 'deep', maxToolCalls: 20, timeoutMs: 1000, maxDepth: 3 })).toEqual({ level: 'deep', maxToolCalls: 20, timeoutMs: 1000, maxDepth: 3 });
    expect(asWorkDepthConfig({ level: 'bogus', maxToolCalls: -5, timeoutMs: 0, maxDepth: 'x' })).toBeUndefined();
    expect(asWorkDepthConfig({ maxToolCalls: 7 })).toEqual({ maxToolCalls: 7 });
    expect(asWorkDepthConfig(null)).toBeUndefined();
    expect(asWorkDepthConfig('nope')).toBeUndefined();
  });
  it('asDepthLevel validates against the level set', () => {
    for (const l of DEPTH_LEVELS) expect(asDepthLevel(l)).toBe(l);
    expect(asDepthLevel('deepest')).toBeUndefined();
    expect(asDepthLevel(3)).toBeUndefined();
    expect(DEFAULT_DEPTH_LEVEL).toBe('standard');
  });
});
