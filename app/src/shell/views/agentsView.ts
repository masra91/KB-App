// Agents view (SPEC-0027 PANEL-3) — lists the librarian/stage agents with status + key config
// (model, instruction pointer). v1 is **observe-only** (safe knobs / authoring deferred, PANEL §6).
// Thin DOM over the typed IPC (`listAgents`); the catalog + live status live in the main process.
// PANEL-9: a light poll keeps running/idle status fresh (updated in place to avoid flicker); it stops
// when the view is detached. Degrades to a friendly message when no KB / IPC fails (PANEL-9).
import { esc } from '../html';
import { withTimeout, renderLoadError } from '../loadGuard';
import type { AgentView } from '../../kb/types';

export async function mountAgents(container: HTMLElement): Promise<void> {
  container.innerHTML = `<div class="card"><h1>🤖 Agents</h1><p class="muted">Loading…</p></div>`;
  await render(container);
  const timer = setInterval(() => {
    if (!document.contains(container)) {
      clearInterval(timer);
      return;
    }
    // Skip the status IPC when the Agents view isn't the one showing (the shell mounts once + toggles
    // `.hidden`, so the container stays in the DOM) or the window is backgrounded — don't poll status
    // no one is looking at.
    if (container.classList.contains('hidden') || document.hidden) return;
    void refreshStatus(container);
  }, 5000);
}

async function render(container: HTMLElement): Promise<void> {
  let agents: AgentView[];
  try {
    // #145: bound the wait so a hung `listAgents` shows a retryable error, never an infinite spinner.
    agents = await withTimeout(window.kbApi.listAgents());
  } catch {
    renderLoadError(container, '<h1>🤖 Agents</h1>', () => void render(container));
    return;
  }
  const header = `<h1>🤖 Agents</h1><p class="agent-note">The librarian agents that run your pipeline. Observe-only — configuration is coming.</p>`;
  if (agents.length === 0) {
    container.innerHTML = `<div class="card">${header}<p class="agent-note">No agents to show — open a Knowledge Base.</p></div>`;
    return;
  }
  container.innerHTML = `<div class="card">${header}<ul class="agent-list">${agents.map(agentItem).join('')}</ul></div>`;
}

function agentItem(a: AgentView): string {
  return `
    <li class="agent" data-key="${esc(a.key)}">
      <div class="agent-head">
        <span class="agent-label">${esc(a.label)}</span>
        <span class="agent-status viz-chip status-${esc(a.status)}">${esc(a.status)}</span>
      </div>
      <p class="agent-role">${esc(a.role)}</p>
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
      // Keep the blessed .viz-chip primitive on the in-place status refresh (PANEL-9) — a bare
      // `agent-status status-*` here would strip the chip styling on the first poll.
      el.className = `agent-status viz-chip status-${a.status}`;
    }
  }
}
