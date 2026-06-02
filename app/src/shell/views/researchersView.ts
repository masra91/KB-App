// Researchers view (SPEC-0028 RESEARCH-15) — a Manage sibling for the Principal's external-enrichment
// agents. Add-from-template, configure (enable/schedule/posture/egress), Run now (a test pass), and
// see last-run (findings + citations). Thin DOM over the typed IPC; the pure logic (view-build +
// risk gate) lives in `kb/researchersPanel` (node-tested). Mirrors jobsView.
//
// Confirm gate (RESEARCH-15, PANEL-7-style): risky changes — enabling a researcher (starts external
// egress), → Autonomous, widening egress — reveal an inline confirm before they apply + audit. The
// view degrades to a friendly message when no KB is active or IPC fails. Read-only viewing needs no
// confirm. Run now executes the real egress-gated cognition (no synthetic data ever reaches a vault).
import { esc } from '../html';
import { withTimeout, renderLoadError } from '../loadGuard';
import {
  schedulePresetLabel,
  SCHEDULE_OPTIONS,
  isRiskyResearcherChange,
  RESEARCHER_TEMPLATE_OPTIONS,
  EGRESS_TIER_LABELS,
  EGRESS_TIER_HINTS,
  defaultEgressFor,
} from '../../kb/researchersPanel';
import { EGRESS_TIERS } from '../../kb/researchers';
import type { ResearcherView, ResearcherConfigPatch } from '../../kb/types';

const POSTURE_LABEL: Record<string, string> = { guarded: 'Guarded', autonomous: 'Autonomous' };

// Template short label + long description (RESEARCH-17): the row badge shows the short label
// (`Public Web` · `WorkIQ/M365` · `Local Repository` · `Custom`); the description is helper text.
const TEMPLATE_BY_KEY = new Map(RESEARCHER_TEMPLATE_OPTIONS.map((o) => [o.template, o]));
const templateLabel = (t: ResearcherView['template']): string => TEMPLATE_BY_KEY.get(t)?.label ?? t;
const templateDesc = (t: ResearcherView['template']): string => TEMPLATE_BY_KEY.get(t)?.description ?? '';
const HEADER = `<h1>🔬 Researchers</h1><p class="muted">Configurable agents that reach outside your KB to corroborate and expand — Web, Code, your work tools. Findings come back as cited sources.</p>`;

export async function mountResearchers(container: HTMLElement): Promise<void> {
  container.innerHTML = `<div class="card">${HEADER}<p class="muted">Loading…</p></div>`;
  await render(container);
}

async function render(container: HTMLElement): Promise<void> {
  let researchers: ResearcherView[];
  try {
    // #145: bound the wait so a hung `listResearchers` shows a retryable error, never an infinite spinner.
    researchers = await withTimeout(window.kbApi.listResearchers());
  } catch {
    renderLoadError(container, HEADER, () => void render(container));
    return;
  }
  const list = researchers.length
    ? `<ul class="researcher-list">${researchers.map(researcherItem).join('')}</ul>`
    : `<p class="muted researcher-empty">No researchers yet — add one from a template below.</p>`;
  container.innerHTML = `<div class="card">${HEADER}${list}${addForm()}</div>`;
  wire(container, researchers);
}

/** The add-from-template control (RESEARCH-15/16): pick a template → create a disabled researcher. */
function addForm(): string {
  // Short option text (#108) — the full description rides along as a hover title, not inline clutter.
  const opts = RESEARCHER_TEMPLATE_OPTIONS.map((o) => `<option value="${esc(o.template)}" title="${esc(o.description)}">${esc(o.label)}</option>`).join('');
  return `
    <div class="researcher-add">
      <label>Add a researcher
        <select class="researcher-add-template">${opts}</select>
      </label>
      <input class="researcher-add-id" type="text" placeholder="id (e.g. web-1)" aria-label="researcher id" />
      <button type="button" class="btn researcher-add-btn">Add</button>
      <p class="muted researcher-add-status" role="status" aria-live="polite"></p>
    </div>`;
}

