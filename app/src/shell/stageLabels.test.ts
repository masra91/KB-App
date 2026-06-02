// #4 — stage/actor display-name map. Node tier (pure lookup). GUARDRAIL: display-only — it must never
// alter the canonical id (the vault/audit/wikilinks depend on the lowercase id).
import { describe, it, expect } from 'vitest';
import { stageDisplayName } from './stageLabels';

describe('stageDisplayName (#4, display-only)', () => {
  it('maps the known stages/actors to readable names', () => {
    expect(stageDisplayName('claims')).toBe('Claim extraction');
    expect(stageDisplayName('connect')).toBe('Linking');
    expect(stageDisplayName('archivist')).toBe('Archiving');
    expect(stageDisplayName('decompose')).toBe('Decompose');
    expect(stageDisplayName('panel')).toBe('Control Panel'); // not "Review" — avoids the Reviews-queue collision
  });

  it('falls back to a Title-cased label for an unknown id (acceptable until added)', () => {
    expect(stageDisplayName('newstage')).toBe('Newstage');
  });

  it('is a one-way lookup — the canonical id passed in is never mutated', () => {
    const id = 'claims';
    const label = stageDisplayName(id);
    expect(label).toBe('Claim extraction');
    expect(id).toBe('claims'); // unchanged — the stored value the vault/audit use stays lowercase
  });
});
