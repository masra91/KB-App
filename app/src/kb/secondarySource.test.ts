// Secondary-source path for researcher findings (SPEC-0028 RESEARCH-5/6): a researcher captures a
// cited findings-note with origin:'secondary' + research provenance, which re-enters the pipeline.
// Covers the capture round-trip (real FS+git) + the source.md provenance rendering (pure).
import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { makeTempDir, rmTempDir } from '../../test/tempVault';
import { createKb } from './vault';
import { captureToInbox, readCapturedMeta } from './ingest';
import { renderSourceMd } from './sourceDoc';
import type { ArchiveDecision } from './archivist';
import type { ResearchProvenance } from './researchers';

const provenance: ResearchProvenance = {
  researcherId: 'web-1',
  requestId: 'req-1',
  query: 'Project Atlas press release',
  citations: ['https://example.com/atlas', 'https://example.com/atlas-faq'],
  fetchedAt: '2026-06-02T00:00:00.000Z',
};

describe('captureToInbox — secondary source (RESEARCH-5)', () => {
  it('stamps origin:secondary + research provenance, recoverable via readCapturedMeta', async () => {
    const dir = await makeTempDir();
    try {
      const root = path.join(dir, 'vault');
      await createKb({ path: root, initGitIfNeeded: true });
      const out = await captureToInbox(root, 'researcher:web-1', [{ kind: 'text', text: 'Atlas is a launch codename. [1][2]' }], Date.now(), {
        origin: 'secondary',
        research: provenance,
      });
      expect(out.committed).toBe(true);
      const meta = await readCapturedMeta(path.join(root, 'inbox', out.ids[0]));
      expect(meta.origin).toBe('secondary');
      expect(meta.research).toEqual(provenance);
    } finally {
      await rmTempDir(dir);
    }
  });

  it('defaults to principal origin + no research block when opts omitted (unchanged behavior)', async () => {
    const dir = await makeTempDir();
    try {
      const root = path.join(dir, 'vault');
      await createKb({ path: root, initGitIfNeeded: true });
      const out = await captureToInbox(root, 'in-app-panel', [{ kind: 'text', text: 'a note' }]);
      const meta = await readCapturedMeta(path.join(root, 'inbox', out.ids[0]));
      expect(meta.origin).toBeUndefined(); // → 'principal' at render
      expect(meta.research).toBeUndefined();
    } finally {
      await rmTempDir(dir);
    }
  });
});

describe('renderSourceMd — research provenance block (RESEARCH-6)', () => {
  const decision: ArchiveDecision = { kind: 'text', class: 'secondary', scope: 'global', sensitivity: 'internal' };
  const baseMeta = {
    id: '01JABCDEF7Q2ABCDEFGHJKMNPQ',
    kind: 'text' as const,
    raw: 'raw.md',
    contentHash: 'sha256:abc',
    capturedAt: '2026-06-02T00:00:00.000Z',
    surface: 'researcher:web-1',
    captureBatch: '01JB00000000000000000BATCH',
  };

  it('emits a citation-rich research block under provenance when present', () => {
    const md = renderSourceMd({ ...baseMeta, origin: 'secondary', research: provenance }, decision, '2026-06-02T00:01:00.000Z', 'body');
    expect(md).toContain('origin: secondary');
    expect(md).toContain('  research:');
    expect(md).toContain('    researcherId: web-1');
    expect(md).toContain('    query: Project Atlas press release');
    expect(md).toContain('    citations:');
    // URLs contain ':' so scalar() YAML-quotes them — assert on the (quoting-agnostic) substring.
    expect(md).toContain('https://example.com/atlas');
    expect(md).toContain('https://example.com/atlas-faq');
    expect(md).toMatch(/citations:\n {6}- /); // rendered as a YAML list under citations
  });

  it('omits the research block for a normal (principal) source', () => {
    const md = renderSourceMd(baseMeta, { ...decision, class: 'primary' }, '2026-06-02T00:01:00.000Z', 'body');
    expect(md).not.toContain('research:');
    expect(md).toContain('origin: principal');
  });
});
