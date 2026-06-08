// Researchers core types + pure helpers (SPEC-0028 RESEARCH-1/3/4/8). Node tier — pure logic, no I/O.
import { describe, it, expect } from 'vitest';
import {
  dedupKeyFor,
  normalizeTerm,
  researchWhatFor,
  isSafeResearcherId,
  isEligible,
  TEMPLATE_DEFAULT_EGRESS,
  clampToolCalls,
  clampTimeoutMs,
  clampMaxDepth,
  resolveTimeoutMs,
  MAX_TOOL_CALLS,
  MAX_MAX_DEPTH,
  MIN_MAX_DEPTH,
  MIN_SESSION_TIMEOUT_MS,
  MAX_SESSION_TIMEOUT_MS,
  DEFAULT_RESEARCH_SESSION_TIMEOUT_MS,
  type ResearcherConfig,
  type ResearchRequest,
} from './researchers';

function req(over: Partial<ResearchRequest> = {}): ResearchRequest {
  return {
    id: 'R1',
    ts: '2026-01-01T00:00:00.000Z',
    by: { stage: 'decompose', sourceId: 'S1' },
    what: 'Project Atlas',
    why: 'unknown term',
    context: 'Atlas is the codename for the launch',
    dedupKey: dedupKeyFor({ what: 'Project Atlas', by: { sourceId: 'S1' } }),
    ...over,
  };
}

function researcher(over: Partial<ResearcherConfig> = {}): ResearcherConfig {
  return {
    id: 'web-1',
    template: 'web',
    prompt: 'Find prior art.',
    egressTier: 'public-web',
    scope: 'global',
    budget: { maxToolCalls: 8, maxDepth: 2 },
    schedule: 'off',
    posture: 'guarded',
    enabled: true,
    ...over,
  };
}

describe('normalizeTerm + dedupKeyFor (D2)', () => {
  it('normalizes case + whitespace', () => {
    expect(normalizeTerm('  Project   ATLAS ')).toBe('project atlas');
  });

  it('coalesces requests about the same term+subject; distinguishes different subjects', () => {
    const a = dedupKeyFor({ what: 'Project Atlas', by: { entityId: 'E1' } });
    const b = dedupKeyFor({ what: 'project atlas', by: { entityId: 'E1' } }); // case-insensitive
    const c = dedupKeyFor({ what: 'Project Atlas', by: { entityId: 'E2' } }); // different subject
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });

  it('prefers entityId, falls back to sourceId, then empty', () => {
    expect(dedupKeyFor({ what: 'x', by: { entityId: 'E1', sourceId: 'S1' } })).toContain('E1');
    expect(dedupKeyFor({ what: 'x', by: { sourceId: 'S1' } })).toContain('S1');
    expect(dedupKeyFor({ what: 'x', by: {} })).toBe('x'); // no subject → bare normalized term
  });
});

describe('clampToolCalls / clampTimeoutMs — editable-bounds at the IPC boundary (WS3, RESEARCH-15/18)', () => {
  it('clampToolCalls: keeps a valid integer; CLAMPS out-of-range to the ceiling; REJECTS garbage', () => {
    expect(clampToolCalls(30)).toBe(30); // in-range valid
    expect(clampToolCalls(1)).toBe(1); // min
    expect(clampToolCalls(9999)).toBe(MAX_TOOL_CALLS); // clamped to the per-Instance ceiling (100)
    // rejected (→ undefined → field left unchanged): non-positive, non-integer, non-number
    for (const bad of [0, -3, 1.5, NaN, Infinity, '12', null, undefined]) expect(clampToolCalls(bad as unknown)).toBeUndefined();
  });

  it('clampTimeoutMs: keeps a valid ms; CLAMPS below the floor / above the ceiling; REJECTS garbage', () => {
    expect(clampTimeoutMs(20 * 60_000)).toBe(20 * 60_000); // 20 min in-range
    expect(clampTimeoutMs(5)).toBe(MIN_SESSION_TIMEOUT_MS); // 5ms → clamped up to the 30s floor
    expect(clampTimeoutMs(99 * 60 * 60_000)).toBe(MAX_SESSION_TIMEOUT_MS); // 99h → clamped to the 60min ceiling
    for (const bad of [0, -1, NaN, Infinity, '600000', null, undefined]) expect(clampTimeoutMs(bad as unknown)).toBeUndefined();
  });

  it('clampMaxDepth: keeps a valid integer; CLAMPS above the cap; REJECTS garbage (WS3 Slice-2, RESEARCH-11)', () => {
    expect(clampMaxDepth(3)).toBe(3); // in-range valid
    expect(clampMaxDepth(1)).toBe(MIN_MAX_DEPTH); // min
    expect(clampMaxDepth(99)).toBe(MAX_MAX_DEPTH); // clamped to the chain-depth cap (10)
    for (const bad of [0, -1, 1.5, NaN, Infinity, '3', null, undefined]) expect(clampMaxDepth(bad as unknown)).toBeUndefined();
  });

  it('resolveTimeoutMs: persisted value (clamped) or the default when absent/invalid', () => {
    expect(resolveTimeoutMs({ timeoutMs: 20 * 60_000 })).toBe(20 * 60_000);
    expect(resolveTimeoutMs({ timeoutMs: undefined })).toBe(DEFAULT_RESEARCH_SESSION_TIMEOUT_MS);
    expect(resolveTimeoutMs({ timeoutMs: 99 * 60 * 60_000 })).toBe(MAX_SESSION_TIMEOUT_MS); // clamps a runaway persisted value
    expect(resolveTimeoutMs({ timeoutMs: -5 })).toBe(DEFAULT_RESEARCH_SESSION_TIMEOUT_MS); // invalid → default
  });
});

