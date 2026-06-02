// The deterministic, network-free ResearchFn test fixture (SPEC-0028). Lives under test/ so it can
// never be imported by production; this test guards its egress-floor + non-external-citation props.
import { describe, it, expect } from 'vitest';
import { stubResearchFn, STUB_CITATION_PREFIX } from '../../test/researchStub';
import type { ResearcherConfig, ResearchRequest } from './researchers';

const web: ResearcherConfig = { id: 'web-1', template: 'web', prompt: 'p', egressTier: 'public-web', scope: 'global', budget: { maxToolCalls: 8, maxDepth: 2 }, schedule: 'off', posture: 'guarded', enabled: true };
const req: ResearchRequest = { id: 'req-1', ts: '2026-06-02T00:00:00.000Z', by: { stage: 'decompose', sourceId: 'S1' }, what: 'Project Atlas', why: 'unknown term', context: 'launch codename', dedupKey: 'k' };

describe('stubResearchFn (test fixture)', () => {
  it('returns a finding built only from the request, with a synthetic non-external citation', async () => {
    const f = await stubResearchFn(web, req);
    expect(f.found).toBe(true);
    expect(f.query).toBe('Project Atlas — launch codename'); // request-only (D6a)
    expect(f.note).toContain('Project Atlas');
    expect(f.note).toContain('no external fetch');
    expect(f.note).not.toMatch(/slice|phase/i); // never emits internal process naming
    expect(f.citations).toEqual([`${STUB_CITATION_PREFIX}web-1`]); // clearly marked non-external
    // It must NOT fabricate an external URL (no http) — a fixture can't masquerade as a web source.
    expect(f.citations.some((c) => /^https?:/i.test(c))).toBe(false);
  });

  it('is deterministic (same request → same finding)', async () => {
    expect(await stubResearchFn(web, req)).toEqual(await stubResearchFn(web, req));
  });
});
