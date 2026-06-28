// SPEC-0035 HEALTH — pure structural-lint scan (node tier). A fake read-only RecallTools feeds
// controlled entities + node markdown; we assert orphan / dangling-link / thin-stub detection, the
// alias-aware link resolution, the bounded lists vs full counts, and ENG-16 unreadable-node tolerance.
import { describe, it, expect, vi } from 'vitest';
import { buildHealthReport, THIN_BODY_CHARS } from './healthPanel';
import type { RecallTools, EntityHit } from './recall';

function hit(over: Partial<EntityHit> & Pick<EntityHit, 'rel' | 'name'>): EntityHit {
  return { id: over.rel, kind: 'concept', aliases: [], confidence: 0.8, tags: [], derivedFrom: [], ...over };
}

/** A node body: frontmatter + heading + given prose + optional generated links block (raw `[[targets]]`). */
function node(name: string, opts: { prose?: string; links?: string[] } = {}): string {
  const links = opts.links?.length
    ? `\n<!-- kb:links:start (generated — edit via Connect, not here) -->\n${opts.links.map((l) => `- [[${l}]]`).join('\n')}\n<!-- kb:links:end -->\n`
    : '';
  return `---\nid: x\nkind: concept\n---\n# ${name}\n\n${opts.prose ?? ''}\n${links}`;
}

const PROSE = 'x'.repeat(THIN_BODY_CHARS + 50); // comfortably above the stub floor

/** Minimal fake read-only surface: entities by query substring + node markdown by rel. */
function fakeTools(opts: { entities: EntityHit[]; nodes?: Record<string, string> }): RecallTools {
  const nodes = opts.nodes ?? {};
  return {
    entityLookup: vi.fn(async ({ query }: { query: string }) => {
      const n = (query ?? '').toLowerCase();
      return opts.entities.filter((e) => n === '' || e.name.toLowerCase().includes(n));
    }),
    claimsForEntity: vi.fn(async () => []),
    linkTraversal: vi.fn(async () => ({ outgoing: [], incoming: [] })),
    readNode: vi.fn(async ({ rel }: { rel: string }) => nodes[rel] ?? null),
    readSource: vi.fn(async () => null),
    grep: vi.fn(async () => []),
  };
}

const ADA = hit({ rel: 'entities/person/ada.md', name: 'Ada Lovelace', kind: 'person' });
const ENGINE = hit({ rel: 'entities/concept/engine.md', name: 'Analytical Engine', kind: 'concept' });

