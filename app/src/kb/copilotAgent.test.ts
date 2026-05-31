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
  it('uses the Copilot session result when available, one fresh session per item, and records the trace (ORCH-5/16)', async () => {
    const run = vi.fn(async () => VALID);
    const decide = makeCopilotDecider({ available: true, run });
    const d = await decide(textMeta);
    await decide(fileMeta);
    expect(run).toHaveBeenCalledTimes(2); // a disposable session per item (ORCH-5)
    expect(d.agent).toMatchObject({ via: 'copilot', runtime: 'copilot', model: 'default', ok: true, params: ['--no-ask-user'] });
    expect(typeof d.agent?.ms).toBe('number');
    expect(typeof d.agent?.at).toBe('string');
  });

  it('ORCH-16: records the requested model when KB_COPILOT_MODEL is set', async () => {
    vi.stubEnv('KB_COPILOT_MODEL', 'claude-x');
    try {
      const d = await makeCopilotDecider({ available: true, run: async () => VALID })(textMeta);
      expect(d.agent?.model).toBe('claude-x');
      expect(d.agent?.params).toEqual(['--no-ask-user', '--model', 'claude-x']);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('ORCH-16: falls back when Copilot is unavailable and records why (no session run)', async () => {
    const run = vi.fn(async () => VALID);
    const decide = makeCopilotDecider({ available: false, run });
    const d = await decide(textMeta);
    expect(d).toMatchObject({ kind: 'text', class: 'primary', scope: 'global', sensitivity: 'internal' });
    expect(d.agent).toEqual({ via: 'deterministic', error: 'copilot unavailable' });
    expect(run).not.toHaveBeenCalled();
  });

  it('ORCH-16: falls back when the session errors, recording the error', async () => {
    const run = vi.fn(async () => {
      throw new Error('ENOENT: copilot not found');
    });
    const d = await makeCopilotDecider({ available: true, run })(fileMeta);
    expect(d).toMatchObject({ kind: 'file', class: 'primary' });
    expect(d.agent).toMatchObject({ via: 'deterministic', runtime: 'copilot', ok: false });
    expect(d.agent?.error).toContain('ENOENT');
  });

  it('falls back when the session returns unparseable output (recorded as a failure)', async () => {
    const d = await makeCopilotDecider({ available: true, run: async () => 'sorry, I cannot help with that' })(textMeta);
    expect(d.class).toBe('primary');
    expect(d.agent?.via).toBe('deterministic');
    expect(d.agent?.ok).toBe(false);
  });

  it('detects availability lazily when not forced (stubbed available)', async () => {
    const run = vi.fn(async () => VALID);
    const decide = makeCopilotDecider({ run }); // no `available` → uses stubbed detectCopilot
    await decide(textMeta);
    expect(run).toHaveBeenCalledTimes(1);
  });
});
