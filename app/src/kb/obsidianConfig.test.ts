// SPEC-0031 VAULT-2/5/6/10 — the shipped/maintained `.obsidian/` config. Pure builders are asserted
// directly; the write path runs against a throwaway temp dir (real fs) to prove it's non-destructive.
import { describe, it, expect } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { makeTempDir, rmTempDir } from '../../test/tempVault';
import {
  buildGraphConfig,
  buildColorGroups,
  buildAppConfig,
  obsidianFiles,
  ensureObsidianConfig,
  OBSIDIAN_DIR,
} from './obsidianConfig';

async function withTempDir(fn: (root: string) => Promise<void>): Promise<void> {
  const dir = await makeTempDir();
  try {
    await fn(dir);
  } finally {
    await rmTempDir(dir);
  }
}

describe('graph config (VAULT-2/5 — entities-only, tag-colored)', () => {
  it('scopes the graph to entities/ so claims/sources/raw/outputs are NOT nodes (VAULT-2)', () => {
    const g = buildGraphConfig();
    expect(g.search).toBe('path:entities/');
    // tags as nodes off (tags color, they aren't graph nodes); attachments off
    expect(g.showTags).toBe(false);
    expect(g.showAttachments).toBe(false);
  });

  it('colors each entity kind by its `type/<kind>` tag in the Vellum palette (VAULT-5)', () => {
    const groups = buildColorGroups();
    const person = groups.find((x) => x.query === 'tag:#type/person');
    expect(person).toBeDefined();
    expect(person!.color.rgb).toBe(0x2f6b5b); // viridian, as a decimal RGB int
    expect(person!.color.a).toBe(1);
    // every group keys off a type/<kind> tag — the form connectDoc writes
    expect(groups.every((x) => x.query.startsWith('tag:#type/'))).toBe(true);
    expect(groups.length).toBeGreaterThanOrEqual(5);
  });
});

describe('app config (VAULT-12 alignment)', () => {
  it('keeps wiki-style [[links]] (not markdown) + auto-updates links on rename', () => {
    const a = buildAppConfig();
    expect(a.useMarkdownLinks).toBe(false); // matches connectDoc/claimDoc wikilink output
    expect(a.alwaysUpdateLinks).toBe(true); // a Connect rename never orphans the graph
  });
});

describe('ensureObsidianConfig — ships + maintains, non-destructively (VAULT-5/6/10)', () => {
  it('creates the .obsidian/ files when absent, as valid JSON', async () => {
    await withTempDir(async (root) => {
      const created = await ensureObsidianConfig(root);
      expect(created.sort()).toEqual(Object.keys(obsidianFiles()).sort());
      // graph.json is real, parseable JSON with our filter
      const graph = JSON.parse(await fs.readFile(path.join(root, OBSIDIAN_DIR, 'graph.json'), 'utf8'));
      expect(graph.search).toBe('path:entities/');
      expect(Array.isArray(graph.colorGroups)).toBe(true);
    });
  });

  it('is a no-op on the second call — idempotent / Replay-stable (VAULT-10)', async () => {
    await withTempDir(async (root) => {
      await ensureObsidianConfig(root);
      const secondPass = await ensureObsidianConfig(root);
      expect(secondPass).toEqual([]); // nothing re-created
    });
  });

  it('NEVER clobbers a Principal’s manual edits (VAULT-6)', async () => {
    await withTempDir(async (root) => {
      // The user hand-tuned their graph before/after first launch.
      const graphPath = path.join(root, OBSIDIAN_DIR, 'graph.json');
      await fs.mkdir(path.join(root, OBSIDIAN_DIR), { recursive: true });
      const userGraph = '{"search":"path:my-custom-view","colorGroups":[]}';
      await fs.writeFile(graphPath, userGraph, 'utf8');

      const created = await ensureObsidianConfig(root);
      expect(created).not.toContain(path.join(OBSIDIAN_DIR, 'graph.json')); // left their file alone
      expect(await fs.readFile(graphPath, 'utf8')).toBe(userGraph); // byte-for-byte preserved
      // …but the still-absent files (app.json/appearance.json) WERE shipped
      expect(created).toContain(path.join(OBSIDIAN_DIR, 'app.json'));
    });
  });
});