describe('researchWhatFor — outbound topic for a standing / run-now pass (WS1 #6)', () => {
  it('prefers an explicit topic, then label, then the id', () => {
    expect(researchWhatFor(researcher({ id: 'prior-art', label: 'Prior art', topics: ['quantum batteries'] }))).toBe('quantum batteries');
    expect(researchWhatFor(researcher({ id: 'prior-art', label: 'Prior art', topics: [] }))).toBe('Prior art');
    expect(researchWhatFor(researcher({ id: 'prior-art', label: undefined, topics: undefined }))).toBe('prior-art');
  });

  it('REGRESSION (#6): never degenerates to the generic template word — a bare code researcher queries its real name (id), not "code"', () => {
    // The old `?? r.template` default made the run-now confirm say "dispatch code now" and the outbound
    // query degenerate to "code"; the fallback must land on the researcher's real name instead.
    const bare = researcher({ id: 'azure-sdk-repo', template: 'code', label: undefined, topics: undefined });
    expect(researchWhatFor(bare)).toBe('azure-sdk-repo');
    expect(researchWhatFor(bare)).not.toBe('code');
    const bareWeb = researcher({ id: 'press-releases', template: 'web', label: undefined, topics: [] });
    expect(researchWhatFor(bareWeb)).not.toBe('web');
  });
});

describe('isSafeResearcherId (path-injection guard, mirrors isSafeJobId)', () => {
  it('accepts bare slugs', () => {
    for (const id of ['web', 'web-1', 'm365research', 'a1']) expect(isSafeResearcherId(id)).toBe(true);
  });
  it('rejects separators, traversal, dotfiles, spaces, empty, non-string', () => {
    for (const id of ['../x', 'a/b', '..', '.kb', 'a b', '-leading', '', 42, null, undefined]) {
      expect(isSafeResearcherId(id as unknown)).toBe(false);
    }
  });
});

describe('isEligible — deterministic pre-filter (RESEARCH-4 / D3)', () => {
  it('disabled researchers are never eligible', () => {
    expect(isEligible(researcher({ enabled: false }), req())).toBe(false);
  });

  it('an egressHint must match the researcher tier', () => {
    expect(isEligible(researcher({ egressTier: 'public-web' }), req({ egressHint: 'public-web' }))).toBe(true);
    expect(isEligible(researcher({ egressTier: 'public-web' }), req({ egressHint: 'local-only' }))).toBe(false);
    expect(isEligible(researcher({ egressTier: 'public-web' }), req({ egressHint: undefined }))).toBe(true); // no hint = any tier
  });

  it('a topic pre-filter requires the request to mention a declared topic', () => {
    const r = researcher({ topics: ['atlas', 'orion'] });
    expect(isEligible(r, req({ what: 'Project Atlas', context: '' }))).toBe(true); // matches 'atlas'
    expect(isEligible(r, req({ what: 'Project Zephyr', context: 'unrelated' }))).toBe(false);
    // no topics declared = no topic pre-filter (egress/scope + self-nomination decide)
    expect(isEligible(researcher({ topics: [] }), req({ what: 'anything' }))).toBe(true);
  });
});

describe('template egress defaults (RESEARCH-4 §4)', () => {
  it('web=public-web, code=local-only, m365=internal-tenant', () => {
    expect(TEMPLATE_DEFAULT_EGRESS.web).toBe('public-web');
    expect(TEMPLATE_DEFAULT_EGRESS.code).toBe('local-only');
    expect(TEMPLATE_DEFAULT_EGRESS.m365).toBe('internal-tenant');
  });
});
