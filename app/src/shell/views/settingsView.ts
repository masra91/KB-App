// Settings view (SPEC-0017 SHELL-7): surfaces the active KB (name + vault path) and Copilot
// availability, and hosts the Replay / Maintenance action (SPEC-0022 REPLAY-1/2) — a confirmed,
// Principal-initiated "clean & rebuild" of the KB. Editing config (e.g. switching the KB) is
// deferred (SHELL-8/10).
//
// WS3 migration (DESIGN-LEGACY-VIEWS §3): the autonomy + dev-log native <select>s are now the blessed
// SegmentedControl primitive (.viz-seg, a role=radiogroup of role=radio segments). That is an
// INTERACTION-CONTRACT change — the old `change` event is gone; selection is a click / Space-Enter on a
// segment, focus roves with arrow keys, and the choice is reflected via `aria-checked`. The autonomy
// confirm-gate (guarded↔autonomous) re-wires onto the segment, not a removed select.
import { esc } from '../html';
import { withTimeout, renderLoadError } from '../loadGuard';
import type { InstanceSettings } from '../../kb/types';

// SPEC-0022 §3.3 — the confirmation copy MUST name the consequence before any destructive step (REPLAY-2).
const REPLAY_CONFIRM =
  'Completely clean and rebuild this KB? This permanently deletes all derived knowledge — ' +
  'candidates, entities, claims, and review questions — and reprocesses every Source from scratch. ' +
  'Your Sources are preserved. This cannot be undone from the app.';

/** A SegmentedControl segment (DESIGN-LEGACY-VIEWS §3 a11y): role=radio + aria-checked, roving
 *  tabindex so the checked segment is the single tab stop (focus then roves with arrow keys). */
function segOpt(value: string, label: string, current: string): string {
  const on = value === current;
  return `<button type="button" role="radio" class="viz-seg-opt viz-signage viz-focusable" data-value="${esc(value)}" aria-checked="${on ? 'true' : 'false'}" tabindex="${on ? '0' : '-1'}">${esc(label)}</button>`;
}

