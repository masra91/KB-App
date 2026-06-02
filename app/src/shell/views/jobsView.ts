// Jobs view (SPEC-0027 PANEL-2) — the Control Panel's strongest, fully-backed Manage view. Lists the
// autonomous jobs (SPEC-0023) and lets the Principal enable/disable, set the schedule preset + autonomy
// posture, Run now, and see last-run state from the job journal. Thin DOM over the typed IPC (the pure
// merge/risk logic lives in `kb/jobsPanel`, node-tested); the main process owns the registry + scheduler.
//
// PANEL-7: risky changes (enabling a job, going Autonomous, Run now) reveal an inline confirm before
// they apply + audit; read-only viewing needs none. PANEL-9: the view degrades to a friendly message
// when no KB is active or IPC fails.
import { esc } from '../html';
import { withTimeout, renderLoadError } from '../loadGuard';
import { schedulePresetLabel, SCHEDULE_OPTIONS, isRiskyJobChange } from '../../kb/jobsPanel';
import type { JobView, JobConfigPatch } from '../../kb/types';

const POSTURE_LABEL: Record<string, string> = { guarded: 'Guarded', autonomous: 'Autonomous' };

export async function mountJobs(container: HTMLElement): Promise<void> {
  container.innerHTML = `<div class="card"><h1>🛠️ Jobs</h1><p class="muted">Loading…</p></div>`;
  await render(container);
}

async function render(container: HTMLElement): Promise<void> {
  let jobs: JobView[];
  try {
    // #145: bound the wait — a hung `listJobs` (degraded staging) must never leave an infinite spinner.
    jobs = await withTimeout(window.kbApi.listJobs());
  } catch {
    renderLoadError(container, '<h1>🛠️ Jobs</h1>', () => void render(container));
    return;
  }

  const header = `<h1>🛠️ Jobs</h1><p class="muted">Recurring background tasks that keep your KB healthy. Changes apply without a restart.</p>`;
  if (jobs.length === 0) {
    container.innerHTML = `<div class="card">${header}<p class="muted">No jobs available — open a Knowledge Base to manage its jobs.</p></div>`;
    return;
  }

  container.innerHTML = `<div class="card">${header}<ul class="job-list">${jobs.map(jobItem).join('')}</ul></div>`;
  wire(container, jobs);
}

/** One job's row: identity + last-run + the enable/schedule/posture controls and a Run-now button. */
function jobItem(j: JobView): string {
  const badge = j.production ? '' : ` <span class="badge" title="A reference/non-production job">reference</span>`;
  const scheduleOpts = SCHEDULE_OPTIONS.map(
    (p) => `<option value="${esc(p)}"${p === j.schedule ? ' selected' : ''}>${esc(schedulePresetLabel(p))}</option>`,
  ).join('');
  const postureOpts = (['guarded', 'autonomous'] as const)
    .map((p) => `<option value="${p}"${p === j.posture ? ' selected' : ''}>${POSTURE_LABEL[p]}</option>`)
    .join('');
  const last = j.lastRun
    ? `Last run ${esc(j.lastRun.ts)} — inspected ${esc(j.lastRun.inspected)}; ${j.lastRun.applied} applied, ${j.lastRun.deferred} deferred${
        j.lastRun.note ? ` (${esc(j.lastRun.note)})` : ''
      }`
    : 'Never run';

  return `
    <li class="job" data-id="${esc(j.id)}" data-type="${esc(j.type)}">
      <div class="job-head">
        <span class="job-label">${esc(j.label)}</span>${badge}
        <label class="job-toggle"><input type="checkbox" class="job-enabled"${j.enabled ? ' checked' : ''}> Enabled</label>
      </div>
      <p class="muted job-desc">${esc(j.description)}</p>
      <div class="job-controls">
        <label>Schedule <select class="job-schedule">${scheduleOpts}</select></label>
        <label>Autonomy <select class="job-posture">${postureOpts}</select></label>
        <button type="button" class="btn job-run">Run now</button>
      </div>
      <p class="muted job-lastrun">${last}</p>
      <div class="confirm job-confirm" hidden>
        <p class="warn job-confirm-msg"></p>
        <button type="button" class="btn job-confirm-cancel">Cancel</button>
        <button type="button" class="btn-danger job-confirm-go">Confirm</button>
      </div>
      <p class="muted job-status" role="status" aria-live="polite"></p>
    </li>`;
}

