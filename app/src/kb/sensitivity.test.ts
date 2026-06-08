// SENSE comparator + egress/orient gate (SPEC-0043 §4, SENSE-3/9). The load-bearing security unit —
// tested exhaustively as a standalone pure module, including the fails-before/passes-after regression that
// a `public-web` researcher can NOT read non-`shareable` KB content during orient (the leak the gate stops).
import { describe, it, expect } from 'vitest';
import {
  SENSITIVITY_LABELS,
  DEFAULT_SENSITIVITY,
  MOST_RESTRICTIVE_RANK,
  restrictiveness,
  isAtMostAsRestrictiveAs,
  mostRestrictive,
  TIER_MAX_ORIENT_READ_RANK,
  sensitivityAllowsOrientRead,
} from './sensitivity';
import { EGRESS_TIERS, type EgressTier } from './researchers';

describe('SENSE comparator — restrictiveness (SENSE-3, §4)', () => {
  it('ranks the known labels per §4', () => {
    expect(restrictiveness('shareable')).toBe(0);
    expect(restrictiveness('internal')).toBe(1);
    expect(restrictiveness('confidential')).toBe(2);
    expect(restrictiveness('private-opinion')).toBe(3);
    expect(restrictiveness('embargoed')).toBe(3);
  });

  it('resolves an UNKNOWN/custom label most-restrictive — unknown ≠ safe (D1)', () => {
    expect(restrictiveness('totally-made-up')).toBe(MOST_RESTRICTIVE_RANK);
    expect(restrictiveness('Confidential')).toBe(MOST_RESTRICTIVE_RANK); // case-sensitive: not the known label
    expect(restrictiveness('')).toBe(MOST_RESTRICTIVE_RANK);
    // A label that collides with an Object prototype key must NOT read as rank 0 (hasOwnProperty guard).
    expect(restrictiveness('toString')).toBe(MOST_RESTRICTIVE_RANK);
    expect(restrictiveness('constructor')).toBe(MOST_RESTRICTIVE_RANK);
  });

  it('the default is `internal` and is a known mid-rank label (SENSE-2)', () => {
    expect(DEFAULT_SENSITIVITY).toBe('internal');
    expect(SENSITIVITY_LABELS).toContain(DEFAULT_SENSITIVITY);
    expect(restrictiveness(DEFAULT_SENSITIVITY)).toBe(1);
  });

  it('isAtMostAsRestrictiveAs orders by rank', () => {
    expect(isAtMostAsRestrictiveAs('shareable', 'confidential')).toBe(true);
    expect(isAtMostAsRestrictiveAs('confidential', 'shareable')).toBe(false);
    expect(isAtMostAsRestrictiveAs('internal', 'internal')).toBe(true); // equal ranks
    expect(isAtMostAsRestrictiveAs('shareable', 'unknown-x')).toBe(true); // unknown is most-restrictive
  });
});

describe('SENSE comparator — mostRestrictive (SENSE-6 propagation primitive)', () => {
  it('returns the highest-ranked label, preserving the actual string', () => {
    expect(mostRestrictive(['shareable', 'confidential', 'internal'])).toBe('confidential');
    expect(mostRestrictive(['shareable', 'shareable'])).toBe('shareable');
  });
  it('a custom/unknown source dominates (most-restrictive wins)', () => {
    expect(mostRestrictive(['shareable', 'internal', 'need-to-know-x'])).toBe('need-to-know-x');
  });
  it('private-opinion/embargoed dominate confidential', () => {
    expect(mostRestrictive(['confidential', 'embargoed'])).toBe('embargoed');
  });
  it('an empty set falls back to the conservative default (SENSE-2)', () => {
    expect(mostRestrictive([])).toBe(DEFAULT_SENSITIVITY);
  });
});

describe('SENSE egress/orient gate — sensitivityAllowsOrientRead (SENSE-9, D6 map)', () => {
  it('maps each egress tier to the ratified D6 max rank', () => {
    expect(TIER_MAX_ORIENT_READ_RANK['public-web']).toBe(0);
    expect(TIER_MAX_ORIENT_READ_RANK['internal-tenant']).toBe(2);
    expect(TIER_MAX_ORIENT_READ_RANK['local-only']).toBe(MOST_RESTRICTIVE_RANK);
  });

  it('public-web may read ONLY shareable (D6)', () => {
    expect(sensitivityAllowsOrientRead('public-web', 'shareable')).toBe(true);
    expect(sensitivityAllowsOrientRead('public-web', 'internal')).toBe(false);
    expect(sensitivityAllowsOrientRead('public-web', 'confidential')).toBe(false);
    expect(sensitivityAllowsOrientRead('public-web', 'private-opinion')).toBe(false);
    expect(sensitivityAllowsOrientRead('public-web', 'embargoed')).toBe(false);
  });

  it('internal-tenant may read shareable/internal/confidential, NOT private-opinion/embargoed (D6)', () => {
    expect(sensitivityAllowsOrientRead('internal-tenant', 'shareable')).toBe(true);
    expect(sensitivityAllowsOrientRead('internal-tenant', 'internal')).toBe(true);
    expect(sensitivityAllowsOrientRead('internal-tenant', 'confidential')).toBe(true);
    expect(sensitivityAllowsOrientRead('internal-tenant', 'private-opinion')).toBe(false);
    expect(sensitivityAllowsOrientRead('internal-tenant', 'embargoed')).toBe(false);
  });

  it('local-only may read ANY label, including private-opinion/embargoed (D6)', () => {
    for (const label of [...SENSITIVITY_LABELS, 'some-custom-label']) {
      expect(sensitivityAllowsOrientRead('local-only', label)).toBe(true);
    }
  });

  it('SECURITY (fails-before/passes-after): an UNKNOWN label fails CLOSED for every non-local tier', () => {
    // The leak this prevents: a typo'd/custom label must never be read by an egressing researcher.
    // Before the gate (or with a naive "unknown = allow"), this would let confidential-ish content out.
    expect(sensitivityAllowsOrientRead('public-web', 'oops-typo')).toBe(false);
    expect(sensitivityAllowsOrientRead('internal-tenant', 'oops-typo')).toBe(false);
    expect(sensitivityAllowsOrientRead('local-only', 'oops-typo')).toBe(true); // local never egresses → allowed
  });

  it('SECURITY: no egress tier maps above its D6 ceiling — exhaustive over the real EGRESS_TIERS', () => {
    // Trace against the real researcher tier list so a new tier can never silently default to "read all".
    const expected: Record<EgressTier, number> = { 'public-web': 0, 'internal-tenant': 2, 'local-only': 3 };
    for (const tier of EGRESS_TIERS) {
      expect(TIER_MAX_ORIENT_READ_RANK[tier]).toBe(expected[tier]);
    }
  });
});