describe('healthPanel — buildHealthReport', () => {
  it('flags an orphan (0 inbound + 0 outbound) and does not flag a connected node', async () => {
    const tools = fakeTools({
      entities: [ADA, ENGINE, hit({ rel: 'entities/x/lonely.md', name: 'Lonely', kind: 'concept' })],
      nodes: {
        'entities/person/ada.md': node('Ada Lovelace', { prose: PROSE, links: ['entities/concept/engine.md|Analytical Engine'] }),
        'entities/concept/engine.md': node('Analytical Engine', { prose: PROSE }), // inbound from Ada → not orphan
        'entities/x/lonely.md': node('Lonely', { prose: PROSE }), // no links either way → orphan
      },
    });
    const r = await buildHealthReport(tools);
    expect(r.scanned).toBe(3);
    expect(r.orphans.map((o) => o.name)).toEqual(['Lonely']);
    expect(r.counts.orphans).toBe(1);
  });

  it('flags a dangling link (target resolves to no node) but not a resolvable one', async () => {
    const tools = fakeTools({
      entities: [ADA, ENGINE],
      nodes: {
        'entities/person/ada.md': node('Ada Lovelace', { prose: PROSE, links: ['entities/concept/engine.md|Analytical Engine', 'entities/ghost/missing.md|Ghost'] }),
        'entities/concept/engine.md': node('Analytical Engine', { prose: PROSE }),
      },
    });
    const r = await buildHealthReport(tools);
    expect(r.dangling).toHaveLength(1);
    expect(r.dangling[0]).toMatchObject({ from: 'entities/person/ada.md', fromName: 'Ada Lovelace', target: 'entities/ghost/missing.md' });
  });

  it('resolves links by human name and alias (case-insensitive) — not dangling, establishes inbound', async () => {
    const aliased = hit({ rel: 'entities/concept/engine.md', name: 'Analytical Engine', kind: 'concept', aliases: ['The Engine'] });
    const tools = fakeTools({
      entities: [ADA, aliased],
      nodes: {
        // links by bare name + by alias, mixed case — both must resolve
        'entities/person/ada.md': node('Ada Lovelace', { prose: PROSE, links: ['analytical engine', 'THE ENGINE'] }),
        'entities/concept/engine.md': node('Analytical Engine', { prose: PROSE }),
      },
    });
    const r = await buildHealthReport(tools);
    expect(r.dangling).toHaveLength(0); // both resolved
    expect(r.counts.orphans).toBe(0); // engine has inbound, ada has outbound
  });

  it('ignores claims/ and sources/ targets (never entity edges → never dangling)', async () => {
    const tools = fakeTools({
      entities: [hit({ rel: 'entities/person/ada.md', name: 'Ada Lovelace' })],
      nodes: {
        // a node citing a claim + a source — neither is a dangling *entity* link
        'entities/person/ada.md': `---\nid: x\n---\n# Ada Lovelace\n\n${PROSE}\n- [[claims/01H.md]] — a claim\n[[sources/ab/01J/source.md|memo]]`,
      },
    });
    const r = await buildHealthReport(tools);
    expect(r.dangling).toHaveLength(0);
  });

  it('flags a thin/stub node (prose below the floor) but not a fleshed-out one', async () => {
    const tools = fakeTools({
      entities: [hit({ rel: 'entities/x/stub.md', name: 'Stub' }), hit({ rel: 'entities/x/full.md', name: 'Full' })],
      nodes: {
        'entities/x/stub.md': node('Stub', { prose: 'too short' }), // < THIN_BODY_CHARS
        'entities/x/full.md': node('Full', { prose: PROSE }),
      },
    });
    const r = await buildHealthReport(tools);
    expect(r.thin.map((t) => t.name)).toEqual(['Stub']);
    expect(r.counts.thin).toBe(1);
    // the prose char count rides along for the "stub · N chars" defect text (frontmatter/heading stripped)
    expect(r.thin[0].chars).toBe('too short'.length);
  });

  it('treats a heading-only node with empty generated blocks as thin (machinery is not content)', async () => {
    const tools = fakeTools({
      entities: [hit({ rel: 'entities/x/empty.md', name: 'Empty' })],
      nodes: {
        'entities/x/empty.md': `---\nid: x\nkind: concept\n---\n# Empty\n\n<!-- kb:links:start (generated) -->\n_No resolved links yet._\n<!-- kb:links:end -->\n`,
      },
    });
    const r = await buildHealthReport(tools);
    expect(r.thin.map((t) => t.name)).toEqual(['Empty']);
  });

  it('tolerates an unreadable node — skipped for content checks, never throws, still scanned (ENG-16)', async () => {
    const tools = fakeTools({
      entities: [hit({ rel: 'entities/x/a.md', name: 'A' }), hit({ rel: 'entities/x/broken.md', name: 'Broken' })],
      nodes: { 'entities/x/a.md': node('A', { prose: PROSE }) }, // broken.md has no entry → readNode null
    });
    const r = await buildHealthReport(tools);
    expect(r.scanned).toBe(2);
    // broken is unreadable → not flagged thin (can't assess), but still an orphan (no links resolved)
    expect(r.thin.map((t) => t.name)).not.toContain('Broken');
    expect(r.orphans.map((o) => o.name)).toContain('Broken');
  });

  it('caps each rendered list at 50 while counts report the true total', async () => {
    const many = Array.from({ length: 60 }, (_, i) => hit({ rel: `entities/x/n${i}.md`, name: `N${String(i).padStart(2, '0')}` }));
    const nodes: Record<string, string> = {};
    for (const e of many) nodes[e.rel] = node(e.name, { prose: 'tiny' }); // all thin + all orphan
    const r = await buildHealthReport(fakeTools({ entities: many, nodes }));
    expect(r.orphans).toHaveLength(50);
    expect(r.counts.orphans).toBe(60);
    expect(r.thin).toHaveLength(50);
    expect(r.counts.thin).toBe(60);
  });

  it('an empty graph yields a clean zero report', async () => {
    const r = await buildHealthReport(fakeTools({ entities: [] }));
    expect(r).toMatchObject({ scanned: 0, orphans: [], thin: [], dangling: [], counts: { orphans: 0, thin: 0, dangling: 0 } });
  });
});
