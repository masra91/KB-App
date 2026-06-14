// SPEC-0051 COHERE-3 — the cohesion metric must distinguish a healthy clustered graph from BOTH
// failure modes (islands AND hairball), not just measure orphan%. These tests pin that discrimination
// on synthetic graphs (pure, deterministic) + the vault entity-file → graph build.
import { describe, it, expect } from 'vitest';
import { computeCohesion, detectCommunities, buildEntityGraph, cohesionFromFiles, type GraphNode, type GraphEdge } from './cohesion';

const nodes = (...ids: string[]): GraphNode[] => ids.map((id) => ({ id }));
const edge = (from: string, to: string): GraphEdge => ({ from, to });

// Two 3-cliques joined by a single bridge edge — the canonical "clear community structure" graph.
const TWO_CLIQUES: { nodes: GraphNode[]; edges: GraphEdge[] } = {
  nodes: nodes('a1', 'a2', 'a3', 'b1', 'b2', 'b3'),
  edges: [
    edge('a1', 'a2'), edge('a2', 'a3'), edge('a1', 'a3'),
    edge('b1', 'b2'), edge('b2', 'b3'), edge('b1', 'b3'),
    edge('a1', 'b1'), // the bridge
  ],
};

// A complete graph (everyone links everyone) — the hairball.
function completeGraph(k: number): { nodes: GraphNode[]; edges: GraphEdge[] } {
  const ids = Array.from({ length: k }, (_, i) => `n${i}`);
  const es: GraphEdge[] = [];
  for (let i = 0; i < k; i++) for (let j = i + 1; j < k; j++) es.push(edge(ids[i], ids[j]));
  return { nodes: nodes(...ids), edges: es };
}

describe('computeCohesion — failure-mode discrimination', () => {
  it('empty graph → all zeros (no NaNs)', () => {
    const m = computeCohesion([], []);
    expect(m).toEqual({ nodes: 0, edges: 0, communities: 0, modularity: 0, crossClusterRatio: 0, giantComponentShare: 0, orphanShare: 0 });
  });

  it('ISLANDS: nodes with no edges → low giant-component-share + full orphanShare', () => {
    const m = computeCohesion(nodes('a', 'b', 'c', 'd', 'e'), []);
    expect(m.edges).toBe(0);
    expect(m.orphanShare).toBe(1);
    expect(m.giantComponentShare).toBeCloseTo(1 / 5); // largest component is a lone node
    expect(m.modularity).toBe(0);
    expect(m.crossClusterRatio).toBe(0); // vacuous (no edges)
  });

  it('HEALTHY: two cliques + bridge → high modularity, low cross-cluster, full giant component, no orphans', () => {
    const m = computeCohesion(TWO_CLIQUES.nodes, TWO_CLIQUES.edges);
    expect(m.nodes).toBe(6);
    expect(m.edges).toBe(7);
    expect(m.giantComponentShare).toBe(1); // all connected
    expect(m.orphanShare).toBe(0);
    expect(m.communities).toBe(2); // label-prop recovers the two cliques
    expect(m.modularity).toBeGreaterThan(0.3); // clear structure
    expect(m.crossClusterRatio).toBeCloseTo(1 / 7); // only the bridge crosses
  });

  it('HAIRBALL: complete graph → modularity ≈ 0 even though giant-component-share = 1, no orphans', () => {
    const m = computeCohesion(completeGraph(6).nodes, completeGraph(6).edges);
    expect(m.giantComponentShare).toBe(1); // fully connected …
    expect(m.orphanShare).toBe(0); // … and no orphans …
    expect(Math.abs(m.modularity)).toBeLessThan(0.05); // … but modularity ≈ 0 flags the blob
  });

  it('giantComponentShare catches two disconnected halves (each a clique, no bridge)', () => {
    const noBridge = TWO_CLIQUES.edges.filter((e) => !(e.from === 'a1' && e.to === 'b1'));
    const m = computeCohesion(TWO_CLIQUES.nodes, noBridge);
    expect(m.giantComponentShare).toBeCloseTo(3 / 6); // largest component = one clique of 3
    expect(m.modularity).toBeGreaterThan(0.4); // two perfect communities
  });

  it('normalizes duplicate + self-loop edges and ignores edges to unknown nodes', () => {
    const m = computeCohesion(nodes('a', 'b'), [edge('a', 'b'), edge('b', 'a'), edge('a', 'a'), edge('a', 'ghost')]);
    expect(m.edges).toBe(1); // a—b once; self-loop + reverse-dup + unknown-endpoint dropped
    expect(m.orphanShare).toBe(0);
  });

  it('an explicit partition overrides detection (modularity scored against the given clusters)', () => {
    // Score the two-clique graph against a deliberately-wrong all-in-one partition → low modularity.
    const allOne = new Map(TWO_CLIQUES.nodes.map((n) => [n.id, 'X']));
    const m = computeCohesion(TWO_CLIQUES.nodes, TWO_CLIQUES.edges, allOne);
    expect(m.communities).toBe(1);
    expect(Math.abs(m.modularity)).toBeLessThan(0.05); // one community → Q ≈ 0
  });
});

