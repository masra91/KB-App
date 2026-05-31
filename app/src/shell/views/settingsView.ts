// Settings view — v1 is display-only (SPEC-0017 SHELL-7): it surfaces the active KB
// (name + vault path) and Copilot availability, all from existing IPC. Editing config
// (e.g. switching the KB) is deferred (SHELL-8/10).
import { esc } from '../html';

export async function mountSettings(container: HTMLElement): Promise<void> {
  container.innerHTML = `<div class="card"><h1>⚙️ Settings</h1><p class="muted">Loading…</p></div>`;

  // Settings is display-only; it must never error the shell. Any IPC failure degrades
  // to a friendly message rather than throwing.
  try {
    const state = await window.kbApi.getState();
    const name = state.vaultConfig?.name ?? '—';
    const path = state.activeVaultPath;

    // Copilot availability comes from the same inspection the Setup flow uses (SETUP-4).
    let copilotLine = '<li class="muted">Copilot — status unavailable</li>';
    if (path) {
      try {
        const ins = await window.kbApi.inspect(path);
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
          <dd><span class="path">${esc(path ?? '—')}</span></dd>
        </dl>
        <ul class="checks">
          ${copilotLine}
        </ul>
        <p class="muted">More settings will live here. Switching the active KB is coming later.</p>
      </div>`;
  } catch {
    container.innerHTML = `
      <div class="card">
        <h1>⚙️ Settings</h1>
        <p class="error">Could not load settings right now.</p>
      </div>`;
  }
}