/** One researcher row: identity + egress + last-run + the enable/schedule/posture/egress controls + Run now. */
function researcherItem(r: ResearcherView): string {
  const scheduleOpts = SCHEDULE_OPTIONS.map((p) => `<option value="${esc(p)}"${p === r.schedule ? ' selected' : ''}>${esc(schedulePresetLabel(p))}</option>`).join('');
  const postureOpts = (['guarded', 'autonomous'] as const).map((p) => `<option value="${p}"${p === r.posture ? ' selected' : ''}>${POSTURE_LABEL[p]}</option>`).join('');
  const egressOpts = EGRESS_TIERS.map((t) => `<option value="${esc(t)}" title="${esc(EGRESS_TIER_HINTS[t])}"${t === r.egressTier ? ' selected' : ''}>${esc(EGRESS_TIER_LABELS[t])}</option>`).join('');
  const last = r.lastRun
    ? `Last run ${esc(r.lastRun.ts)} — ${esc(r.lastRun.eventType)}${r.lastRun.eventType === 'researched' ? ` on “${esc(r.lastRun.what)}” (${r.lastRun.citations} citation${r.lastRun.citations === 1 ? '' : 's'})` : ''}`
    : 'Never run';
  return `
    <li class="researcher" data-id="${esc(r.id)}">
      <div class="researcher-head">
        <span class="researcher-label">${esc(r.label)}</span>
        <span class="badge researcher-template">${esc(templateLabel(r.template))}</span>
        <span class="badge researcher-egress">${esc(EGRESS_TIER_LABELS[r.egressTier])}</span>
        <label class="researcher-toggle"><input type="checkbox" class="researcher-enabled"${r.enabled ? ' checked' : ''}> Enabled</label>
      </div>
      <p class="muted researcher-template-desc">${esc(templateDesc(r.template))}</p>
      <div class="researcher-instructions">
        <label class="researcher-prompt-label">Instructions
          <textarea class="researcher-prompt" rows="3" placeholder="What should this researcher look for? Which sites/sources, repo, or WorkIQ surfaces?">${esc(r.prompt)}</textarea>
        </label>
        <label>Scope <input type="text" class="researcher-scope" value="${esc(r.scope)}" /></label>
        ${r.template === 'code' ? `<label>Repository path <input type="text" class="researcher-repopath" value="${esc(r.repoPath)}" placeholder="/absolute/path/to/local/repo" /></label>` : ''}
        ${r.template === 'code' ? `<label>GitHub PR repo <input type="text" class="researcher-prrepo" value="${esc(r.prRepo)}" placeholder="owner/name (read PRs via your gh)" /></label>` : ''}
        ${r.template === 'm365' ? `<label>M365 tenant <input type="text" class="researcher-tenant" value="${esc(r.tenantId)}" placeholder="your-org.onmicrosoft.com" /></label>` : ''}
        <button type="button" class="btn researcher-save">Save instructions</button>
      </div>
      <div class="researcher-controls">
        <label>Schedule <select class="researcher-schedule">${scheduleOpts}</select></label>
        <label>Autonomy <select class="researcher-posture">${postureOpts}</select></label>
        <label>Egress <select class="researcher-egress-sel">${egressOpts}</select></label>
        <button type="button" class="btn researcher-run">Run now</button>
      </div>
      <p class="muted researcher-lastrun">${last}</p>
      <div class="confirm researcher-confirm" hidden>
        <p class="warn researcher-confirm-msg"></p>
        <button type="button" class="btn researcher-confirm-cancel">Cancel</button>
        <button type="button" class="btn-danger researcher-confirm-go">Confirm</button>
      </div>
      <p class="muted researcher-status" role="status" aria-live="polite"></p>
    </li>`;
}

