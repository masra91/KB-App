// SPEC-0060 VUX-16 — the content-stable finding key + the DRIFT GUARD. healthFindingKey.ts inlines
// blockKey/normalizeName to stay renderer-safe (no connect import); this test imports the REAL
// connect.blockKey (node tier) and asserts the inlined entity key matches it exactly — so the renderer's
// key can never drift from the backend's and silently miss a stored dismissal (the #500 boundary fix).
import { describe, it, expect } from 'vitest';
import { healthFindingKey } from './healthFindingKey';
import { blockKey } from './connect';
import type { HealthFinding, DanglingLink } from './healthPanel';

const entityF = (name: string, kind: string): HealthFinding => ({ rel: `entities/x/${name}.md`, id: 'x', name, kind });

describe('healthFindingKey (VUX-16)', () => {
  it('entity key matches connect.blockKey EXACTLY (no drift) across punctuation/whitespace/case', () => {
    for (const [name, kind] of [
      ['Ada Lovelace', 'person'],
      ['  The   Analytical Engine ', 'concept'],
      ['Walt Disney Co.', 'organization'],
      ['Café Société', 'place'],
      ['UPPER lower', 'Concept'],
    ] as const) {
      expect(healthFindingKey('orphan', entityF(name, kind))).toBe(`orphan:${blockKey(kind, name)}`);
      expect(healthFindingKey('thin', entityF(name, kind))).toBe(`thin:${blockKey(kind, name)}`);
    }
  });

  it('a dangling key normalizes the from-name + target (collapse/trim/lowercase)', () => {
    const d: DanglingLink = { from: 'entities/x/c.md', fromName: '  Steve  Park ', target: 'Entities/Ghost/Z.md' };
    expect(healthFindingKey('dangling', d)).toBe('dangling:steve park→entities/ghost/z.md');
  });

  it('is content-stable — the same finding always yields the same key (replay-safe, no ULID)', () => {
    const k1 = healthFindingKey('orphan', entityF('Project Atlas', 'project'));
    const k2 = healthFindingKey('orphan', entityF('Project Atlas', 'project'));
    expect(k1).toBe(k2);
    expect(k1).toBe('orphan:project|project atlas');
  });
});
