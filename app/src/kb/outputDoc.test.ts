// SPEC-0026 ASK-6 / DATA-4 — the recall Output-note builder (F6 template). Node tier (pure).
import { describe, it, expect } from 'vitest';
import { buildRecallOutput, RECALL_OUTPUT_DIR } from './outputDoc';
import type { AskResult } from './recall';

const NOW = '2026-06-02T16:00:00.000Z';

function result(over: Partial<AskResult> = {}): AskResult {
  return {
    question: 'Who was Ada Lovelace?',
    answer: '**Ada Lovelace** is regarded as the first computer programmer. [1]',
    citations: [{ kind: 'entity', ref: 'entities/person/ada-lovelace.md', label: 'Ada Lovelace' }],
    grounded: true,
    toolCalls: 2,
    truncated: false,
    ...over,
  };
}

describe('buildRecallOutput (ASK-6)', () => {
  it('writes under outputs/recall/<id>.md with an inert, agent-generated frontmatter', () => {
    const { rel, markdown } = buildRecallOutput(result(), 'OUT1', NOW);
    expect(rel).toBe(`${RECALL_OUTPUT_DIR}/OUT1.md`);
    expect(rel.startsWith('outputs/')).toBe(true); // evergreen, inert (F2) — never under sources/
    expect(markdown).toContain('type: output');
    expect(markdown).toContain('kind: recall-answer');
    expect(markdown).toContain('id: OUT1');
    expect(markdown).toContain(`created: ${NOW}`);
    expect(markdown).toContain('generated: recall'); // marks it agent-generated → stages skip it
    expect(markdown).toContain('question: "Who was Ada Lovelace?"'); // JSON-quoted (safe)
    expect(markdown).toContain('grounded: true');
  });

  it('renders the title, the grounded banner, the answer (inline [n] kept), and an Evidence section', () => {
    const { markdown } = buildRecallOutput(result(), 'OUT1', NOW);
    expect(markdown).toContain('# Who was Ada Lovelace?');
    expect(markdown).toContain('grounded against 1 citation.');
    expect(markdown).toContain('first computer programmer. [1]'); // inline citation marker preserved
    expect(markdown).toContain('## Evidence');
  });

  it('renders a cited ENTITY as a [[wikilink]] (provenance into the graph) — by label, else basename', () => {
    const byLabel = buildRecallOutput(result(), 'OUT1', NOW);
    expect(byLabel.markdown).toContain('- [[Ada Lovelace]]');
    const byBase = buildRecallOutput(result({ citations: [{ kind: 'entity', ref: 'entities/x/grace-hopper.md' }] }), 'OUT2', NOW);
    expect(byBase.markdown).toContain('- [[grace-hopper]]');
  });

  it('renders claims/sources as path refs (not wikilinks)', () => {
    const { markdown } = buildRecallOutput(
      result({
        citations: [
          { kind: 'claim', ref: 'claims/person/ada/c1.md', label: 'first programmer' },
          { kind: 'source', ref: 'sources/2026/01/abc/' },
        ],
      }),
      'OUT3',
      NOW,
    );
    expect(markdown).toContain('- Claim: `claims/person/ada/c1.md` — first programmer');
    expect(markdown).toContain('- Source: `sources/2026/01/abc/`');
  });

  it('flags an ungrounded answer prominently and records grounded:false (saving is allowed, F4)', () => {
    const { markdown } = buildRecallOutput(result({ grounded: false, citations: [] }), 'OUT4', NOW);
    expect(markdown).toContain('grounded: false');
    expect(markdown).toContain('⚠️ Not grounded — inferred');
    expect(markdown).not.toContain('## Evidence'); // no citations → no evidence section
  });

  it('collapses + caps a long question into a single-line title', () => {
    const long = 'Tell me   everything\nabout '.padEnd(140, 'x') + '?';
    const { markdown } = buildRecallOutput(result({ question: long }), 'OUT5', NOW);
    const titleLine = markdown.split('\n').find((l) => l.startsWith('# '))!;
    expect(titleLine.length).toBeLessThanOrEqual(2 + 80);
    expect(titleLine).not.toContain('\n');
    expect(titleLine).toContain('…');
  });
});