export async function mountSettings(container: HTMLElement): Promise<void> {
  container.innerHTML = `<div class="card"><h1>⚙️ Settings</h1><p class="settings-note">Loading…</p></div>`;

  // Settings must never error the shell. Any IPC failure (incl. a #145 hang — withTimeout bounds
  // every await below) degrades to a friendly, retryable message.
  try {
    const state = await withTimeout(window.kbApi.getState());
    const name = state.vaultConfig?.name ?? '—';
    const vaultPath = state.activeVaultPath;

    // Copilot availability comes from the same inspection the Setup flow uses (SETUP-4).
    let copilotLine = '<li class="settings-note">Copilot — status unavailable</li>';
    if (vaultPath) {
      try {
        const ins = await withTimeout(window.kbApi.inspect(vaultPath));
        const mark = ins.copilot.available ? '✅' : '⚠️';
        copilotLine = `<li>${mark} Copilot — <span class="settings-note">${esc(ins.copilot.detail)}</span></li>`;
      } catch {
        // Leave the fallback line.
      }
    }

    // PANEL-5 / OBS-10: the editable per-Instance settings (autonomy default + dev-log verbosity).
    // Never errors the shell — falls back to safe defaults. Shared mutable object so each control
    // sends the full settings (the IPC contract takes the whole object) without clobbering the other.
    // quickCaptureAccelerator (QCAP-6) isn't edited here yet — it's loaded + sent back unchanged so
    // each control still sends the whole settings object without clobbering it (preserve-on-omission).
    const settings: InstanceSettings = { autonomyDefault: 'guarded', devLogLevel: 'info', quickCaptureAccelerator: 'Alt+Space' };
    try {
      Object.assign(settings, await withTimeout(window.kbApi.getInstanceSettings()));
    } catch {
      // Leave the safe defaults.
    }

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
        <p class="settings-note">Default posture for autonomous jobs in this Knowledge Base. Each job inherits this unless it sets its own. <strong>Guarded</strong> routes risky or low-confidence changes to Reviews; <strong>Autonomous</strong> lets the agent apply them directly.</p>
        <div class="settings-control">
          <span class="viz-field__label" id="autonomy-label">Default posture</span>
          <span class="viz-seg" role="radiogroup" aria-labelledby="autonomy-label" id="autonomy-default">${segOpt('guarded', 'Guarded', settings.autonomyDefault)}${segOpt('autonomous', 'Autonomous', settings.autonomyDefault)}</span>
        </div>
        <div id="autonomy-confirm" class="viz-confirm" hidden>
          <p class="viz-confirm__msg viz-body">Set the default to <strong>Autonomous</strong>? Jobs without their own posture will let the agent apply changes — including destructive ones — without routing to Reviews first.</p>
          <button id="autonomy-cancel" type="button" class="viz-btn viz-focusable">Cancel</button>
          <button id="autonomy-go" type="button" class="viz-btn viz-btn--danger viz-focusable">Set Autonomous</button>
        </div>
        <p id="autonomy-status" class="settings-note" role="status" aria-live="polite"></p>
      </div>
      <div class="card">
        <h2>Diagnostics</h2>
        <p class="settings-note">Diagnostic detail for this Knowledge Base. <strong>Info</strong> is the default; <strong>Debug</strong> adds verbose detail — and includes redaction-protected captured text / data sent to external services — to troubleshoot a stuck pipeline. Applies on the next pipeline start.</p>
        <div class="settings-control">
          <span class="viz-field__label" id="devlog-label">Diagnostic detail</span>
          <span class="viz-seg" role="radiogroup" aria-labelledby="devlog-label" id="devlog-level">${segOpt('info', 'Info', settings.devLogLevel)}${segOpt('debug', 'Debug', settings.devLogLevel)}</span>
        </div>
        <p id="verbosity-status" class="settings-note" role="status" aria-live="polite"></p>
      </div>
      <div class="card">
        <h2>Replay / Maintenance</h2>
        <p class="settings-note">Delete all derived knowledge and reprocess every Source from scratch. Your Sources are preserved.</p>
        <button id="replay-btn" type="button" class="viz-btn viz-btn--danger viz-focusable"${vaultPath ? '' : ' disabled'}>Clean &amp; Rebuild KB…</button>
        <div id="replay-confirm" class="viz-confirm viz-confirm--danger" hidden>
          <p class="viz-confirm__msg viz-body">${esc(REPLAY_CONFIRM)}</p>
          <button id="replay-cancel" type="button" class="viz-btn viz-focusable">Cancel</button>
          <button id="replay-go" type="button" class="viz-btn viz-btn--danger viz-focusable">Clean &amp; Rebuild</button>
        </div>
        <p id="replay-status" class="settings-note" role="status" aria-live="polite"></p>
      </div>`;

    wireAutonomy(container, settings);
    wireVerbosity(container, settings);
    wireReplay(container);
  } catch {
    // #145: failed/timed-out load → a retryable error, never an infinite spinner.
    renderLoadError(container, '<h1>⚙️ Settings</h1>', () => void mountSettings(container));
  }
}

/** Reflect the committed value on a SegmentedControl: set `aria-checked` + the roving tab stop. */
function setSegChecked(group: HTMLElement, value: string): void {
  for (const o of Array.from(group.querySelectorAll<HTMLButtonElement>('[role="radio"]'))) {
    const on = o.dataset.value === value;
    o.setAttribute('aria-checked', on ? 'true' : 'false');
    o.tabIndex = on ? 0 : -1;
  }
}

/** Wire a SegmentedControl's interaction contract (DESIGN-LEGACY-VIEWS §3 a11y). Selection does NOT
 *  follow focus — picking a posture can apply/confirm, so arrow keys ROVE focus (roving tabindex) and
 *  the choice commits on click or Space/Enter (a documented radiogroup variant for consequential
 *  choices). `onPick(value)` carries the gating logic (the caller applies or reveals the confirm). */
function wireSegmentedRadio(group: HTMLElement, onPick: (value: string) => void): void {
  const opts = Array.from(group.querySelectorAll<HTMLButtonElement>('[role="radio"]'));
  const focusAt = (i: number): void => {
    const n = (i + opts.length) % opts.length; // wrap
    for (const [j, o] of opts.entries()) o.tabIndex = j === n ? 0 : -1;
    opts[n].focus();
  };
  opts.forEach((opt, i) => {
    const pick = (): void => {
      if (opt.dataset.value) onPick(opt.dataset.value);
    };
    opt.addEventListener('click', pick);
    opt.addEventListener('keydown', (e) => {
      switch (e.key) {
        case 'ArrowRight':
        case 'ArrowDown':
          e.preventDefault();
          focusAt(i + 1);
          break;
        case 'ArrowLeft':
        case 'ArrowUp':
          e.preventDefault();
          focusAt(i - 1);
          break;
        case 'Home':
          e.preventDefault();
          focusAt(0);
          break;
        case 'End':
          e.preventDefault();
          focusAt(opts.length - 1);
          break;
        case ' ':
        case 'Enter':
          e.preventDefault();
          pick();
          break;
      }
    });
  });
}

/** Wire the per-Instance autonomy default (PANEL-5/7): changing the default to Autonomous is risky and
 *  reveals a confirm before it applies + is audited; relaxing to Guarded applies directly. */
function wireAutonomy(container: HTMLElement, settings: InstanceSettings): void {
  const group = container.querySelector<HTMLElement>('#autonomy-default');
  const confirm = container.querySelector<HTMLElement>('#autonomy-confirm');
  const cancel = container.querySelector<HTMLButtonElement>('#autonomy-cancel');
  const go = container.querySelector<HTMLButtonElement>('#autonomy-go');
  const status = container.querySelector<HTMLElement>('#autonomy-status');
  if (!group || !confirm || !cancel || !go || !status) return;

  const apply = async (value: 'guarded' | 'autonomous'): Promise<void> => {
    status.textContent = 'Saving…';
    try {
      // Send the FULL settings (the IPC takes the whole object) so we never clobber devLogLevel.
      const saved = await window.kbApi.setInstanceSettings({ ...settings, autonomyDefault: value });
      Object.assign(settings, saved);
      setSegChecked(group, settings.autonomyDefault);
      status.textContent = `Default posture: ${settings.autonomyDefault === 'autonomous' ? 'Autonomous' : 'Guarded'}.`;
    } catch {
      setSegChecked(group, settings.autonomyDefault); // keep the control on the unchanged saved value
      status.textContent = 'Could not save the change.';
    }
  };

  wireSegmentedRadio(group, (value) => {
    if (value === 'autonomous') {
      if (settings.autonomyDefault === 'autonomous') return; // already autonomous — nothing to do
      status.textContent = '';
      confirm.hidden = false; // risky → confirm before applying (PANEL-7); aria-checked stays on the saved value
    } else {
      confirm.hidden = true; // picking Guarded dismisses any pending confirm
      if (settings.autonomyDefault !== 'guarded') void apply('guarded'); // apply only on an actual change
    }
  });
  cancel.addEventListener('click', () => {
    confirm.hidden = true;
    setSegChecked(group, settings.autonomyDefault); // revert any tentative focus to the saved posture
  });
  go.addEventListener('click', () => {
    confirm.hidden = true;
    void apply('autonomous');
  });
}

/** Wire the dev-log verbosity control (SPEC-0030 OBS-10): a benign info/debug toggle, applied
 *  directly (no confirm) — it only changes diagnostic detail. Sends the FULL settings so the
 *  autonomy default is preserved; the level takes effect on the next pipeline start. */
function wireVerbosity(container: HTMLElement, settings: InstanceSettings): void {
  const group = container.querySelector<HTMLElement>('#devlog-level');
  const status = container.querySelector<HTMLElement>('#verbosity-status');
  if (!group || !status) return;

  const apply = async (value: 'info' | 'debug'): Promise<void> => {
    status.textContent = 'Saving…';
    try {
      const saved = await window.kbApi.setInstanceSettings({ ...settings, devLogLevel: value });
      Object.assign(settings, saved);
      setSegChecked(group, settings.devLogLevel);
      status.textContent = `Dev-log level: ${settings.devLogLevel === 'debug' ? 'Debug' : 'Info'} (applies on the next pipeline start).`;
    } catch {
      setSegChecked(group, settings.devLogLevel); // keep the control on the unchanged saved value
      status.textContent = 'Could not save the change.';
    }
  };

  wireSegmentedRadio(group, (value) => {
    const v = value === 'debug' ? 'debug' : 'info';
    if (v === settings.devLogLevel) return; // no-op when unchanged
    void apply(v);
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