describe('detectCommunities — deterministic', () => {
  it('is reproducible across runs and recovers the two cliques', () => {
    const norm = TWO_CLIQUES.edges.map((e) => (e.from < e.to ? [e.from, e.to] : [e.to, e.from]) as [string, string]);
    const ids = TWO_CLIQUES.nodes.map((n) => n.id);
    const a = detectCommunities(ids, norm);
    const b = detectCommunities(ids, norm);
    expect([...a.entries()].sort()).toEqual([...b.entries()].sort());
    expect(a.get('a1')).toBe(a.get('a2'));
    expect(a.get('a1')).toBe(a.get('a3'));
    expect(a.get('a1')).not.toBe(a.get('b1'));
  });
});

// ── buildEntityGraph (vault entity files → graph) ─────────────────────────────────────────────

const entity = (kind: string, name: string, links: string[] = []): { path: string; body: string } => ({
  path: `entities/${kind}/${name}.md`,
  body: `---\nid: 01${name.replace(/\W/g, '').toUpperCase()}\nkind: ${kind}\nname: ${name}\n---\n${links.map((l) => `- [[${l}]]`).join('\n')}\n`,
});

describe('buildEntityGraph — resolution', () => {
  it('resolves rendered path-form links to entity→entity edges', () => {
    const files = [
      entity('person', 'Grace Hopper', ['entities/person/Alan Turing.md|Alan Turing']),
      entity('person', 'Alan Turing'),
    ];
    const { nodes: ns, edges } = buildEntityGraph(files);
    expect(ns).toHaveLength(2);
    expect(edges).toEqual([{ from: 'entities/person/Grace Hopper.md', to: 'entities/person/Alan Turing.md' }]);
  });

  it('resolves a BARE [[Name]] when it uniquely names one entity (matches linkOne resolution)', () => {
    const files = [
      entity('person', 'Harrie', ['Mason Allen']), // bare name, no path
      entity('person', 'Mason Allen'),
    ];
    const { edges } = buildEntityGraph(files);
    expect(edges).toEqual([{ from: 'entities/person/Harrie.md', to: 'entities/person/Mason Allen.md' }]);
  });

  it('drops dangling, ambiguous, and self links; skips foreign/malformed files', () => {
    const files = [
      entity('person', 'Solo', ['Nobody', 'Solo']), // dangling + self
      { path: 'entities/person/foreign.md', body: 'no frontmatter here' }, // malformed → skipped, not a node
    ];
    const { nodes: ns, edges } = buildEntityGraph(files);
    expect(ns).toEqual([{ id: 'entities/person/Solo.md' }]);
    expect(edges).toEqual([]); // 'Nobody' dangling, 'Solo' is self
  });

  it('a bare name matching TWO entities is ambiguous → not an edge', () => {
    const files = [
      entity('person', 'Caller', ['John Smith']),
      { path: 'entities/person/John Smith A.md', body: `---\nid: 01A\nkind: person\nname: John Smith\n---\n` },
      { path: 'entities/person/John Smith B.md', body: `---\nid: 01B\nkind: person\nname: John Smith\n---\n` },
    ];
    const { edges } = buildEntityGraph(files);
    expect(edges).toEqual([]); // two "John Smith" → ambiguous, never guess
  });

  it('cohesionFromFiles wires build→compute end to end', () => {
    const files = [
      entity('person', 'A', ['B']),
      entity('person', 'B', ['A']),
      entity('person', 'C'), // orphan
    ];
    const m = cohesionFromFiles(files);
    expect(m.nodes).toBe(3);
    expect(m.edges).toBe(1);
    expect(m.orphanShare).toBeCloseTo(1 / 3);
  });
});
