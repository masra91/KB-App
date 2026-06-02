// Researchers core types + pure helpers (SPEC-0028 RESEARCH-1/3/4/8). Node tier — pure logic, no I/O.
import { describe, it, expect } from 'vitest';
import {
  dedupKeyFor,
  normalizeTerm,
  isSafeResearcherId,
  isEligible,
  TEMPLATE_DEFAULT_EGRESS,
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
