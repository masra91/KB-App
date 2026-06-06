// Pure tests for the archivist decider (SPEC-0014 ORCH-7 / CAPTURE-10) and the source.md
// renderer (SPEC-0013 §3). No FS/git.
import { describe, it, expect } from 'vitest';
import { deterministicDecide } from './archivist';
import { renderSourceMd, bodyFor, archivedByLabel } from './sourceDoc';
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

const fileMeta: CapturedMeta = {
  id: '01JABCGHI7Q2ABCDEFGHJKMNPQ',
  kind: 'file',
  raw: 'raw.png',
  contentHash: 'sha256:def',
  capturedAt: '2026-05-30T18:22:04.000Z',
  surface: 'in-app-panel',
  captureBatch: '01JB00000000000000000BATCH',
  originalName: 'screenshot.png',
  mimeType: 'image/png',
  bytes: 48213,
};

describe('deterministicDecide (ORCH-7 / CAPTURE-10)', () => {
  it('returns conservative primary/global/internal defaults, echoing kind + a deterministic trace', () => {
    expect(deterministicDecide(textMeta)).toEqual({ kind: 'text', class: 'primary', scope: 'global', sensitivity: 'internal', agent: { via: 'deterministic' } });
    expect(deterministicDecide(fileMeta).kind).toBe('file');
  });
});

describe('archivedByLabel (ORCH-16)', () => {
  it('labels a successful copilot decision with its model', () => {
    expect(archivedByLabel({ via: 'copilot', runtime: 'copilot', model: 'default', ok: true })).toBe('copilot (default)');
    expect(archivedByLabel({ via: 'copilot', model: 'gpt-5', ok: true })).toBe('copilot (gpt-5)');
  });
  it('labels a deterministic fallback after a copilot failure with the reason', () => {
    expect(archivedByLabel({ via: 'deterministic', runtime: 'copilot', ok: false, error: 'timeout' })).toBe('deterministic (copilot failed: timeout)');
  });
  it('labels copilot-unavailable and plain deterministic', () => {
    expect(archivedByLabel({ via: 'deterministic', error: 'copilot unavailable' })).toBe('deterministic (copilot unavailable)');
    expect(archivedByLabel({ via: 'deterministic' })).toBe('deterministic');
    expect(archivedByLabel(undefined)).toBe('deterministic');
  });
});

describe('bodyFor', () => {
  it('text → the content; file → an embed of the raw payload', () => {
    expect(bodyFor(textMeta, 'call Steve')).toBe('call Steve');
    expect(bodyFor(fileMeta, null)).toBe('![[raw.png]]');
  });
  it('text with no content yields an empty body', () => {
    expect(bodyFor(textMeta, null)).toBe('');
  });
});

describe('renderSourceMd (SPEC-0013 §3)', () => {
  it('emits class/provenance frontmatter and the text body', () => {
    const md = renderSourceMd(textMeta, deterministicDecide(textMeta), '2026-05-30T18:22:09.000Z', 'call Steve');
    expect(md).toContain('id: 01JABCDEF7Q2ABCDEFGHJKMNPQ');
    expect(md).toContain('class: primary');
    expect(md).toContain('kind: text');
    expect(md).toContain('scope: global');
    expect(md).toContain('sensitivity: internal');
    expect(md).toContain('raw: raw.txt');
    expect(md).toContain('capturedAt: 2026-05-30T18:22:04.000Z');
    expect(md).toContain('archivedAt: 2026-05-30T18:22:09.000Z');
    expect(md).toContain('provenance:');
    expect(md).toContain('  origin: principal');
    expect(md).toContain('  surface: in-app-panel');
    expect(md).toContain('  captureBatch: 01JB00000000000000000BATCH');
    expect(md.trimEnd().endsWith('call Steve')).toBe(true);
    expect(md.startsWith('---\n')).toBe(true);
  });

  it('includes file-specific fields and the embed body', () => {
    const md = renderSourceMd(fileMeta, deterministicDecide(fileMeta), '2026-05-30T18:22:09.000Z', '![[raw.png]]');
    expect(md).toContain('originalName: screenshot.png');
    expect(md).toContain('mimeType: image/png');
    expect(md).toContain('bytes: 48213');
    expect(md).toContain('![[raw.png]]');
  });

  it('ORCH-16: archivedBy reflects the decision agent (copilot vs deterministic)', () => {
    const copilot = { ...deterministicDecide(textMeta), agent: { via: 'copilot' as const, model: 'default', ok: true } };
    expect(renderSourceMd(textMeta, copilot, 'now', 'x')).toContain('archivedBy: copilot (default)');
    const det = deterministicDecide(textMeta);
    expect(renderSourceMd(textMeta, det, 'now', 'x')).toContain('archivedBy: deterministic');
  });

  it('quotes YAML-significant scalars (e.g. a name with a colon)', () => {
    const md = renderSourceMd({ ...fileMeta, originalName: 'a: b.png' }, deterministicDecide(fileMeta), 'now', 'x');
    expect(md).toContain('originalName: "a: b.png"');
  });

  it('RICHIN-10: emits a clip provenance block for a derived (rich-paste) text source', () => {
    const richMeta: CapturedMeta = { ...textMeta, raw: 'raw.md', clip: { format: 'html→md', original: 'original.html' } };
    const md = renderSourceMd(richMeta, deterministicDecide(richMeta), 'now', '# Title');
    expect(md).toContain('clip:');
    expect(md).toContain('  format: html→md');
    expect(md).toContain('  original: original.html');
  });

  it('RICHIN-10: omits the clip block when there is no derivation (plain text)', () => {
    const md = renderSourceMd(textMeta, deterministicDecide(textMeta), 'now', 'plain');
    expect(md).not.toContain('clip:');
  });
});
