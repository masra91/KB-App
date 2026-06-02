// Settings view (SPEC-0017 SHELL-7): surfaces the active KB (name + vault path) and Copilot
// availability, and hosts the Replay / Maintenance action (SPEC-0022 REPLAY-1/2) — a confirmed,
// Principal-initiated "clean & rebuild" of the KB. Editing config (e.g. switching the KB) is
// deferred (SHELL-8/10).
import { esc } from '../html';

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

    wireReplay(container);
  } catch {
    container.innerHTML = `
      <div class="card">
        <h1>⚙️ Settings</h1>
        <p class="error">Could not load settings right now.</p>
      </div>`;
  }
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
