// Claim file rendering + the entity node's generated claims block (SPEC-0016 CLAIMS-6/9/11).
import { describe, it, expect } from 'vitest';
import { renderClaimMd, transformedByLabel, renderClaimsBlock, applyClaimsBlock, stripClaimsBlock, sourceLink, CLAIMS_BLOCK_START, CLAIMS_BLOCK_END } from './claimDoc';
import type { ClaimDecision } from './claims';

const claim: ClaimDecision = { statement: 'Owns the Q3 budget.', status: 'interpretation', confidence: 0.7, mentions: ['Steve owns the Q3 budget'] };

describe('renderClaimMd (CLAIMS-6, CLAIMS-5)', () => {
  it('writes subject, epistemics, and provenance back to the WHOLE source', () => {
    const md = renderClaimMd(claim, {
      id: '01JCLAIM',
      subject: 'entities/2026/05/30/01JENT.md',
      derivedFrom: 'sources/2026/05/30/01JSRC',
      createdAt: '2026-05-30T00:00:00Z',
      agent: { via: 'copilot', model: 'gpt-x' },
    });
    expect(md).toContain('id: 01JCLAIM');
    expect(md).toContain('subject: entities/2026/05/30/01JENT.md');
    expect(md).toContain('status: interpretation');
    expect(md).toContain('confidence: 0.7');
    expect(md).toContain('derivedFrom: ["sources/2026/05/30/01JSRC"]'); // CLAIMS-5 whole source
    expect(md).toContain('mentions: ["Steve owns the Q3 budget"]');
    expect(md).toContain('transformedBy: claims · copilot (gpt-x)');
    expect(md).toContain('Owns the Q3 budget.'); // statement is the body
    // VAULT-13: a navigable source citation in the claim body (click-through, not just metadata)
    expect(md).toContain('Source: [[sources/2026/05/30/01JSRC/source.md|2026-05-30]]');
  });

  it('emits relatesTo only when present (CLAIMS-10 soft hint)', () => {
    expect(renderClaimMd(claim, { id: '1', subject: 'e', derivedFrom: 's', createdAt: 't' })).not.toMatch(/^relatesTo:/m);
    const withHint = renderClaimMd({ ...claim, relatesTo: ['Austin site'] }, { id: '1', subject: 'e', derivedFrom: 's', createdAt: 't' });
    expect(withHint).toContain('relatesTo: ["Austin site"]');
  });

  it('records a truthful transforming agent (ORCH-16)', () => {
    expect(transformedByLabel({ via: 'copilot', model: 'gpt-x' })).toBe('claims · copilot (gpt-x)');
    expect(transformedByLabel(undefined)).toBe('claims');
  });
});

const entityNode = `---\nid: 01JENT\nkind: person\nname: Steve\nconfidence: 0.9\nprovenance:\n  derivedFrom: ["sources/2026/05/30/01JSRC"]\n  transformedBy: decompose\n  mentions: ["call Steve"]\ncreatedAt: 2026-05-30T00:00:00Z\n---\n\n# Steve\n`;

describe('renderClaimsBlock (CLAIMS-9)', () => {
  it('renders a wikilink row per claim with status + confidence', () => {
    const block = renderClaimsBlock([{ claimPath: 'claims/2026/05/30/01JCLAIM.md', statement: 'Owns the Q3 budget.', status: 'interpretation', confidence: 0.7 }]);
    expect(block).toContain(CLAIMS_BLOCK_START);
    expect(block).toContain('- [[claims/2026/05/30/01JCLAIM.md]] — Owns the Q3 budget. *(interpretation, 0.7)*');
    expect(block).toContain(CLAIMS_BLOCK_END);
  });
  it('uses a placeholder for an entity with zero claims (idempotent re-runs)', () => {
    expect(renderClaimsBlock([])).toContain('_No claims derived yet._');
  });
});

describe('navigable source link (VAULT-13)', () => {
  it('renders [[<dir>/source.md|<date>]] with the capture date as the display label', () => {
    expect(sourceLink('sources/2026/05/30/01JSRC')).toBe('[[sources/2026/05/30/01JSRC/source.md|2026-05-30]]');
  });
  it('falls back to the source-dir id when the path is not date-sharded, and is empty for no source', () => {
    expect(sourceLink('sources/flat/abc123')).toBe('[[sources/flat/abc123/source.md|abc123]]');
    expect(sourceLink('')).toBe('');
  });
  it('adds a navigable source citation to each claims-block row when the backlink knows its source', () => {
    const block = renderClaimsBlock([
      { claimPath: 'claims/2026/05/30/01JCLAIM.md', statement: 'Owns the Q3 budget.', status: 'interpretation', confidence: 0.7, source: 'sources/2026/05/30/01JSRC' },
    ]);
    expect(block).toContain('- [[claims/2026/05/30/01JCLAIM.md]] — Owns the Q3 budget. *(interpretation, 0.7)* · [[sources/2026/05/30/01JSRC/source.md|2026-05-30]]');
  });
  it('omits the citation when a backlink has no source (back-compat for regenerators not yet wired)', () => {
    const block = renderClaimsBlock([{ claimPath: 'claims/x/01JCLAIM.md', statement: 'S.', status: 'fact', confidence: 0.9 }]);
    expect(block).toContain('- [[claims/x/01JCLAIM.md]] — S. *(fact, 0.9)*');
    expect(block).not.toContain('source.md');
  });
});

describe('applyClaimsBlock is idempotent and identity-preserving (CLAIMS-9, CLAIMS-11)', () => {
  const links = [{ claimPath: 'claims/x/01JCLAIM.md', statement: 'Owns the Q3 budget.', status: 'interpretation' as const, confidence: 0.7 }];

  it('appends the block after the heading without touching identity frontmatter or heading (CLAIMS-11)', () => {
    const out = applyClaimsBlock(entityNode, links);
    expect(out).toContain('id: 01JENT'); // identity untouched
    expect(out).toContain('# Steve');
    expect(out).toContain('transformedBy: decompose'); // Decompose-authored provenance untouched
    expect(out).toContain('[[claims/x/01JCLAIM.md]]');
  });

  it('regenerates WHOLE: applying twice yields no duplicate block (CLAIMS-9)', () => {
    const once = applyClaimsBlock(entityNode, links);
    const twice = applyClaimsBlock(once, links);
    expect(twice).toBe(once);
    expect(twice.match(/kb:claims:start/g)).toHaveLength(1);
  });

  it('replaces a stale block with fresh claims rather than appending', () => {
    const first = applyClaimsBlock(entityNode, links);
    const updated = applyClaimsBlock(first, [{ claimPath: 'claims/x/01JCLAIM2.md', statement: 'Attended the offsite.', status: 'fact', confidence: 0.95 }]);
    expect(updated).toContain('01JCLAIM2.md');
    expect(updated).not.toContain('01JCLAIM.md'); // old row gone
    expect(updated.match(/kb:claims:start/g)).toHaveLength(1);
  });

  it('stripClaimsBlock restores a node to its pre-claims body', () => {
    const withBlock = applyClaimsBlock(entityNode, links);
    expect(stripClaimsBlock(withBlock).trimEnd()).toBe(entityNode.trimEnd());
  });
});
