// SPEC-0042 EVAL Slice-1 — scenario schema validation (EVAL-1): a malformed scenario fails FAST with a
// clear error, never a partial run. Pure, deterministic — runs in normal CI (no copilot).
import { describe, it, expect } from 'vitest';
import { validateScenario } from './scenario';

const valid = {
  id: 'x',
  capability: 'decompose',
  seed: { kind: 'empty' },
  actions: [{ ingest: { text: 'hi' } }, { awaitDrain: { stages: ['decompose'] } }, { ask: { query: 'q' } }],
  expect: { deterministic: [{ check: 'entitiesInclude', args: ['Ada'] }] },
};

describe('validateScenario (EVAL-1)', () => {
  it('accepts a well-formed scenario', () => {
    const r = validateScenario(valid);
    expect(r.ok).toBe(true);
    expect(r.scenario?.actions).toHaveLength(3);
  });

  it('rejects a non-object / missing id / unknown capability with a clear error', () => {
    expect(validateScenario(null)).toMatchObject({ ok: false });
    expect(validateScenario({ ...valid, id: '' })).toMatchObject({ ok: false, error: expect.stringMatching(/id/) });
    expect(validateScenario({ ...valid, capability: 'frobnicate' })).toMatchObject({ ok: false, error: expect.stringMatching(/capability/) });
  });

  it('rejects a bad seed (unknown kind, or files/snapshot without a ref)', () => {
    expect(validateScenario({ ...valid, seed: { kind: 'magic' } })).toMatchObject({ ok: false, error: expect.stringMatching(/seed/) });
    expect(validateScenario({ ...valid, seed: { kind: 'files' } })).toMatchObject({ ok: false, error: expect.stringMatching(/ref/) });
    expect(validateScenario({ ...valid, seed: { kind: 'files', ref: 'fixtures/x' } })).toMatchObject({ ok: true });
  });

  it('rejects empty actions and an action without exactly one known verb', () => {
    expect(validateScenario({ ...valid, actions: [] })).toMatchObject({ ok: false, error: expect.stringMatching(/actions/) });
    expect(validateScenario({ ...valid, actions: [{ ingest: {}, ask: {} }] })).toMatchObject({ ok: false, error: expect.stringMatching(/exactly one verb/) });
    expect(validateScenario({ ...valid, actions: [{ bogus: {} }] })).toMatchObject({ ok: false, error: expect.stringMatching(/unknown verb/) });
  });

  it('rejects expect.deterministic entries without a string check name', () => {
    expect(validateScenario({ ...valid, expect: { deterministic: [{ args: [] }] } })).toMatchObject({ ok: false, error: expect.stringMatching(/check/) });
  });
});
