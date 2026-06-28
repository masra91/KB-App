// Agents view (SPEC-0027 PANEL-3) — lists the librarian/stage agents with status + key config
// (model, instruction pointer). v1 is **observe-only** (safe knobs / authoring deferred, PANEL §6).
// Thin DOM over the typed IPC (`listAgents`); the catalog + live status live in the main process.
// PANEL-9: a light poll keeps running/idle status fresh (updated in place to avoid flicker); it stops
// when the view is detached. Degrades to a friendly message when no KB / IPC fails (PANEL-9).
import { esc } from '../html';
import { withTimeout, renderLoadError } from '../loadGuard';
import type { AgentView, ModelCatalogView } from '../../kb/types';

// Mounted as the **Librarians** section of the Agents hub (SPEC-0053 WS-E) — the hub owns the group
// header/naming, so this section drops its own page-title h1 and renders the librarian list directly.
export async function mountAgents(container: HTMLElement): Promise<void> {
  container.innerHTML = `<div class="card"><p class="agent-note">Loading…</p></div>`;
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
    renderLoadError(container, '', () => void render(container));
    return;
  }
  // SPEC-0048: the model picker's data — best-effort, isolated so a probe miss (or an older client
  // without the IPC) never blocks the agent list; the control just omits when absent (ENG-15/16).
  let catalog: ModelCatalogView | null = null;
  try {
    catalog = await withTimeout(window.kbApi.getModelCatalog());
  } catch {
    catalog = null;
  }
  const header = `<p class="agent-note">The librarian agents that run your pipeline.</p>`;
  if (agents.length === 0) {
    container.innerHTML = `<div class="card">${header}<p class="agent-note">No agents to show — open a Knowledge Base.</p></div>`;
    return;
  }
  container.innerHTML = `<div class="card">${header}${modelControlHtml(catalog)}<ul class="agent-list">${agents.map((a) => agentItem(a, catalog)).join('')}</ul></div>`;
  wireModelPicker(container);
  wireAgentPickers(container);
}

/** SPEC-0048 — the global "Default model" picker (the MUST): a styled native `<select>` over the live
 *  CLI catalog + a quiet "runs as: ‹resolved›" caption + a BRASS note when the persisted pick is stale
 *  (no longer in the catalog). Null-tolerant (ENG-15/16): a missing/empty catalog degrades to a
 *  resolved-only readout (no dropdown) rather than throwing. */
function modelControlHtml(catalog: ModelCatalogView | null): string {
  if (!catalog) return ''; // no catalog data → omit the control (the agent rows still show the model)
  const accepted = Array.isArray(catalog.accepted) ? catalog.accepted : [];
  const configured = catalog.configured ?? '';
  const resolved = catalog.resolved || '—';
  // The CLI couldn't be probed → can't offer a fresh list; show the resolved readout only.
  if (accepted.length === 0) {
    return `<div class="model-control"><span class="model-label">Default model</span>` +
      `<p class="model-runs">runs as: <span class="path">${esc(resolved)}</span></p></div>`;
  }
  const options = [`<option value=""${configured ? '' : ' selected'}>Auto (in-app default)</option>`]
    .concat(accepted.map((m) => `<option value="${esc(m)}"${m === configured ? ' selected' : ''}>${esc(m)}</option>`))
    .join('');
  // .model-stale carries the brass needs-you color (design-system.css) — never oxide.
  const stale = catalog.staleConfigured
    ? `<p class="model-stale" role="status">${esc(configured)} isn't available on this CLI — running ${esc(resolved)}.</p>`
    : '';
  return `<div class="model-control">
    <label class="model-label" for="model-default">Default model</label>
    <select id="model-default" class="viz-select model-select">${options}</select>
    <p class="model-runs">runs as: <span class="path">${esc(resolved)}</span></p>
    ${stale}
  </div>`;
}

