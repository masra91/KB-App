// Settings view (SPEC-0017 SHELL-7): surfaces the active KB (name + vault path) and Copilot
// availability, and hosts the Replay / Maintenance action (SPEC-0022 REPLAY-1/2) — a confirmed,
// Principal-initiated "clean & rebuild" of the KB. Editing config (e.g. switching the KB) is
// deferred (SHELL-8/10).
import { esc } from '../html';
import type { InstanceSettings } from '../../kb/types';

// SPEC-0022 §3.3 — the confirmation copy MUST name the consequence before any destructive step (REPLAY-2).
const REPLAY_CONFIRM =
  'Completely clean and rebuild this KB? This permanently deletes all derived knowledge — ' +
  'candidates, entities, claims, and review questions — and reprocesses every Source from scratch. ' +
  'Your Sources are preserved. This cannot be undone from the app.';

export async function mountSettings(container: HTMLElement): Promise<void> {
  container.innerHTML = `<div class="card"><h1>⚙️ Settings</h1><p class="muted">Loading…</p></div>`;

  // Settings must never error the shell. Any IPC failure degrades to a friendly message.
  try {
    const state = await window.kbApi.getState();
    const name = state.vaultConfig?.name ?? '—';
    const vaultPath = state.activeVaultPath;

    // Copilot availability comes from the same inspection the Setup flow uses (SETUP-4).
    let copilotLine = '<li class="muted">Copilot — status unavailable</li>';
    if (vaultPath) {
      try {
        const ins = await window.kbApi.inspect(vaultPath);
        const mark = ins.copilot.available ? '✅' : '⚠️';
        copilotLine = `<li>${mark} Copilot — <span class="muted">${esc(ins.copilot.detail)}</span></li>`;
      } catch {
        // Leave the fallback line.
      }
    }

    // PANEL-5 / OBS-10: the editable per-Instance settings (autonomy default + dev-log verbosity).
    // Never errors the shell — falls back to safe defaults. Shared mutable object so each control
    // sends the full settings (the IPC contract takes the whole object) without clobbering the other.
    const settings: InstanceSettings = { autonomyDefault: 'guarded', devLogLevel: 'info' };
    try {
      Object.assign(settings, await window.kbApi.getInstanceSettings());
    } catch {
      // Leave the safe defaults.
    }
    const opt = (v: 'guarded' | 'autonomous', label: string): string =>
      `<option value="${v}"${v === settings.autonomyDefault ? ' selected' : ''}>${label}</option>`;
    const levelOpt = (v: 'info' | 'debug', label: string): string =>
      `<option value="${v}"${v === settings.devLogLevel ? ' selected' : ''}>${label}</option>`;

    container.innerHTML = `
      <div class="card">
        <h1>⚙️ Settings</h1>
        <dl class="settings">
          <dt>Knowledge Base</dt>
          <dd>${esc(name)}</dd>
          <dt>Vault path</dt>
          <dd><span class="path">${esc(vaultPath ?? '—')}</span></dd>
        </dl>
        <ul class="checks">
          ${copilotLine}
        </ul>
      </div>
      <div class="card">
        <h2>Autonomy</h2>
        <p class="muted">Default posture for autonomous jobs in this Knowledge Base. Each job inherits this unless it sets its own. <strong>Guarded</strong> routes risky or low-confidence changes to Reviews; <strong>Autonomous</strong> lets the agent apply them directly.</p>
        <label class="autonomy-row">Default posture
          <select id="autonomy-default">${opt('guarded', 'Guarded')}${opt('autonomous', 'Autonomous')}</select>
        </label>
        <div id="autonomy-confirm" class="confirm" hidden>
          <p class="warn">Set the default to <strong>Autonomous</strong>? Jobs without their own posture will let the agent apply changes — including destructive ones — without routing to Reviews first.</p>
          <button id="autonomy-cancel" class="btn">Cancel</button>
          <button id="autonomy-go" class="btn-danger">Set Autonomous</button>
        </div>
        <p id="autonomy-status" class="muted" role="status" aria-live="polite"></p>
      </div>
      <div class="card">
        <h2>Diagnostics</h2>
        <p class="muted">Dev-log verbosity for this Knowledge Base (SPEC-0030). <strong>Info</strong> is the default; <strong>Debug</strong> adds verbose detail — and includes redaction-protected captured text / egress payloads — to troubleshoot a stuck pipeline. Applies on the next pipeline start.</p>
        <label class="verbosity-row">Dev-log level
          <select id="devlog-level">${levelOpt('info', 'Info')}${levelOpt('debug', 'Debug')}</select>
        </label>
        <p id="verbosity-status" class="muted" role="status" aria-live="polite"></p>
      </div>
      <div class="card">
        <h2>Replay / Maintenance</h2>
        <p class="muted">Delete all derived knowledge and reprocess every Source from scratch. Your Sources are preserved.</p>
        <button id="replay-btn" class="btn-danger"${vaultPath ? '' : ' disabled'}>Clean &amp; Rebuild KB…</button>
        <div id="replay-confirm" class="confirm" hidden>
          <p class="warn">${esc(REPLAY_CONFIRM)}</p>
          <button id="replay-cancel" class="btn">Cancel</button>
          <button id="replay-go" class="btn-danger">Clean &amp; Rebuild</button>
        </div>
        <p id="replay-status" class="muted" role="status" aria-live="polite"></p>
      </div>`;

    wireAutonomy(container, settings);
    wireVerbosity(container, settings);
    wireReplay(container);
  } catch {
    container.innerHTML = `
      <div class="card">
        <h1>⚙️ Settings</h1>
        <p class="error">Could not load settings right now.</p>
      </div>`;
  }
}