function wire(container: HTMLElement, researchers: ResearcherView[]): void {
  const byId = new Map(researchers.map((r) => [r.id, r]));

  // Add-from-template: creating a researcher is safe (it starts disabled); enabling it later confirms.
  const addBtn = container.querySelector<HTMLButtonElement>('.researcher-add-btn');
  addBtn?.addEventListener('click', () => void addResearcher(container));

  for (const li of Array.from(container.querySelectorAll<HTMLElement>('.researcher'))) {
    const id = li.dataset.id!;
    const current = byId.get(id)!;
    const enabledEl = li.querySelector<HTMLInputElement>('.researcher-enabled')!;
    const scheduleEl = li.querySelector<HTMLSelectElement>('.researcher-schedule')!;
    const postureEl = li.querySelector<HTMLSelectElement>('.researcher-posture')!;
    const egressEl = li.querySelector<HTMLSelectElement>('.researcher-egress-sel')!;
    const promptEl = li.querySelector<HTMLTextAreaElement>('.researcher-prompt')!;
    const scopeEl = li.querySelector<HTMLInputElement>('.researcher-scope')!;
    const repoPathEl = li.querySelector<HTMLInputElement>('.researcher-repopath'); // present only for code
    const prRepoEl = li.querySelector<HTMLInputElement>('.researcher-prrepo'); // present only for code
    const tenantEl = li.querySelector<HTMLInputElement>('.researcher-tenant'); // present only for m365
    const saveBtn = li.querySelector<HTMLButtonElement>('.researcher-save')!;
    const runBtn = li.querySelector<HTMLButtonElement>('.researcher-run')!;
    const confirm = li.querySelector<HTMLElement>('.researcher-confirm')!;
    const confirmMsg = li.querySelector<HTMLElement>('.researcher-confirm-msg')!;
    const confirmGo = li.querySelector<HTMLButtonElement>('.researcher-confirm-go')!;
    const confirmCancel = li.querySelector<HTMLButtonElement>('.researcher-confirm-cancel')!;
    const status = li.querySelector<HTMLElement>('.researcher-status')!;

    let pending: (() => Promise<void>) | null = null;
    let revert: (() => void) | null = null;
    const hideConfirm = (): void => {
      confirm.hidden = true;
      pending = null;
      revert = null;
    };
    const askConfirm = (message: string, run: () => Promise<void>, undo: () => void): void => {
      pending = run;
      revert = undo;
      confirmMsg.textContent = message;
      confirm.hidden = false;
    };
    const apply = async (patch: ResearcherConfigPatch): Promise<void> => {
      status.textContent = 'Saving…';
      try {
        await window.kbApi.setResearcherConfig(patch);
        await render(container);
      } catch {
        status.textContent = 'Could not save the change.';
      }
    };

    enabledEl.addEventListener('change', () => {
      const patch: ResearcherConfigPatch = { id, enabled: enabledEl.checked };
      if (isRiskyResearcherChange(asConfig(current), patch)) {
        askConfirm(
          `Enable “${current.label}”? It will reach outside your KB (${EGRESS_TIER_LABELS[current.egressTier]}) on its ${schedulePresetLabel(current.schedule)} schedule.`,
          () => apply(patch),
          () => (enabledEl.checked = false),
        );
      } else void apply(patch);
    });

    postureEl.addEventListener('change', () => {
      const posture = postureEl.value as ResearcherConfigPatch['posture'];
      const patch: ResearcherConfigPatch = { id, posture };
      if (isRiskyResearcherChange(asConfig(current), patch)) {
        askConfirm(
          `Set “${current.label}” to Autonomous? Its findings will be applied without routing to Reviews first.`,
          () => apply(patch),
          () => (postureEl.value = current.posture),
        );
      } else void apply(patch);
    });

    egressEl.addEventListener('change', () => {
      const egressTier = egressEl.value as ResearcherConfigPatch['egressTier'];
      const patch: ResearcherConfigPatch = { id, egressTier };
      if (isRiskyResearcherChange(asConfig(current), patch)) {
        askConfirm(
          `Widen “${current.label}” egress to ${egressTier ? EGRESS_TIER_LABELS[egressTier] : ''}? More of your KB can leave to a less-trusted destination.`,
          () => apply(patch),
          () => (egressEl.value = current.egressTier),
        );
      } else void apply(patch);
    });

    scheduleEl.addEventListener('change', () => void apply({ id, schedule: scheduleEl.value as ResearcherConfigPatch['schedule'] }));

    // Instructions + scope (RESEARCH-17): steering, not risky → saved on an explicit button, no confirm.
    // The backend drops an empty/whitespace prompt or scope (keeps the prior value), so a stray blank
    // save can't wipe a researcher's instructions.
    saveBtn.addEventListener('click', () => void apply({ id, prompt: promptEl.value, scope: scopeEl.value, ...(repoPathEl ? { repoPath: repoPathEl.value } : {}), ...(prRepoEl ? { prRepo: prRepoEl.value } : {}), ...(tenantEl ? { tenantId: tenantEl.value } : {}) }));

    runBtn.addEventListener('click', () => {
      askConfirm(
        `Run “${current.label}” now? It performs one bounded research pass.`,
        async () => {
          // PANEL-10 state machine: idle → running (disabled + "Running…" on the button itself, so it's
          // unmistakable something's in flight) → back to idle (the re-render restores "Run now") or, on
          // failure, reset in place so the user can retry.
          status.textContent = 'Running…';
          runBtn.disabled = true;
          runBtn.textContent = 'Running…';
          try {
            const res = await window.kbApi.runResearcherNow(id);
            let msg: string;
            if ('reason' in res) msg = `Could not run (${res.reason}).`;
            else if (res.failed) msg = `Run failed${res.error ? ` — ${res.error}` : ''}.`; // failed ≠ empty (#160)
            else msg = res.sourceIds.length ? `Ran — added ${res.sourceIds.length} cited source(s).` : 'Ran — no new finding this pass.';
            await render(container);
            const after = container.querySelector<HTMLElement>(`.researcher[data-id="${id}"] .researcher-status`);
            if (after) after.textContent = msg;
          } catch {
            status.textContent = 'Run failed.';
            runBtn.disabled = false;
            runBtn.textContent = 'Run now';
          }
        },
        () => {},
      );
    });

    confirmGo.addEventListener('click', () => {
      const run = pending;
      hideConfirm();
      status.textContent = '';
      if (run) void run();
    });
    confirmCancel.addEventListener('click', () => {
      const undo = revert;
      hideConfirm();
      undo?.();
    });
  }
}

