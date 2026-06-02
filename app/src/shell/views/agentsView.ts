// Agents view (SPEC-0027 PANEL-3) — lists the librarian/stage agents with status + key config
// (model, instruction file); v1 is observe + safe knobs (full agent authoring deferred). Slice-1
// stub: the Manage section registers the view now; the observe content lands in slice 2.
export async function mountAgents(container: HTMLElement): Promise<void> {
  container.innerHTML = `
    <div class="card">
      <h1>🤖 Agents</h1>
      <p class="muted">The librarian agents that run your pipeline — archivist, decompose, connect, claims, recall.</p>
      <p class="muted">Status and configuration (model, instructions) are coming in a later slice. For now agents run with their built-in defaults.</p>
    </div>`;
}
