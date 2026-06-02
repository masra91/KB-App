// Sources view (SPEC-0027 PANEL-4) — shows the vault (today's only source) + placeholder slots for
// future connected sources (Proactive Intake: email/calendar/news). Thin in v1, grows as integrations
// land. Read-only over existing IPC (`getState`); no new persistence. Degrades gracefully (PANEL-9).
import { esc } from '../html';
import { withTimeout } from '../loadGuard';

export async function mountSources(container: HTMLElement): Promise<void> {
  container.innerHTML = `<div class="card"><h1>🔌 Sources</h1><p class="muted">Loading…</p></div>`;

  let name = '—';
  let vaultPath = '—';
  try {
    // #145: bound the wait so a hung `getState` can't leave an infinite spinner. The view's content
    // is mostly static (connected-source placeholders), so on any failure we still render the full
    // view with em-dash vault info — better than hiding it behind a retry.
    const state = await withTimeout(window.kbApi.getState());
    name = state.vaultConfig?.name ?? '—';
    vaultPath = state.activeVaultPath ?? '—';
  } catch {
    // Fall through to the placeholders with em-dash vault info — the view never errors the shell.
  }

  container.innerHTML = `
    <div class="card">
      <h1>🔌 Sources</h1>
      <p class="muted">Where your knowledge comes from.</p>
      <dl class="settings">
        <dt>Vault</dt>
        <dd>${esc(name)}</dd>
        <dt>Path</dt>
        <dd><span class="path">${esc(vaultPath)}</span></dd>
      </dl>
    </div>
    <div class="card">
      <h2>Connected sources</h2>
      <p class="muted">Pull in context from beyond your vault — arriving with Proactive Intake. Not connected yet.</p>
      <ul class="source-slots">
        <li class="muted">📧 Email — coming soon</li>
        <li class="muted">📅 Calendar — coming soon</li>
        <li class="muted">📰 News &amp; feeds — coming soon</li>
      </ul>
    </div>`;
}