/** Build the minimal ResearcherConfig-shaped object the pure risk gate needs from a view row. */
function asConfig(v: ResearcherView): import('../../kb/researchers').ResearcherConfig {
  return { id: v.id, template: v.template, prompt: '', egressTier: v.egressTier, scope: v.scope, budget: { maxToolCalls: 0, maxDepth: 0 }, schedule: v.schedule, posture: v.posture, enabled: v.enabled, topics: v.topics };
}

async function addResearcher(container: HTMLElement): Promise<void> {
  const templateEl = container.querySelector<HTMLSelectElement>('.researcher-add-template')!;
  const idEl = container.querySelector<HTMLInputElement>('.researcher-add-id')!;
  const status = container.querySelector<HTMLElement>('.researcher-add-status')!;
  const template = templateEl.value as ResearcherConfigPatch['template'];
  const id = idEl.value.trim();
  if (!id) {
    status.textContent = 'Give the researcher an id (lowercase letters, digits, hyphens).';
    return;
  }
  status.textContent = 'Adding…';
  try {
    // Created disabled with the template's default egress — safe; enabling it later is the confirm gate.
    await window.kbApi.setResearcherConfig({ id, template, egressTier: template ? defaultEgressFor(template) : undefined, enabled: false });
    await render(container);
  } catch {
    status.textContent = 'Could not add — check the id is a bare slug (no slashes/spaces).';
  }
}