/** Wire the global picker: on change, persist via `setModel` (validated server-side) and update the
 *  "runs as" caption + clear the stale note in place. Re-renders on a rejected pick (shouldn't happen —
 *  options are catalog-valid — but keeps the view honest if the catalog shifted mid-session). */
function wireModelPicker(container: HTMLElement): void {
  const select = container.querySelector<HTMLSelectElement>('#model-default');
  if (!select) return;
  select.addEventListener('change', () => {
    const id = select.value; // '' = clear the override (Auto)
    select.disabled = true;
    void window.kbApi
      .setModel(id.length > 0 ? id : null)
      .then((res) => {
        const runs = container.querySelector<HTMLElement>('.model-control .model-runs .path');
        if (runs) runs.textContent = res.resolved;
        // A successful set clears any prior stale note (the pick is now valid + applied).
        if (res.ok) container.querySelector('.model-stale')?.remove();
      })
      .catch((): void => {
        void render(container); // IPC failure → reload to a known state
      })
      .finally(() => {
        select.disabled = false;
      });
  });
}

/** SPEC-0048 — wire the per-agent pickers: on change, persist via `setAgentModel(key, id)` (validated
 *  server-side) and update THAT agent's "runs as" caption in place. A delegated listener so it survives
 *  the row set; `''` clears the agent's override (→ global default). */
function wireAgentPickers(container: HTMLElement): void {
  for (const select of Array.from(container.querySelectorAll<HTMLSelectElement>('.agent-model-select'))) {
    select.addEventListener('change', () => {
      const key = select.dataset.agent ?? '';
      const id = select.value; // '' = clear → use the global default
      if (!key) return;
      select.disabled = true;
      void window.kbApi
        .setAgentModel(key, id.length > 0 ? id : null)
        .then((res) => {
          const runs = container.querySelector<HTMLElement>(`.agent[data-key="${key}"] .agent-model-runs .path`);
          if (runs) runs.textContent = res.resolved;
        })
        .catch((): void => {
          void render(container);
        })
        .finally(() => {
          select.disabled = false;
        });
    });
  }
}

function agentItem(a: AgentView, catalog: ModelCatalogView | null): string {
  return `
    <li class="agent" data-key="${esc(a.key)}">
      <div class="agent-head">
        <span class="agent-label">${esc(a.label)}</span>
        <span class="agent-status viz-chip status-${esc(a.status)}">${esc(a.status)}</span>
      </div>
      <p class="agent-role">${esc(a.role)}</p>
      <dl class="agent-meta">
        <dt>Model</dt><dd>${agentModelCell(a, catalog)}</dd>
        <dt>Instructions</dt><dd><span class="path">${esc(a.instructions)}</span></dd>
      </dl>
    </li>`;
}

/** SPEC-0048 — the per-agent Model cell: a `.viz-select` over the live catalog (first option "Use
 *  default (‹global›)" so clearing an override is obvious; the agent's configured pick selected) + a
 *  "runs as: ‹resolved›" caption. ENG-15/16 degradation: a deterministic agent, or a missing/empty
 *  catalog, falls back to the plain resolved-model text — never a broken control. */
function agentModelCell(a: AgentView, catalog: ModelCatalogView | null): string {
  const accepted = catalog && Array.isArray(catalog.accepted) ? catalog.accepted : [];
  if (a.model === 'deterministic' || accepted.length === 0) return `<span class="agent-model-text">${esc(a.model)}</span>`;
  const configured = a.configuredModel ?? '';
  const options = [`<option value=""${configured ? '' : ' selected'}>Use default (${esc(catalog?.resolved ?? '—')})</option>`]
    .concat(accepted.map((m) => `<option value="${esc(m)}"${m === configured ? ' selected' : ''}>${esc(m)}</option>`))
    .join('');
  return `<select class="viz-select agent-model-select" data-agent="${esc(a.key)}" aria-label="Model for ${esc(a.label)}">${options}</select>` +
    `<span class="model-runs agent-model-runs">runs as: <span class="path">${esc(a.model)}</span></span>`;
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
