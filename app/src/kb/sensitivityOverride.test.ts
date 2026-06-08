// SENSE Principal-override store (SPEC-0043 SENSE-7). Real FS temp dirs (TEST-18). The store is the
// Replay-sticky home of a Principal's explicit label; the archive re-application is covered end-to-end
// in orchestrator.test.ts.
import { describe, it, expect } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { makeTempDir, rmTempDir } from '../../test/tempVault';
import {
  readSensitivityOverrides,
  writeSensitivityOverrides,
  setSensitivityOverride,
  sensitivityOverridesPath,
} from './sensitivityOverride';

async function withTemp(fn: (root: string) => Promise<void>): Promise<void> {
  const dir = await makeTempDir();
  try {
    await fn(dir);
  } finally {
    await rmTempDir(dir);
  }
}

describe('sensitivity override store (SENSE-7)', () => {
  it('returns {} for a missing or malformed file', async () => {
    await withTemp(async (root) => {
      expect(await readSensitivityOverrides(root)).toEqual({});
      await fs.mkdir(path.dirname(sensitivityOverridesPath(root)), { recursive: true });
      await fs.writeFile(sensitivityOverridesPath(root), 'not json');
      expect(await readSensitivityOverrides(root)).toEqual({});
    });
  });

  it('upserts an override and reads it back; clears it when label is empty', async () => {
    await withTemp(async (root) => {
      await setSensitivityOverride(root, '01JSRC', 'confidential', '2026-06-08T00:00:00Z');
      expect((await readSensitivityOverrides(root))['01JSRC']).toEqual({ label: 'confidential', at: '2026-06-08T00:00:00Z' });
      // re-override (up or down)
      await setSensitivityOverride(root, '01JSRC', 'shareable', '2026-06-08T01:00:00Z');
      expect((await readSensitivityOverrides(root))['01JSRC'].label).toBe('shareable');
      // empty label clears the override (back to classifier/default)
      await setSensitivityOverride(root, '01JSRC', '', '2026-06-08T02:00:00Z');
      expect((await readSensitivityOverrides(root))['01JSRC']).toBeUndefined();
    });
  });

  it('drops a malformed row (no non-empty string label) so a hand-edited file cannot inject a bad label', async () => {
    await withTemp(async (root) => {
      await fs.mkdir(path.dirname(sensitivityOverridesPath(root)), { recursive: true });
      await writeSensitivityOverrides(root, {} as never);
      await fs.writeFile(
        sensitivityOverridesPath(root),
        JSON.stringify({ good: { label: 'confidential', at: 'x' }, bad1: { label: '' }, bad2: { at: 'y' }, bad3: 'nope' }),
      );
      const o = await readSensitivityOverrides(root);
      expect(Object.keys(o)).toEqual(['good']);
    });
  });

  it('supports a custom label verbatim (SENSE-1 custom labels)', async () => {
    await withTemp(async (root) => {
      await setSensitivityOverride(root, 'entity-x', 'legal-hold', '2026-06-08T00:00:00Z');
      expect((await readSensitivityOverrides(root))['entity-x'].label).toBe('legal-hold');
    });
  });
});
