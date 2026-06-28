// Health view — "is my vault structurally clean?" (SPEC-0035 HEALTH, the passive dashboard half,
// HEALTH-8). A read-only, deterministic readout of structural health — orphans, dangling/dead links,
// sparse/thin (stub) entities — scanned with NO model calls (HEALTH-1). v1 is **passive**: it surfaces
// findings + click-through to the node; it does NOT fix (auto-fix HEALTH-2, the bounded job HEALTH-5,
// and the REFLECT handoff HEALTH-3 are deferred). Built in "The Line" instrument language (design-system
// primitives) — a calm health readout, "not a wall of red" (SPEC-0035 §5). Thin DOM over the typed IPC;
// the scan is pure + node-tested in `kb/healthPanel`.
import { esc } from '../html';
import { withTimeout, renderLoadError } from '../loadGuard';
import type { HealthReport, HealthFinding, DanglingLink } from '../../kb/healthPanel';

const HEADER = `<h1 class="health-title viz-signage">Health</h1><p class="health-sub viz-body">Structural lint of your knowledge graph — orphans, dead links, and thin pages. Read-only; scanned without AI.</p>`;

export async function mountHealth(container: HTMLElement): Promise<void> {
  container.innerHTML = `<div class="health viz-surface">${HEADER}<p class="viz-body">Scanning…</p></div>`;
  await render(container);
}

async function render(container: HTMLElement): Promise<void> {
  let report: HealthReport;
  try {
    // Bound the scan→render so a hung/failed IPC degrades to a retryable error, never an endless spinner.
    report = await withTimeout(window.kbApi.healthReport());
  } catch {
    renderLoadError(container, HEADER, () => void render(container));
    return;
  }
  container.innerHTML = `<div class="health viz-surface">${HEADER}${summary(report)}${body(report)}</div>`;
  wire(container);
}

/** Pluralize a noun by count, and render the count in the numeric instrument face. */
function metric(n: number, singular: string, plural = `${singular}s`): string {
  return `<span class="viz-numeric">${n}</span> ${n === 1 ? singular : plural}`;
}

/** The calm one-line readout (SPEC-0035 §5): a legible health summary, never a wall of red. */
function summary(r: HealthReport): string {
  const { orphans, thin, dangling } = r.counts;
  const clean = orphans + thin + dangling === 0;
  const cls = clean ? ' health-summary--clean' : '';
  const line = clean
    ? `All clear — no structural issues across ${metric(r.scanned, 'entity', 'entities')}.`
    : `${metric(dangling, 'dead link')} · ${metric(orphans, 'orphan')} · ${metric(thin, 'thin page')} <span class="health-scanned">across ${metric(r.scanned, 'entity', 'entities')}</span>`;
  return `<p class="health-summary viz-body${cls}" role="status">${line}</p>`;
}

/** A single entity finding row (orphan / thin): identity + a click-through to open the node. */
function findingRow(f: HealthFinding, hint: string): string {
  return `
    <li class="health-finding">
      <button type="button" class="health-open viz-no-chrome viz-focusable" data-rel="${esc(f.rel)}" title="Open ${esc(f.name)}">
        <span class="health-finding-name viz-body">${esc(f.name) || '<em>(unnamed)</em>'}</span>
        <span class="health-kind viz-chip">${esc(f.kind)}</span>
        <span class="health-hint viz-body">${esc(hint)}</span>
        <span class="health-open-mark" aria-hidden="true">↗</span>
      </button>
    </li>`;
}

/** A dead-link row: the source entity (openable) → the unresolved target (text — nothing to open). */
function danglingRow(d: DanglingLink): string {
  return `
    <li class="health-finding health-finding--dangling">
      <button type="button" class="health-open viz-no-chrome viz-focusable" data-rel="${esc(d.from)}" title="Open ${esc(d.fromName)}">
        <span class="health-finding-name viz-body">${esc(d.fromName) || '<em>(unnamed)</em>'}</span>
        <span class="health-edge viz-numeric" aria-label="links to">→</span>
        <span class="health-dead-target viz-body" title="No node resolves this link">${esc(d.target)}</span>
        <span class="health-open-mark" aria-hidden="true">↗</span>
      </button>
    </li>`;
}

/** One collapsible-free section: heading + count + the (bounded) finding list + a "+N more" note. */
function section(title: string, why: string, shown: number, total: number, rows: string): string {
  if (total === 0) return '';
  const more = total > shown ? `<p class="health-more viz-body">+${total - shown} more not shown.</p>` : '';
  return `
    <section class="health-section">
      <h2 class="health-section-head viz-signage">${esc(title)} <span class="viz-numeric">${total}</span></h2>
      <p class="health-section-why viz-body">${esc(why)}</p>
      <ul class="health-finding-list">${rows}</ul>
      ${more}
    </section>`;
}

function body(r: HealthReport): string {
  if (r.counts.orphans + r.counts.thin + r.counts.dangling === 0) {
    // The clean state — the summary already says "all clear"; add a calm reassurance, no empty sections.
    return `<p class="health-allclear viz-body">Nothing to fix. As the pipeline links and fleshes out entities, this view stays green — and flags anything that drifts.</p>`;
  }
  const deadLinks = section(
    'Dead links',
    'A link points to a node that no longer exists (often a merged or renamed entity).',
    r.dangling.length,
    r.counts.dangling,
    r.dangling.map(danglingRow).join(''),
  );
  const orphans = section(
    'Orphans',
    'An entity with no links in or out — disconnected from the rest of the graph.',
    r.orphans.length,
    r.counts.orphans,
    r.orphans.map((f) => findingRow(f, 'no links yet')).join(''),
  );
  const thin = section(
    'Thin pages',
    'A sparse / stub entity with very little content — a candidate to expand from its sources.',
    r.thin.length,
    r.counts.thin,
    r.thin.map((f) => findingRow(f, 'sparse')).join(''),
  );
  // v1 is passive: name what's coming so the readout reads as honest, not broken.
  const footnote = `<p class="health-footnote viz-body">Read-only for now — automatic structural fixes and content repair (via Reflect) land in a later slice.</p>`;
  return `${deadLinks}${orphans}${thin}${footnote}`;
}

function wire(container: HTMLElement): void {
  // Click-through: open the node in Obsidian (HEALTH leads back to reading; reuses ASK-14 openCitation).
  for (const btn of Array.from(container.querySelectorAll<HTMLButtonElement>('.health-open'))) {
    btn.addEventListener('click', () => {
      const rel = btn.dataset.rel;
      if (rel) void window.kbApi.openCitation(rel);
    });
  }
}
