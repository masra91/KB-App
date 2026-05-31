import { describe, it, expect } from 'vitest';
import { renderEntityMd, transformedByLabel } from './entityDoc';
import type { EntityDecision } from './decompose';

const entity: EntityDecision = { kind: 'person', name: 'Steve', confidence: 0.9, mentions: ['call Steve re: Q3'] };

describe('renderEntityMd (DECOMP-5, DECOMP-15)', () => {
  it('writes identity + provenance back to the source', () => {
    const md = renderEntityMd(entity, {
      id: '01JENT',
      derivedFrom: 'sources/2026/05/30/01JSRC',
      createdAt: '2026-05-30T00:00:00Z',
      agent: { via: 'copilot', model: 'gpt-x' },
    });
    expect(md).toContain('id: 01JENT');
    expect(md).toContain('kind: person');
    expect(md).toContain('name: Steve');
    expect(md).toContain('confidence: 0.9');
    expect(md).toContain('derivedFrom: ["sources/2026/05/30/01JSRC"]');
    expect(md).toContain('mentions: ["call Steve re: Q3"]');
    expect(md).toContain('# Steve');
  });

  it('carries NO status field in v1 (DECOMP-15)', () => {
    const md = renderEntityMd(entity, { id: '01JENT', derivedFrom: 'sources/x', createdAt: '2026-05-30T00:00:00Z' });
    expect(md).not.toMatch(/^status:/m);
  });

  it('records a truthful transforming agent (ORCH-16)', () => {
    expect(transformedByLabel({ via: 'copilot', model: 'gpt-x' })).toContain('copilot (gpt-x)');
    expect(transformedByLabel(undefined)).toBe('decompose');
  });

  it('quotes YAML-significant names safely', () => {
    const md = renderEntityMd({ ...entity, name: 'Q3: budget' }, { id: '1', derivedFrom: 's', createdAt: 't' });
    expect(md).toContain('name: "Q3: budget"');
  });
});
