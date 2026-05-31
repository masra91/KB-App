// Copilot archivist tests (SPEC-0014 ORCH-5/7/8). The subprocess is injected, so these are
// fully deterministic and never need real Copilot credentials (TEST-2).
import { describe, it, expect, vi } from 'vitest';

// detectCopilot is an external subprocess; stub it so the decider's availability is
// controlled and nothing shells out to `copilot`/`gh` during the suite.
vi.mock('./copilot', () => ({
  detectCopilot: vi.fn(async () => ({ available: true, detail: 'stubbed' })),
}));

import { buildPrompt, parseDecision, makeCopilotDecider } from './copilotAgent';
import type { CapturedMeta } from './ingest';

const textMeta: CapturedMeta = {
  id: '01JABCDEF7Q2ABCDEFGHJKMNPQ',
  kind: 'text',
  raw: 'raw.txt',
  contentHash: 'sha256:abc',
  capturedAt: '2026-05-30T18:22:04.000Z',
  surface: 'in-app-panel',
  captureBatch: '01JB00000000000000000BATCH',
  mimeType: 'text/plain',
};
const fileMeta: CapturedMeta = { ...textMeta, kind: 'file', raw: 'raw.png', originalName: 'shot.png', mimeType: 'image/png' };
const VALID = '{"kind":"text","class":"primary","scope":"global","sensitivity":"internal"}';

describe('buildPrompt', () => {
  it('includes the item metadata and asks for a JSON-only response', () => {
    const p = buildPrompt(fileMeta);
    expect(p).toContain('kind: file');
    expect(p).toContain('originalName: shot.png');
    expect(p).toContain('mimeType: image/png');
    expect(p).toContain('ONLY a JSON object');
  });
});

describe('parseDecision (ORCH-8)', () => {
  it('parses a clean JSON decision', () => {
    expect(parseDecision(VALID, textMeta)).toEqual({ kind: 'text', class: 'primary', scope: 'global', sensitivity: 'internal' });
  });
  it('extracts JSON embedded in surrounding prose', () => {
    const out = `Here is the classification:\n${VALID}\nThanks!`;
    expect(parseDecision(out, textMeta).class).toBe('primary');
  });
  it('falls back to the captured kind when the model returns a bad kind', () => {
    const out = '{"kind":"bogus","class":"primary","scope":"global","sensitivity":"internal"}';
    expect(parseDecision(out, fileMeta).kind).toBe('file');
  });
  it('throws when there is no JSON object', () => {
    expect(() => parseDecision('no json here', textMeta)).toThrow(/no JSON object/);
  });
  it('throws on an out-of-policy scope/sensitivity/class', () => {
    expect(() => parseDecision('{"kind":"text","class":"primary","scope":"team","sensitivity":"internal"}', textMeta)).toThrow(/scope/);
    expect(() => parseDecision('{"kind":"text","class":"primary","scope":"global","sensitivity":"secret"}', textMeta)).toThrow(/sensitivity/);
    expect(() => parseDecision('{"kind":"text","class":"nope","scope":"global","sensitivity":"internal"}', textMeta)).toThrow(/class/);
  });
});

describe('makeCopilotDecider (ORCH-5/8)', () => {
  it('uses the Copilot session result when available, one fresh session per item', async () => {
    const run = vi.fn(async () => VALID);
    const decide = makeCopilotDecider({ available: true, run });
    await decide(textMeta);
    await decide(fileMeta);
    expect(run).toHaveBeenCalledTimes(2); // a disposable session per item (ORCH-5)
  });

  it('falls back to the deterministic decision when Copilot is unavailable (no session run)', async () => {
    const run = vi.fn(async () => VALID);
    const decide = makeCopilotDecider({ available: false, run });
    expect(await decide(textMeta)).toEqual({ kind: 'text', class: 'primary', scope: 'global', sensitivity: 'internal' });
    expect(run).not.toHaveBeenCalled();
  });

  it('falls back when the session errors (e.g. CLI missing / timeout)', async () => {
    const run = vi.fn(async () => {
      throw new Error('ENOENT: copilot not found');
    });
    expect(await makeCopilotDecider({ available: true, run })(fileMeta)).toEqual({
      kind: 'file',
      class: 'primary',
      scope: 'global',
      sensitivity: 'internal',
    });
  });

  it('falls back when the session returns unparseable output', async () => {
    const decide = makeCopilotDecider({ available: true, run: async () => 'sorry, I cannot help with that' });
    expect((await decide(textMeta)).class).toBe('primary');
  });

  it('detects availability lazily when not forced (stubbed available)', async () => {
    const run = vi.fn(async () => VALID);
    const decide = makeCopilotDecider({ run }); // no `available` → uses stubbed detectCopilot
    await decide(textMeta);
    expect(run).toHaveBeenCalledTimes(1);
  });
});
