// Render an entity node's `<ULID>.md` (SPEC-0015 §3.2): a versioned knowledge-graph node
// derived from a source, carrying identity + confidence + provenance back to that source.
// Hand-rolled YAML (flat + one nested `provenance` block) — no yaml dependency (ENG-5),
// matching sourceDoc.ts. v1 carries confidence + evidence but NO `status` (DECOMP-15).
import type { EntityDecision } from './decompose';
import type { AgentTrace } from './archivist';

/** Quote a scalar only when it contains YAML-significant characters. */
function scalar(s: string): string {
  return /[:#'"\n]|^\s|\s$/.test(s) ? JSON.stringify(s) : s;
}

/** A YAML flow-sequence of quoted strings, e.g. `["a", "b"]`. */
function flowSeq(items: string[]): string {
  return `[${items.map((s) => JSON.stringify(s)).join(', ')}]`;
}

/** A truthful `transformedBy` from the decision's agent trace (ORCH-16). */
export function transformedByLabel(agent?: AgentTrace): string {
  if (agent?.via === 'copilot') return `decompose · copilot (${agent.model ?? 'default'})`;
  return 'decompose';
}

export interface EntityNodeMeta {
  id: string; // orchestrator-minted entity ULID
  derivedFrom: string; // repo-relative path to the source dir (provenance; DATA-5)
  createdAt: string; // ISO timestamp
  agent?: AgentTrace;
}

/**
 * Render one entity node. The body is just an H1 of the name — v1 nodes are an index;
 * substance ABOUT them (claims) is a deferred later stage (SPEC-0015 §6).
 */
export function renderEntityMd(entity: EntityDecision, meta: EntityNodeMeta): string {
  const fm: string[] = [
    `id: ${meta.id}`,
    `kind: ${scalar(entity.kind)}`,
    `name: ${scalar(entity.name)}`,
    `confidence: ${entity.confidence}`,
    'provenance:',
    `  derivedFrom: ${flowSeq([meta.derivedFrom])}`,
    `  transformedBy: ${scalar(transformedByLabel(meta.agent))}`,
    `  mentions: ${flowSeq(entity.mentions)}`,
    `createdAt: ${meta.createdAt}`,
  ];
  return `---\n${fm.join('\n')}\n---\n\n# ${entity.name}\n`;
}
