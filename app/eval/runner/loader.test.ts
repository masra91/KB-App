// SPEC-0042 EVAL Slice-1 — scenario loader (EVAL-1). Pure/deterministic — parses YAML + validates; the
// real enrich scenario file must load + validate. Runs in normal CI (no copilot).
import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { parseScenario, loadScenario } from './loader';

describe('parseScenario (YAML → validated Scenario)', () => {
  it('parses + validates well-formed scenario YAML', () => {
    const s = parseScenario(`
id: x
capability: recall
seed: { kind: empty }
actions:
  - ingest: { text: hello }
  - ask: { query: q }
expect:
  deterministic:
    - check: recallCites
      args: { min: 1 }
`);
    expect(s.id).toBe('x');
    expect(s.actions).toHaveLength(2);
  });

  it('throws a clear error on malformed YAML and on a schema violation', () => {
    expect(() => parseScenario('id: [unclosed', 'bad.yaml')).toThrow(/YAML parse error/);
    expect(() => parseScenario('id: x\ncapability: nope\nseed: {kind: empty}\nactions: [{ask: {query: q}}]\nexpect: {}', 'bad2.yaml')).toThrow(/capability/);
  });

  it('loads + validates the real Slice-1 enrich scenario', async () => {
    const s = await loadScenario(path.resolve(process.cwd(), 'eval/scenarios/enrich.yaml'));
    expect(s.id).toBe('enrich-hopper');
    expect(s.capability).toBe('decompose');
    expect(s.actions.some((a) => 'ask' in a)).toBe(true);
    expect((s.expect.deterministic ?? []).map((c) => c.check)).toEqual(
      expect.arrayContaining(['entitiesInclude', 'entitiesExclude', 'claimCitations', 'wikilinkRendered', 'recallCites']),
    );
  });
});
