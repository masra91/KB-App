// PRIN-24: the pure, renderer-safe item-name guard. The resolution (fs load + deriveSourceTitle)
// happens upstream in the main process; this is the final never-a-ULID gate every surface shares.
import { describe, it, expect } from 'vitest';
import { displayItemName } from './pipelineStatusLabels';
import { UNTITLED_SOURCE } from './sourceDoc';

describe('displayItemName (PRIN-24)', () => {
  const ULID = '01HZESPVN2X1G3QK9M4T7B8C5D'; // 26-char Crockford

  it('returns the resolved name when one is present', () => {
    expect(displayItemName('Quarterly Report.pdf', ULID)).toBe('Quarterly Report.pdf');
  });

  it('NEVER surfaces a raw ULID — an unresolved source id collapses to the shared neutral generic', () => {
    // Fails-before/passes-after: the old roster did `name ?? id` / `name || id`, leaking the ULID.
    expect(displayItemName(undefined, ULID)).toBe(UNTITLED_SOURCE);
    expect(displayItemName('', ULID)).toBe(UNTITLED_SOURCE);
    expect(displayItemName('   ', ULID)).toBe(UNTITLED_SOURCE); // whitespace-only is not a name
    expect(displayItemName(undefined, ULID)).not.toBe(ULID);
  });

  it('shows a non-ULID id as-is (an entity id / connect block key is already human-readable)', () => {
    expect(displayItemName(undefined, 'person|atlas')).toBe('person|atlas');
    expect(displayItemName(undefined, 'E1')).toBe('E1');
    expect(displayItemName(undefined, 'block:engine')).toBe('block:engine');
  });

  it('treats a ULID shape case-insensitively but rejects near-misses (wrong length / excluded letters)', () => {
    expect(displayItemName(undefined, ULID.toLowerCase())).toBe(UNTITLED_SOURCE); // still a ULID
    expect(displayItemName(undefined, ULID.slice(0, 25))).toBe(ULID.slice(0, 25)); // too short → not a ULID, shown as-is
    expect(displayItemName(undefined, 'I'.repeat(26))).toBe('I'.repeat(26)); // 'I' excluded from Crockford → not a ULID
  });
});
