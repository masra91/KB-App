// Health view — "is my vault structurally clean?" (SPEC-0035 HEALTH, the passive dashboard half,
// HEALTH-8). A read-only, deterministic readout of structural health — orphans, dangling/dead links,
// sparse/thin (stub) entities — scanned with NO model calls (HEALTH-1). v1 is **passive**: it surfaces
// findings + click-through to the node; it does NOT fix (auto-fix HEALTH-2, the bounded job HEALTH-5,
// and the REFLECT handoff HEALTH-3 are deferred).
//
// Built to KB-Design-Lead-2's anatomy: an **instrument panel, not a card grid** — three **gauge groups**
// hung off the shared spine (`.viz-spine` + `.viz-ruled` separators, the activityView idiom). Severity is
// **hue on a graphic, never colored text** (#184): a leading tick + the count chip go brass
// (`.viz-state-blocked`) when a group has issues, patina (`.viz-state-settled`) when it's clean; the
// entity name stays `--viz-ink`, the defect reads in `--viz-ink-muted`. Per-group healthy lines + a top
// summary strip mean it's never a blank panel. Thin DOM over the typed IPC; scan is node-tested in
// `kb/healthPanel`.
import { esc } from '../html';
import { withTimeout, renderLoadError } from '../loadGuard';
import type { HealthReport, HealthFinding, DanglingLink } from '../../kb/healthPanel';

const HEADER = `<h1 class="health-title viz-signage">Health</h1><p class="health-sub viz-body">Structural lint of your knowledge graph — orphans, dead links, and thin pages. Read-only; scanned without AI.</p>`;

export async function mountHealth(container: HTMLElement): Promise<void> {
  container.innerHTML = `<div class="health viz-surface">${HEADER}<p class="health-scanning viz-body">Scanning…</p></div>`;
  await render(container);
}

async function render(container: HTMLElement): Promise<void> {
  let report: HealthReport;
  try {
    // Bound the scan→render so a hung/failed IPC degrades to a retryable "unavailable · Recheck"
    // affordance, never an endless spinner (#145/#160 honest degrade).
    report = await withTimeout(window.kbApi.healthReport());
  } catch {
    renderLoadError(container, HEADER, () => void render(container));
    return;
  }
  container.innerHTML = `<div class="health viz-surface">${HEADER}${summaryStrip(report)}${groups(report)}${footnote()}</div>`;
  wire(container);
}

/** Pluralize a noun by count (numeric face applied by the caller). */
function plural(n: number, singular: string, p = `${singular}s`): string {
  return n === 1 ? singular : p;
}

/** The leading tick + a count chip — the gauge reading. Brass when the group has issues (attention,
 *  not error — #184: hue on the graphic, not the text), patina when the group reads clean. */
function gauge(n: number): string {
  const state = n > 0 ? 'viz-state-blocked' : 'viz-state-settled';
  const glyph = n > 0 ? '▸' : '✓';
  return `<span class="health-tick ${state}" aria-hidden="true">${glyph}</span><span class="health-count viz-numeric ${state}">${n}</span>`;
}

/** The top instrument strip: total issues across the three classes — honest count, patina when zero. */
function summaryStrip(r: HealthReport): string {
  const total = r.counts.orphans + r.counts.thin + r.counts.dangling;
  const state = total > 0 ? 'viz-state-blocked' : 'viz-state-settled';
  const reading =
    total > 0
      ? `<span class="health-count viz-numeric ${state}">${total}</span> structural ${plural(total, 'issue')}`
      : `<span class="health-tick ${state}" aria-hidden="true">✓</span> All clear`;
  return `<div class="health-summary viz-spine" role="status">${reading} <span class="health-scanned">· scanned <span class="viz-numeric">${r.scanned}</span> ${plural(r.scanned, 'entity', 'entities')}</span></div>`;
}

/** A name that's safe to render even when missing — a muted "(untitled)" fallback (ENG-15/16). */
function nameCell(name: string): string {
  return name && name.trim() ? `<span class="health-finding-name viz-body">${esc(name)}</span>` : `<span class="health-finding-name health-untitled viz-body">(untitled)</span>`;
}

/** An entity finding row (orphan / thin): clickable name → open the node + the specific defect (muted). */
function findingRow(f: HealthFinding, defect: string): string {
  return `
      <li class="health-row">
        <button type="button" class="health-open viz-no-chrome viz-focusable" data-rel="${esc(f.rel)}" title="Open ${esc(f.name) || '(untitled)'}">
          ${nameCell(f.name)}
          <span class="health-kind viz-chip">${esc(f.kind)}</span>
          <span class="health-defect viz-body">${esc(defect)}</span>
        </button>
      </li>`;
}

/** A dead-link row: source entity (openable) → the unresolved target, the defect in muted (not error hue). */
function danglingRow(d: DanglingLink): string {
  return `
      <li class="health-row">
        <button type="button" class="health-open viz-no-chrome viz-focusable" data-rel="${esc(d.from)}" title="Open ${esc(d.fromName) || '(untitled)'}">
          ${nameCell(d.fromName)}
          <span class="health-defect viz-body">→ ${esc(d.target)} (no node)</span>
        </button>
      </li>`;
}

/** One gauge group on the spine: header (label + gauge) + issue rows, else a patina healthy line. */
function group(label: string, why: string, total: number, shown: number, rows: string, healthyLabel: string): string {
  const body =
    total === 0
      ? `<p class="health-healthy viz-state-settled"><span class="health-tick" aria-hidden="true">✓</span> ${esc(healthyLabel)}</p>`
      : `<ul class="health-row-list">${rows}</ul>${total > shown ? `<p class="health-more viz-body">+${total - shown} more not shown.</p>` : ''}`;
  return `
    <section class="health-group viz-spine viz-ruled">
      <div class="health-group-head">
        <span class="health-group-label viz-signage">${esc(label)}</span>
        ${gauge(total)}
      </div>
      <p class="health-group-why viz-body">${esc(why)}</p>
      ${body}
    </section>`;
}

/** The three gauge groups, always shown (each with issues or a healthy line — never a blank panel). */
function groups(r: HealthReport): string {
  return [
    group(
      'Dead links',
      'A link points to a node that no longer exists (often a merged or renamed entity).',
      r.counts.dangling,
      r.dangling.length,
      r.dangling.map(danglingRow).join(''),
      'No dead links',
    ),
    group(
      'Orphans',
      'An entity with no links in or out — disconnected from the rest of the graph.',
      r.counts.orphans,
      r.orphans.length,
      r.orphans.map((f) => findingRow(f, '0 in · 0 out')).join(''),
      'No orphans',
    ),
    group(
      'Thin pages',
      'A sparse / stub entity with very little content — a candidate to expand from its sources.',
      r.counts.thin,
      r.thin.length,
      r.thin.map((f) => findingRow(f, `stub · ${f.chars ?? 0} chars`)).join(''),
      'No thin pages',
    ),
  ].join('');
}

/** v1 is passive: name what's coming so the readout reads as honest, not broken. */
function footnote(): string {
  return `<p class="health-footnote viz-body">Read-only for now — automatic structural fixes and content repair (via Reflect) land in a later slice.</p>`;
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
