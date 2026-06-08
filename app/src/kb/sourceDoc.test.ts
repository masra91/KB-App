// Pure tests for the archivist decider (SPEC-0014 ORCH-7 / CAPTURE-10) and the source.md
// renderer (SPEC-0013 §3). No FS/git.
import { describe, it, expect } from 'vitest';
import { deterministicDecide } from './archivist';
import { renderSourceMd, bodyFor, archivedByLabel, applySensitivityOverrideToSourceMd } from './sourceDoc';
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
    expect(deterministicDecide(textMeta)).toEqual({ kind: 'text', class: 'primary', scope: 'global', sensitivity: 'internal', sensitivityBy: 'default', agent: { via: 'deterministic' } });
    expect(deterministicDecide(fileMeta).kind).toBe('file');
  });

  it('SENSE-2: no signal → conservative `internal` default with provenance `by: default`', () => {
    const d = deterministicDecide(textMeta);
    expect(d.sensitivity).toBe('internal');
    expect(d.sensitivityBy).toBe('default');
  });

  it('SENSE-5: a connector-declared sensitivity is honored as a high-confidence `by: connector` signal', () => {
    const d = deterministicDecide({ ...textMeta, sensitivity: 'confidential' });
    expect(d.sensitivity).toBe('confidential'); // NOT down-classified to internal
    expect(d.sensitivityBy).toBe('connector');
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
    // SENSE-1/8 (§7): the provenance block beside the scalar label.
    expect(md).toContain('sensitivityMeta:');
    expect(md).toContain('  by: default');
    expect(md).toContain('  at: 2026-05-30T18:22:09.000Z'); // = archivedAt
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

  it('SENSE-5: a connector-signalled source renders its label + `by: connector` provenance (§7)', () => {
    const connMeta: CapturedMeta = { ...textMeta, sensitivity: 'confidential' };
    const md = renderSourceMd(connMeta, deterministicDecide(connMeta), '2026-05-30T18:22:09.000Z', 'x');
    expect(md).toContain('sensitivity: confidential');
    expect(md).toContain('  by: connector');
  });

  it('SENSE-1: a custom/unknown label is preserved and YAML-quoted if needed (not coerced to the enum)', () => {
    const customMeta: CapturedMeta = { ...textMeta, sensitivity: 'need to know: legal' };
    const md = renderSourceMd(customMeta, deterministicDecide(customMeta), 'now', 'x');
    expect(md).toContain('sensitivity: "need to know: legal"'); // quoted (colon) + preserved verbatim
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

describe('applySensitivityOverrideToSourceMd (SENSE-7)', () => {
  it('re-stamps a SENSE-1a source: new label + by: principal + the override at, dropping the old block', () => {
    const md = renderSourceMd(textMeta, deterministicDecide(textMeta), '2026-05-30T18:22:09.000Z', 'body');
    expect(md).toContain('  by: default'); // precondition
    const out = applySensitivityOverrideToSourceMd(md, 'shareable', '2026-06-08T09:00:00.000Z');
    expect(out).toContain('sensitivity: shareable');
    expect(out).toContain('  by: principal');
    expect(out).toContain('  at: 2026-06-08T09:00:00.000Z');
    expect(out).not.toContain('  by: default'); // the old block is gone (single sensitivityMeta block)
    expect(out.match(/sensitivityMeta:/g)?.length).toBe(1);
    expect(out.startsWith('---\n')).toBe(true); // structure intact
  });

  it('upgrades a PRE-SENSE source (no sensitivityMeta block): injects the principal block', () => {
    const legacy = `---\nid: X\nclass: primary\nscope: global\nsensitivity: internal\nraw: raw.md\n---\n\nbody\n`;
    const out = applySensitivityOverrideToSourceMd(legacy, 'confidential', '2026-06-08T09:00:00.000Z');
    expect(out).toContain('sensitivity: confidential');
    expect(out).toContain('sensitivityMeta:\n  by: principal\n  at: 2026-06-08T09:00:00.000Z');
    expect(out).toContain('raw: raw.md'); // surrounding frontmatter untouched
  });

  it('quotes a custom override label with YAML-significant chars (SENSE-1 custom labels)', () => {
    const md = renderSourceMd(textMeta, deterministicDecide(textMeta), 'now', 'body');
    const out = applySensitivityOverrideToSourceMd(md, 'legal: hold', 'now');
    expect(out).toContain('sensitivity: "legal: hold"');
  });

  it('REGRESSION: a label containing $-substitution patterns is written verbatim, not interpreted (KB-QD-2 #267)', () => {
    const md = renderSourceMd(textMeta, deterministicDecide(textMeta), 'now', 'body');
    // `$&` would re-insert the whole match, `$1`/`` $` `` other patterns — a string replacer would corrupt
    // the frontmatter; the function replacer writes the label byte-for-byte (here quoted for the `$`/space).
    const out = applySensitivityOverrideToSourceMd(md, 'tier-$& $1 $`', 'now');
    expect(out).toContain('sensitivity: tier-$& $1 $`'); // verbatim ($/backtick aren't YAML-significant → unquoted)
    expect(out).not.toContain('tier-sensitivity:'); // the `$&` did NOT expand to the matched line
  });
});
