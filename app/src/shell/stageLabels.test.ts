// #4 — stage/actor display-name map. Node tier (pure lookup). GUARDRAIL: display-only — it must never
// alter the canonical id (the vault/audit/wikilinks depend on the lowercase id).
import { describe, it, expect } from 'vitest';
import { stageDisplayName } from './stageLabels';

describe('stageDisplayName (#4, display-only)', () => {
  it('maps the known stages/actors to readable names', () => {
    expect(stageDisplayName('claims')).toBe('Claim extraction');
    expect(stageDisplayName('connect')).toBe('Connect');
    expect(stageDisplayName('archivist')).toBe('Archiving');
    expect(stageDisplayName('decompose')).toBe('Decompose');
    expect(stageDisplayName('panel')).toBe('Control Panel'); // not "Review" — avoids the Reviews-queue collision
  });

  it('falls back to a Title-cased label for an unknown id (acceptable until added)', () => {
    expect(stageDisplayName('newstage')).toBe('Newstage');
  });

  it('ENG-15/16: a null/undefined/empty actor degrades to "" instead of THROWING (legacy audit data)', () => {
    // A legacy/partial audit event can reach the render layer with a null actor (unchecked parse cast);
    // a raw titleCase(null) threw and — inside an unguarded feed .map — blanked the whole feed.
    expect(() => stageDisplayName(null as unknown as string)).not.toThrow();
    expect(stageDisplayName(null as unknown as string)).toBe('');
    expect(stageDisplayName(undefined as unknown as string)).toBe('');
    expect(stageDisplayName('')).toBe('');
  });

  it('is a one-way lookup — the canonical id passed in is never mutated', () => {
    const id = 'claims';
    const label = stageDisplayName(id);
    expect(label).toBe('Claim extraction');
    expect(id).toBe('claims'); // unchanged — the stored value the vault/audit use stays lowercase
  });
});
