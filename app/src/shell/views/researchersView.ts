// Researchers view (SPEC-0027 §2 amendment; SPEC-0028) — a Manage sibling for configurable
// researchers (Web/Code/M365/custom): add-from-template, configure prompt/scope/egress/budget/MCP,
// enable, run-now, see findings/citations. Stub until SPEC-0028 Researchers lands (owned by DEV-3);
// the Manage section registers the view now so it has a home to grow into.
export async function mountResearchers(container: HTMLElement): Promise<void> {
  container.innerHTML = `
    <div class="card">
      <h1>🔬 Researchers</h1>
      <p class="muted">Configurable agents that reach outside your KB to corroborate and expand — Web, Code, your work tools.</p>
      <p class="muted">Coming with the Researchers feature.</p>
    </div>`;
}
