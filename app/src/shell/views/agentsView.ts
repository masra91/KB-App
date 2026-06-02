// Agents view (SPEC-0027 PANEL-3) — lists the librarian/stage agents with status + key config
// (model, instruction pointer). v1 is **observe-only** (safe knobs / authoring deferred, PANEL §6).
// Thin DOM over the typed IPC (`listAgents`); the catalog + live status live in the main process.
// PANEL-9: a light poll keeps running/idle status fresh (updated in place to avoid flicker); it stops
// when the view is detached. Degrades to a friendly message when no KB / IPC fails (PANEL-9).
import { esc } from '../html';
import type { AgentView } from '../../kb/types';

export async function mountAgents(container: HTMLElement): Promise<void> {
  container.innerHTML = `<div class="card"><h1>🤖 Agents</h1><p class="muted">Loading…</p></div>`;
  await render(container);
  const timer = setInterval(() => {
    if (!document.contains(container)) {
      clearInterval(timer);
      return;
    }
    void refreshStatus(container);
  }, 5000);
}

async function render(container: HTMLElement): Promise<void> {
  let agents: AgentView[];
  try {
    agents = await window.kbApi.listAgents();
  } catch {
    container.innerHTML = `<div class="card"><h1>🤖 Agents</h1><p class="error">Could not load agents right now.</p></div>`;
    return;
  }
  const header = `<h1>🤖 Agents</h1><p class="muted">The librarian agents that run your pipeline. Observe-only — configuration is coming.</p>`;
  if (agents.length === 0) {
    container.innerHTML = `<div class="card">${header}<p class="muted">No agents to show — open a Knowledge Base.</p></div>`;
    return;
  }
  container.innerHTML = `<div class="card">${header}<ul class="agent-list">${agents.map(agentItem).join('')}</ul></div>`;
}

function agentItem(a: AgentView): string {
  return `
    <li class="agent" data-key="${esc(a.key)}">
      <div class="agent-head">
        <span class="agent-label">${esc(a.label)}</span>
        <span class="agent-status status-${esc(a.status)}">${esc(a.status)}</span>
      </div>
      <p class="muted agent-role">${esc(a.role)}</p>
      <dl class="agent-meta">
        <dt>Model</dt><dd>${esc(a.model)}</dd>
        <dt>Instructions</dt><dd><span class="path">${esc(a.instructions)}</span></dd>
      </dl>
    </li>`;
}

/** PANEL-9: refresh only the status badges in place (no full re-render → no flicker). */
async function refreshStatus(container: HTMLElement): Promise<void> {
  let agents: AgentView[];
  try {
    agents = await window.kbApi.listAgents();
  } catch {
    return; // leave the last-known status
  }
  for (const a of agents) {
    const el = container.querySelector<HTMLElement>(`.agent[data-key="${a.key}"] .agent-status`);
    if (el) {
      el.textContent = a.status;
      el.className = `agent-status status-${a.status}`;
    }
  }
}
