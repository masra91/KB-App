// The librarian/stage agent catalog (SPEC-0027 PANEL-3) — the Principal-facing list of agents the
// Control Panel's Agents view observes. v1 is **observe-only** (status + key config: model +
// instruction pointer); full agent authoring (editing prompts, per-agent model, new agents) is
// deferred (PANEL §6). Static metadata here; the live bits (resolved model, running/idle status)
// are filled by the main-process helper, which knows the env-requested model + whether the pipeline
// is active. Kept in sync with the pipeline's stage wiring + `resolveJobBehavior`.
import type { AgentView } from './types';

/** Static metadata for one librarian/stage agent (PANEL-3). */
export interface AgentCatalogEntry {
  key: string;
  label: string;
  role: string;
  /** Pointer to where the agent's behavior/instructions live (a module today; an editable file later). */
  instructions: string;
  /** Whether the agent runs a model (Copilot) vs. deterministic logic — drives the displayed model. */
  agentBacked: boolean;
}

/** The librarian/stage agents, in pipeline order (PANEL-3). Recall + Reflect follow the Enrich stages. */
export const AGENT_CATALOG: AgentCatalogEntry[] = [
  { key: 'archivist', label: 'Archivist', role: 'Routes and archives each captured source verbatim.', instructions: 'kb/copilotAgent.ts', agentBacked: true },
  { key: 'decompose', label: 'Decompose', role: 'Extracts candidate entities from each source.', instructions: 'kb/decomposeAgent.ts', agentBacked: true },
  { key: 'connect', label: 'Connect', role: 'Resolves candidates into canonical entities and links them.', instructions: 'kb/connectAgent.ts', agentBacked: true },
  { key: 'claims', label: 'Claims', role: 'Derives claims for entities and raises reviews when unsure.', instructions: 'kb/claimsAgent.ts', agentBacked: true },
  { key: 'recall', label: 'Recall (Ask)', role: 'Answers grounded questions over the KB on demand.', instructions: 'kb/recallAgent.ts', agentBacked: true },
  { key: 'reflect', label: 'Reflect', role: 'Periodic rumination — surfaces missed structure, links, and stale topics.', instructions: 'kb/reflectAgent.ts', agentBacked: true },
];

/** Live context the view-model needs: the env-requested model and whether the pipeline is running. */
export interface AgentLiveContext {
  /** The Copilot model the agents launch with (env-requested), or undefined to show Copilot's default. */
  requestedModel?: string;
  /** True when a KB pipeline is active — agent-backed stages are then "running" (PANEL-9). */
  pipelineActive: boolean;
}

/**
 * Build the Agents view rows (PANEL-3) — pure: overlay live status + resolved model onto the static
 * catalog. Agent-backed agents show the env-requested model (or "Copilot (default)"); a deterministic
 * agent shows "deterministic". Status is `running` when the pipeline is active, else `idle` (PANEL-9).
 */
export function buildAgentViews(catalog: AgentCatalogEntry[], ctx: AgentLiveContext): AgentView[] {
  const model = ctx.requestedModel && ctx.requestedModel.length > 0 ? ctx.requestedModel : 'Copilot (default)';
  return catalog.map((a) => ({
    key: a.key,
    label: a.label,
    role: a.role,
    model: a.agentBacked ? model : 'deterministic',
    instructions: a.instructions,
    status: ctx.pipelineActive ? 'running' : 'idle',
  }));
}