/** Wire the per-Instance autonomy default (PANEL-5/7): changing the default to Autonomous is risky and
 *  reveals a confirm before it applies + is audited; relaxing to Guarded applies directly. */
function wireAutonomy(container: HTMLElement, settings: InstanceSettings): void {
  const select = container.querySelector<HTMLSelectElement>('#autonomy-default');
  const confirm = container.querySelector<HTMLElement>('#autonomy-confirm');
  const cancel = container.querySelector<HTMLButtonElement>('#autonomy-cancel');
  const go = container.querySelector<HTMLButtonElement>('#autonomy-go');
  const status = container.querySelector<HTMLElement>('#autonomy-status');
  if (!select || !confirm || !cancel || !go || !status) return;

  const apply = async (value: 'guarded' | 'autonomous'): Promise<void> => {
    status.textContent = 'Saving…';
    try {
      // Send the FULL settings (the IPC takes the whole object) so we never clobber devLogLevel.
      const saved = await window.kbApi.setInstanceSettings({ ...settings, autonomyDefault: value });
      Object.assign(settings, saved);
      select.value = settings.autonomyDefault;
      status.textContent = `Default posture: ${settings.autonomyDefault === 'autonomous' ? 'Autonomous' : 'Guarded'}.`;
    } catch {
      select.value = settings.autonomyDefault; // revert on failure
      status.textContent = 'Could not save the change.';
    }
  };

  select.addEventListener('change', () => {
    const value = select.value === 'autonomous' ? 'autonomous' : 'guarded';
    if (value === 'autonomous' && settings.autonomyDefault !== 'autonomous') {
      status.textContent = '';
      confirm.hidden = false; // risky → confirm before applying (PANEL-7)
    } else {
      void apply(value);
    }
  });
  cancel.addEventListener('click', () => {
    confirm.hidden = true;
    select.value = settings.autonomyDefault; // revert the pending selection
  });
  go.addEventListener('click', () => {
    confirm.hidden = true;
    void apply('autonomous');
  });
}

/** Wire the dev-log verbosity selector (SPEC-0030 OBS-10): a benign info/debug toggle, applied
 *  directly (no confirm) — it only changes diagnostic detail. Sends the FULL settings so the
 *  autonomy default is preserved; the level takes effect on the next pipeline start. */
function wireVerbosity(container: HTMLElement, settings: InstanceSettings): void {
  const select = container.querySelector<HTMLSelectElement>('#devlog-level');
  const status = container.querySelector<HTMLElement>('#verbosity-status');
  if (!select || !status) return;

  select.addEventListener('change', async () => {
    const value = select.value === 'debug' ? 'debug' : 'info';
    status.textContent = 'Saving…';
    try {
      const saved = await window.kbApi.setInstanceSettings({ ...settings, devLogLevel: value });
      Object.assign(settings, saved);
      select.value = settings.devLogLevel;
      status.textContent = `Dev-log level: ${settings.devLogLevel === 'debug' ? 'Debug' : 'Info'} (applies on the next pipeline start).`;
    } catch {
      select.value = settings.devLogLevel; // revert on failure
      status.textContent = 'Could not save the change.';
    }
  });
}

/** Wire the Clean & Rebuild flow: reveal a confirm panel (REPLAY-2), then run the replay and
 *  reflect progress (REPLAY-12: the action is disabled while it runs so a second can't start). */
function wireReplay(container: HTMLElement): void {
  const btn = container.querySelector<HTMLButtonElement>('#replay-btn');
  const confirm = container.querySelector<HTMLElement>('#replay-confirm');
  const cancel = container.querySelector<HTMLButtonElement>('#replay-cancel');
  const go = container.querySelector<HTMLButtonElement>('#replay-go');
  const status = container.querySelector<HTMLElement>('#replay-status');
  if (!btn || !confirm || !cancel || !go || !status) return;

  const showConfirm = (show: boolean): void => {
    confirm.hidden = !show;
    btn.hidden = show;
  };

  btn.addEventListener('click', () => {
    status.textContent = '';
    showConfirm(true);
  });
  cancel.addEventListener('click', () => showConfirm(false)); // nothing happens — pipeline keeps running

  go.addEventListener('click', async () => {
    go.disabled = true;
    cancel.disabled = true;
    status.textContent = 'Cleaning & rebuilding…';
    try {
      const res = await window.kbApi.fullReplay();
      status.textContent = res.message;
    } catch {
      status.textContent = 'Replay failed to start. Please try again.';
    } finally {
      showConfirm(false);
      go.disabled = false;
      cancel.disabled = false;
    }
  });
}
