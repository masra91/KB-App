// SPEC-0042 EVAL Slice-3 — cassette persistence (fork S3-B). Deterministic CI smoke: parse validation +
// round-trip + the fail-loud guards, AND a guard that the COMMITTED research cassette is clean public-web.
import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import { parseCassette, loadCassette, saveCassette } from './cassetteStore';
import type { Cassette } from './cassette';

describe('parseCassette (fail-fast on a malformed/dirty cassette)', () => {
  it('parses a well-formed public-web cassette', () => {
    const c = parseCassette({ tier: 'public-web', entries: [{ url: 'https://x', status: 200, text: 'ok', truncated: false }] });
    expect(c.entries).toHaveLength(1);
  });
  it('rejects a non-public-web tier', () => {
    expect(() => parseCassette({ tier: 'internal-tenant', entries: [] })).toThrow(/public-web/);
  });
  it('rejects non-array entries', () => {
    expect(() => parseCassette({ tier: 'public-web', entries: {} })).toThrow(/entries must be an array/);
  });
  it('rejects an entry missing required fields', () => {
    expect(() => parseCassette({ tier: 'public-web', entries: [{ url: 'https://x' }] })).toThrow(/status must be a number/);
  });
  it('refuses a dirty cassette (secret survives) — fail-loud', () => {
    expect(() => parseCassette({ tier: 'public-web', entries: [{ url: 'https://x', status: 200, text: 'ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789', truncated: false }] })).toThrow(/secret material/);
  });
});

describe('saveCassette / loadCassette round-trip', () => {
  it('writes + reads back a clean cassette', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'kb-cassette-'));
    try {
      const file = path.join(dir, 'sub', 'c.json');
      const cassette: Cassette = { tier: 'public-web', entries: [{ url: 'https://en.wikipedia.org/wiki/COBOL', status: 200, text: 'COBOL', truncated: false }] };
      await saveCassette(file, cassette);
      const back = await loadCassette(file);
      expect(back).toEqual(cassette);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
  it('loadCassette throws a clear error when the file is missing', async () => {
    await expect(loadCassette('/no/such/cassette.json')).rejects.toThrow(/cassette not found/);
  });
});

describe('committed cassettes are clean public-web (S3-B guardrail, verified)', () => {
  it('eval/cassettes/research-web.json loads + asserts clean', async () => {
    const file = path.resolve(process.cwd(), 'eval/cassettes/research-web.json');
    const c = await loadCassette(file); // throws if dirty / wrong tier
    expect(c.tier).toBe('public-web');
    expect(c.entries.length).toBeGreaterThan(0);
  });
});
