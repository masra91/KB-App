// SPEC-0028 RESEARCH-24 — the per-kind enrichment gap (claims-present + claims-MISSING). Deterministic, so
// these are exact assertions on which facets a kind's present claims cover vs. leave open — the gap an
// enrichment pass should target. Real-vault-shaped claim statements (natural prose), no dev-jargon.
import { describe, it, expect } from 'vitest';
import { computeEnrichmentGap, isEnrichmentGap, DEFAULT_FACETS } from './enrichGap';

describe('computeEnrichmentGap — claims-present vs claims-MISSING', () => {
  it('a person with a role+employer claim still has education/birth/etc. as the gap', () => {
    const gap = computeEnrichmentGap('person', ['Ada is a software engineer.', 'She works at Acme Corp.']);
    expect(gap.present).toContain('role or occupation');
    expect(gap.present).toContain('employer or affiliation');
    // facets no claim covers are the gap — what an enrichment pass should chase next.
    expect(gap.missing).toContain('education');
    expect(gap.missing).toContain('date of birth');
    expect(gap.missing).toContain('location');
  });

  it('an entity with ZERO claims has every expected facet missing (a stub wants enrichment across the board)', () => {
    const gap = computeEnrichmentGap('person', []);
    expect(gap.present).toEqual([]);
    expect(gap.missing.length).toBeGreaterThan(0);
    expect(gap.missing).toContain('role or occupation');
  });

  it('is kind-aware: an organization gap is org facets (founding/industry/...), not person facets', () => {
    const gap = computeEnrichmentGap('organization', ['Acme was founded in 1999.']);
    expect(gap.present).toContain('founding date');
    expect(gap.missing).toContain('industry or sector');
    expect(gap.missing).toContain('leadership');
    // never bleeds person facets into an org gap
    expect([...gap.present, ...gap.missing]).not.toContain('education');
  });

  it('kindSlug-normalizes the kind (Organization === organization)', () => {
    expect(computeEnrichmentGap('Organization', ['founded in 2000']).missing).toEqual(
      computeEnrichmentGap('organization', ['founded in 2000']).missing,
    );
  });

  it('an unrecognized kind falls back to the default facet set', () => {
    const gap = computeEnrichmentGap('quasar', []);
    const labels = DEFAULT_FACETS.map((f) => f.label);
    expect(gap.missing).toEqual(labels);
  });

  it('cue detection is case-insensitive (normalizeTerm lowercases the haystack)', () => {
    const gap = computeEnrichmentGap('person', ['STUDIED at MIT, earned a PhD']);
    expect(gap.present).toContain('education');
  });
});

describe('isEnrichmentGap — foreign/legacy-tolerant shape guard', () => {
  it('accepts a well-formed gap, rejects junk', () => {
    expect(isEnrichmentGap({ present: ['x'], missing: ['y'] })).toBe(true);
    expect(isEnrichmentGap({ present: [], missing: [] })).toBe(true);
    expect(isEnrichmentGap({ present: 'x', missing: [] })).toBe(false);
    expect(isEnrichmentGap({ missing: [] })).toBe(false);
    expect(isEnrichmentGap(null)).toBe(false);
    expect(isEnrichmentGap({ present: [1], missing: [] })).toBe(false);
  });
});
