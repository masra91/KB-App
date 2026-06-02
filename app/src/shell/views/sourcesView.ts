// Sources view (SPEC-0027 PANEL-4) — shows the vault + watched folders with placeholder slots for
// future connected sources (Proactive Intake: email/calendar/news). Thin in v1, grows as integrations
// land. Slice-1 stub: the Manage section registers the view now; the vault + placeholders land in slice 2.
export async function mountSources(container: HTMLElement): Promise<void> {
  container.innerHTML = `
    <div class="card">
      <h1>🔌 Sources</h1>
      <p class="muted">Where your knowledge comes from — your vault today, and connected sources (email, calendar, news) as they’re built.</p>
      <p class="muted">The vault summary and connected-source slots are coming in a later slice.</p>
    </div>`;
}
