// Agents hub (SPEC-0053 AGENTSIA / "WS-E") — one "Agents" surface that makes the three previously
// confusable Manage views legible by framing them by DIRECTION (AGENTSIA-1/2/3):
//
//   • Librarians — work *inside* your KB (the pipeline workers; built-in → disable-only), with their
//     Schedules (recurring librarian work, formerly "Jobs") nested underneath as *when these run*.
//   • Researchers — reach *outside* your KB (egress-gated; user-added → removable).
//
// This is IA + naming + composition only — **no engine change** (AGENTSIA-5). Each group body is the
// existing view mounted into a sub-container, so every behavior, poll, and existing test stays intact;
// the hub just owns the group headers + inward/outward descriptors + the built-in/user-added framing.
import { mountAgents } from './agentsView';
import { mountJobs } from './jobsView';
import { mountResearchers } from './researchersView';

export async function mountAgentsHub(container: HTMLElement): Promise<void> {
  container.innerHTML = `
    <div class="agents-hub viz-surface">
      <h1 class="agents-hub-title viz-voice">Agents</h1>
      <p class="agents-hub-sub viz-body">Everything that works on your knowledge — grouped by where it reaches.</p>

      <section class="agents-group" aria-labelledby="agents-grp-librarians">
        <h2 id="agents-grp-librarians" class="agents-group-head viz-signage"><span class="agents-group-glyph" aria-hidden="true">↻</span> Librarians</h2>
        <p class="agents-group-why viz-body">Work <strong>inside</strong> your KB — the pipeline workers that read, connect, and maintain your knowledge. Built in; you can pause them, not remove them.</p>
        <div class="agents-section" data-section="librarians"></div>
        <div class="agents-subgroup">
          <h3 class="agents-subgroup-head viz-signage">Schedules</h3>
          <p class="agents-subgroup-why viz-body">When recurring librarian work runs — e.g. Reflect rumination.</p>
          <div class="agents-section" data-section="schedules"></div>
        </div>
      </section>

      <section class="agents-group" aria-labelledby="agents-grp-researchers">
        <h2 id="agents-grp-researchers" class="agents-group-head viz-signage"><span class="agents-group-glyph" aria-hidden="true">→</span> Researchers</h2>
        <p class="agents-group-why viz-body">Reach <strong>outside</strong> your KB — egress-gated agents that fetch external corroboration. You add and remove these.</p>
        <div class="agents-section" data-section="researchers"></div>
      </section>
    </div>`;

  const sec = (name: string): HTMLElement => container.querySelector<HTMLElement>(`.agents-section[data-section="${name}"]`)!;
  // Mount each existing view into its group sub-container (Schedules nested under Librarians). Each owns
  // its own load/poll/teardown + #145/#160 guards, so normal load failures degrade in place. This outer
  // catch is the catastrophic backstop: if a sub-view ever threw PAST its own guard it'd otherwise leave
  // a stuck "Loading…" — instead we paint a calm per-section fallback (DL-2 hardening), isolated to that
  // section so the others (and the hub framing) still render.
  const mountSection = (name: string, mount: (c: HTMLElement) => Promise<void>): Promise<void> =>
    mount(sec(name)).catch(() => {
      sec(name).innerHTML = `<p class="agents-section-error viz-body">Couldn’t load this section — reopen Agents to retry.</p>`;
    });
  await Promise.all([
    mountSection('librarians', mountAgents),
    mountSection('schedules', mountJobs),
    mountSection('researchers', mountResearchers),
  ]);
}
