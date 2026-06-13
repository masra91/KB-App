// SPEC-0042 EVAL Slice-3 — the validators added for the jobs + research scenarios (fileExists/fileContains/
// sourcesContain). Pure over a VaultSnapshot; deterministic CI smoke.
import { describe, it, expect } from 'vitest';
import { VALIDATORS } from './validators';
import type { VaultSnapshot } from './snapshot';

function snap(partial: Partial<VaultSnapshot>): VaultSnapshot {
  return { root: '/tmp/v', entities: [], claims: [], sources: [], outputs: [], recall: null, audit: [], spans: [], devLog: [], ...partial };
}

describe('fileExists', () => {
  const s = snap({ outputs: [{ path: 'outputs/example/entity-census.md', body: '# Entity census\n\n0 entities.' }] });
  it('passes when a file matches by suffix', () => {
    expect(VALIDATORS.fileExists(s, { path: 'outputs/example/entity-census.md' }).pass).toBe(true);
    expect(VALIDATORS.fileExists(s, { path: 'entity-census.md' }).pass).toBe(true);
  });
  it('fails when no file matches', () => {
    expect(VALIDATORS.fileExists(s, { path: 'outputs/nope.md' }).pass).toBe(false);
  });
});

describe('fileContains', () => {
  const s = snap({ outputs: [{ path: 'outputs/example/entity-census.md', body: '# Entity census\n\n0 canonical entities.' }] });
  it('passes on a case-insensitive substring hit', () => {
    expect(VALIDATORS.fileContains(s, { path: 'entity-census.md', text: 'entity census' }).pass).toBe(true);
  });
  it('fails when the file lacks the text', () => {
    expect(VALIDATORS.fileContains(s, { path: 'entity-census.md', text: 'COBOL' }).pass).toBe(false);
  });
  it('fails (loudly) when the file is absent', () => {
    expect(VALIDATORS.fileContains(s, { path: 'missing.md', text: 'x' }).pass).toBe(false);
  });
});

describe('sourcesContain', () => {
  const s = snap({ sources: [{ path: 'sources/01abc/source.md', body: 'Finding about COBOL — see https://en.wikipedia.org/wiki/COBOL' }] });
  it('passes when a source carries the fact / citation', () => {
    expect(VALIDATORS.sourcesContain(s, { text: 'COBOL' }).pass).toBe(true);
    expect(VALIDATORS.sourcesContain(s, { text: 'en.wikipedia.org/wiki/COBOL' }).pass).toBe(true);
  });
  it('fails when no source contains the text', () => {
    expect(VALIDATORS.sourcesContain(s, { text: 'Fortran' }).pass).toBe(false);
  });
});
