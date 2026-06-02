// SPEC-0032 VIZ §9 / VIZ-3 — funnel conversion counts read from current vault state.
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readConversionCounts } from './conversionCounts';

let staging = '';
let main = '';

beforeEach(async () => {
  staging = await fs.mkdtemp(path.join(os.tmpdir(), 'kb-conv-staging-'));
  main = await fs.mkdtemp(path.join(os.tmpdir(), 'kb-conv-main-'));
});
afterEach(async () => {
  await fs.rm(staging, { recursive: true, force: true });
  await fs.rm(main, { recursive: true, force: true });
});

async function write(root: string, rel: string, body = 'x'): Promise<void> {
  const full = path.join(root, rel);
  await fs.mkdir(path.dirname(full), { recursive: true });
  await fs.writeFile(full, body, 'utf8');
}

/** A well-formed entity node (findEntityFiles + parseEntityNode want kind/name/derivedFrom). */
async function writeEntity(root: string, id: string): Promise<void> {
  await write(root, `entities/people/${id}.md`, ['---', 'kind: person', `name: "${id}"`, 'provenance:', '  derivedFrom: ["sources/s1"]', '---', `# ${id}`, ''].join('\n'));
}

describe('readConversionCounts (VIZ-3 funnel)', () => {
  it('counts each funnel bucket from current vault state (date-sharded)', async () => {
    // captured: 2 sources (one source.md each, date-sharded)
    await write(staging, 'sources/2026/01/01ABC/source.md');
    await write(staging, 'sources/2026/02/01DEF/source.md');
    // candidates: 3 .json (decompose output)
    await write(staging, 'candidates/2026/01/c1.json');
    await write(staging, 'candidates/2026/01/c2.json');
    await write(staging, 'candidates/2026/02/c3.json');
    // entities: 2 deduped nodes
    await writeEntity(staging, '01E1');
    await writeEntity(staging, '01E2');
    // claims: 4 .md
    for (const c of ['cl1', 'cl2', 'cl3', 'cl4']) await write(staging, `claims/2026/01/${c}.md`);
    // promoted: 1 source on main
    await write(main, 'sources/2026/01/01ABC/source.md');

    expect(await readConversionCounts(staging, main)).toEqual({
      captured: 2, candidates: 3, entities: 2, claims: 4, promoted: 1,
    });
  });

  it('counts source.md (one per source dir), not every file under sources/', async () => {
    await write(staging, 'sources/2026/01/01ABC/source.md');
    await write(staging, 'sources/2026/01/01ABC/audit.jsonl'); // not a source.md → not counted
    await write(staging, 'sources/2026/01/01ABC/raw.txt');     // ditto
    const c = await readConversionCounts(staging, main);
    expect(c.captured).toBe(1);
  });

  it('is all-zero + never throws on an empty/absent vault', async () => {
    expect(await readConversionCounts(staging, main)).toEqual({ captured: 0, candidates: 0, entities: 0, claims: 0, promoted: 0 });
    expect(await readConversionCounts('/no/such/staging', '/no/such/main')).toEqual({ captured: 0, candidates: 0, entities: 0, claims: 0, promoted: 0 });
  });

  it('promoted reads from main, independent of staging', async () => {
    await write(staging, 'sources/2026/01/a/source.md'); // captured on staging
    await write(main, 'sources/2026/01/a/source.md');
    await write(main, 'sources/2026/01/b/source.md'); // 2 promoted on main
    const c = await readConversionCounts(staging, main);
    expect(c.captured).toBe(1);
    expect(c.promoted).toBe(2);
  });
});
