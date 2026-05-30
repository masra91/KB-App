// Pure tests for the archivist decider (SPEC-0014 ORCH-7 / CAPTURE-10) and the source.md
// renderer (SPEC-0013 §3). No FS/git.
import { describe, it, expect } from 'vitest';
import { deterministicDecide } from './archivist';
import { renderSourceMd, bodyFor } from './sourceDoc';
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
  it('returns conservative primary/global/internal defaults, echoing kind', () => {
    expect(deterministicDecide(textMeta)).toEqual({ kind: 'text', class: 'primary', scope: 'global', sensitivity: 'internal' });
    expect(deterministicDecide(fileMeta)).toEqual({ kind: 'file', class: 'primary', scope: 'global', sensitivity: 'internal' });
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

  it('quotes YAML-significant scalars (e.g. a name with a colon)', () => {
    const md = renderSourceMd({ ...fileMeta, originalName: 'a: b.png' }, deterministicDecide(fileMeta), 'now', 'x');
    expect(md).toContain('originalName: "a: b.png"');
  });
});
