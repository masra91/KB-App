// SPEC-0042 robustness — a deterministic CI guard (no copilot) on the shared corrupted-vault fixture:
// it must KEEP its dangling-ref shape, or the opt-in robustness scenario silently stops exercising the
// crash class. Exactly the corruption DEV-5's #341 fix tolerates: a source whose captured-meta `raw`
// points at `raw.md` but that file is absent on disk (the missing file-ref → ENOENT in decompose).
import { describe, it, expect } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';

const FIX = path.join(process.cwd(), 'eval', 'fixtures', 'corrupted-vault', 'sources');

async function exists(p: string): Promise<boolean> {
  return fs.access(p).then(() => true, () => false);
}

async function sourceDirs(): Promise<string[]> {
  const out: string[] = [];
  async function walk(d: string): Promise<void> {
    for (const e of await fs.readdir(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (!e.isDirectory()) continue;
      if (await exists(path.join(p, 'audit.jsonl'))) out.push(p);
      else await walk(p);
    }
  }
  await walk(FIX);
  return out;
}

describe('corrupted-vault fixture (SPEC-0042 robustness)', () => {
  it('keeps ≥1 source whose meta.raw points at a MISSING raw.md (the dangling file-ref) + ≥1 good source', async () => {
    const dirs = await sourceDirs();
    expect(dirs.length).toBeGreaterThanOrEqual(2);
    let dangling = 0;
    let good = 0;
    for (const d of dirs) {
      const firstLine = (await fs.readFile(path.join(d, 'audit.jsonl'), 'utf8')).split('\n').find((l) => l.trim().length > 0) ?? '{}';
      const meta = JSON.parse(firstLine) as { raw?: string };
      expect(meta.raw).toBe('raw.md'); // the captured meta references raw.md …
      if (await exists(path.join(d, meta.raw ?? 'raw.md'))) good += 1;
      else dangling += 1; // … but the file is ABSENT in the corrupted source (the ENOENT the scenario needs)
    }
    expect(dangling).toBeGreaterThanOrEqual(1);
    expect(good).toBeGreaterThanOrEqual(1);
  });
});
