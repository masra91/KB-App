// SPEC-0027 PANEL-3 — Agents view-model. Node tier (pure; the DOM view is covered by jobsView-style tests).
import { describe, it, expect } from 'vitest';
import { AGENT_CATALOG, buildAgentViews, type AgentCatalogEntry } from './agentCatalog';

describe('buildAgentViews (PANEL-3)', () => {
  it('lists the librarian/stage agents with role + instruction pointer', () => {
    const views = buildAgentViews(AGENT_CATALOG, { pipelineActive: true });
    expect(views.map((v) => v.key)).toEqual(['archivist', 'decompose', 'connect', 'claims', 'recall', 'reflect']);
    for (const v of views) {
      expect(v.label.length).toBeGreaterThan(0);
      expect(v.role.length).toBeGreaterThan(0);
      expect(v.instructions).toMatch(/^kb\//);
    }
  });

  it('shows the env-requested model for agent-backed agents, Copilot default otherwise', () => {
    expect(buildAgentViews(AGENT_CATALOG, { pipelineActive: true, requestedModel: 'gpt-x' })[0].model).toBe('gpt-x');
    expect(buildAgentViews(AGENT_CATALOG, { pipelineActive: true })[0].model).toBe('Copilot (default)');
  });

  it('marks a deterministic agent’s model accordingly', () => {
    const catalog: AgentCatalogEntry[] = [{ key: 'det', label: 'Det', role: 'r', instructions: 'kb/x.ts', agentBacked: false }];
    expect(buildAgentViews(catalog, { pipelineActive: true, requestedModel: 'gpt-x' })[0].model).toBe('deterministic');
  });

  it('reflects live status: running when the pipeline is active, else idle (PANEL-9)', () => {
    expect(buildAgentViews(AGENT_CATALOG, { pipelineActive: true })[0].status).toBe('running');
    expect(buildAgentViews(AGENT_CATALOG, { pipelineActive: false })[0].status).toBe('idle');
  });
});
