// Candidate file render/layout tests (SPEC-0021 STAGING-5). The on-disk candidate is Connect's
// input contract, so the round-trip property under test is: renderCandidate → validCandidate
// reproduces the candidate exactly (no field drift between the writer here and the reader in
// connect.ts). Pure functions, no FS/git (TEST-2).
import { describe, it, expect } from 'vitest';
import { candidateFileRel, renderCandidate } from './candidateDoc';
import { validCandidate, type Candidate } from './connect';
import { ulid, dateShard, isUlid } from './ulid';

const aCandidate = (over: Partial<Candidate> = {}): Candidate => ({
  id: ulid(),
  sourceId: ulid(),
  kind: 'person',
  name: 'Steve',
  confidence: 0.8,
  mentions: ['Steve', 'call Steve'],
  ...over,
});

describe('candidateFileRel (STAGING-5: candidates/<dateShard>/<id>.json)', () => {
  it('places a candidate under a date shard derived from its own id', () => {
    const id = ulid();
    expect(candidateFileRel(id)).toBe(`candidates/${dateShard(id)}/${id}.json`);
  });

  it('uses the ULID as the filename so folder and id never disagree', () => {
    const id = ulid();
    const rel = candidateFileRel(id);
    const base = rel.split('/').pop()!.replace(/\.json$/, '');
    expect(base).toBe(id);
    expect(isUlid(base)).toBe(true);
  });
});

describe('renderCandidate (STAGING-5: matches Connect’s Candidate contract)', () => {
  it('round-trips through Connect’s validCandidate unchanged', () => {
    const c = aCandidate();
    const parsed = validCandidate(JSON.parse(renderCandidate(c)));
    expect(parsed).toEqual(c);
  });

  it('serializes exactly the six contract fields, in contract order', () => {
    const c = aCandidate();
    const parsed = JSON.parse(renderCandidate(c)) as Record<string, unknown>;
    expect(Object.keys(parsed)).toEqual(['id', 'sourceId', 'kind', 'name', 'confidence', 'mentions']);
  });

  it('is deterministic — same candidate renders byte-identically', () => {
    const c = aCandidate();
    expect(renderCandidate(c)).toBe(renderCandidate(c));
  });

  it('preserves an open-vocabulary kind verbatim (DATA-6)', () => {
    const parsed = validCandidate(JSON.parse(renderCandidate(aCandidate({ kind: 'budget-line-item' }))));
    expect(parsed.kind).toBe('budget-line-item');
  });
});