function wire(container: HTMLElement, jobs: JobView[]): void {
  const byId = new Map(jobs.map((j) => [j.id, j]));

  for (const li of Array.from(container.querySelectorAll<HTMLElement>('.job'))) {
    const id = li.dataset.id!;
    const type = li.dataset.type!;
    const current = byId.get(id)!;
    const enabledEl = li.querySelector<HTMLInputElement>('.job-enabled')!;
    const scheduleEl = li.querySelector<HTMLSelectElement>('.job-schedule')!;
    const postureEl = li.querySelector<HTMLSelectElement>('.job-posture')!;
    const runBtn = li.querySelector<HTMLButtonElement>('.job-run')!;
    const confirm = li.querySelector<HTMLElement>('.job-confirm')!;
    const confirmMsg = li.querySelector<HTMLElement>('.job-confirm-msg')!;
    const confirmGo = li.querySelector<HTMLButtonElement>('.job-confirm-go')!;
    const confirmCancel = li.querySelector<HTMLButtonElement>('.job-confirm-cancel')!;
    const status = li.querySelector<HTMLElement>('.job-status')!;

    // A single pending action per row: either an apply(patch) or a run-now. Confirm runs it; Cancel
    // hides the panel and reverts the control that triggered it.
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

    const apply = async (patch: JobConfigPatch): Promise<void> => {
      status.textContent = 'Saving…';
      try {
        await window.kbApi.setJobConfig(patch);
        await render(container); // re-render with the persisted list (also refreshes last-run)
      } catch {
        status.textContent = 'Could not save the change.';
      }
    };

    // Enable toggle: enabling is risky (the job starts running) → confirm; disabling applies directly.
    enabledEl.addEventListener('change', () => {
      const patch: JobConfigPatch = { id, type, enabled: enabledEl.checked };
      if (isRiskyJobChange(current, patch)) {
        // Name the posture it will run at — and that it's inherited from the Instance default for a
        // not-yet-registered job: enabling is the consent moment for inherited Autonomous (PANEL-7).
        const inherited = current.registered ? '' : ' (inherited from the Instance default)';
        const postureNote =
          current.posture === 'autonomous'
            ? ` It will run with Autonomous autonomy${inherited} — the agent applies changes, including destructive ones, without routing to Reviews first.`
            : ` It will run Guarded${inherited}.`;
        askConfirm(
          `Enable “${current.label}”? It runs on its ${schedulePresetLabel(current.schedule)} schedule.${postureNote}`,
          () => apply(patch),
          () => (enabledEl.checked = false),
        );
      } else {
        void apply(patch);
      }
    });

    // Posture: → Autonomous is risky (agent judgment governs destructive actions) → confirm.
    postureEl.addEventListener('change', () => {
      const posture = postureEl.value as JobConfigPatch['posture'];
      const patch: JobConfigPatch = { id, type, posture };
      if (isRiskyJobChange(current, patch)) {
        askConfirm(
          `Set “${current.label}” to Autonomous? The agent’s judgment will govern all actions, including destructive ones.`,
          () => apply(patch),
          () => (postureEl.value = current.posture),
        );
      } else {
        void apply(patch);
      }
    });

    // Schedule cadence is not risky — apply directly.
    scheduleEl.addEventListener('change', () => {
      void apply({ id, type, schedule: scheduleEl.value as JobConfigPatch['schedule'] });
    });

    // Run now: a manual bounded pass — confirm, then run and surface the outcome.
    runBtn.addEventListener('click', () => {
      askConfirm(
        `Run “${current.label}” now? It performs one bounded pass.`,
        async () => {
          // PANEL-10 state machine: idle → running (disabled + "Running…" on the button) → idle (the
          // re-render restores "Run now"), or reset in place on failure so the user can retry.
          status.textContent = 'Running…';
          runBtn.disabled = true;
          runBtn.textContent = 'Running…';
          try {
            const res = await window.kbApi.runJobNow(id);
            const msg = !('reason' in res)
              ? res.outcome === 'noop'
                ? 'Ran — nothing to do this pass.'
                : `Ran — ${res.applied} applied, ${res.deferred} deferred${res.outcome === 'setaside' ? ' (set aside)' : ''}.`
              : res.reason === 'skipped'
                ? 'Already running — skipped.'
                : `Could not run (${res.reason}).`;
            // Re-render to refresh last-run (rebuilds the DOM), then show the outcome on the new row.
            await render(container);
            const after = container.querySelector<HTMLElement>(`.job[data-id="${id}"] .job-status`);
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
