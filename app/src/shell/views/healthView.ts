// Health view — "is my vault structurally clean?" (SPEC-0035 HEALTH passive dashboard, HEALTH-8;
// SPEC-0058 STATE-3/13 projection-backed read). A read-only, deterministic readout of structural health —
// orphans, dangling/dead links, sparse/thin (stub) entities — scanned with NO model calls (HEALTH-1). v1 is
// **passive**: it surfaces findings + click-through to the node; it does NOT fix (HEALTH-2/3/5 deferred).
//
// STATE-13 (design-from-the-screens-inward): the view draws everything from ONE projection read — the typed
// `HealthProjection` (KB-Design-Lead-2's render contract), severity baked in. Built to DL-2's "health glance":
// each dimension is an `.hrow` — a severity icon-**tile** `.hi` (#184: hue rides the TILE + the mono count
// `.hn`, the label stays `--viz-ink` for AA) + title + scholarly desc — over its (click-through) findings.
// The glance container is a material `.viz-card` (depth/grain from #453). Three states (STATE-9/10): `ready`
// renders the glance; `warming` a calm "still preparing…" (never the scary error); `unavailable` the honest
// "couldn't scan — recheck". Thin DOM over the typed IPC; the transform is node-tested in `kb/healthProjection`.
import { esc } from '../html';
import { renderLoadError, renderWarming, loadGraphWithWarming, reportLoadFailure, isWarming } from '../loadGuard';
import { isDanglingFinding, type HealthProjection, type HealthDimension, type HealthDimensionFinding, type HealthSeverity } from '../../kb/healthProjection';
import type { HealthFinding, DanglingLink } from '../../kb/healthPanel';

const HEADER = `<h1 class="health-title viz-signage">Health</h1><p class="health-sub viz-body">Structural lint of your knowledge graph — orphans, dead links, and thin pages. Read-only; scanned without AI.</p>`;

export async function mountHealth(container: HTMLElement): Promise<void> {
  container.innerHTML = `<div class="health viz-surface">${HEADER}<p class="health-scanning viz-body">Scanning…</p></div>`;
  await render(container);
}

async function render(container: HTMLElement): Promise<void> {
  let projection: HealthProjection;
  try {
    // SPEC-0058 slice-0 transport: bound the read, but show a calm WARMING face (not a frozen "Scanning…")
    // once it's slow — a generous bound so a cold/large-vault scan completes instead of false-tripping the
    // old 8s deadline into an error face (the packaged Health P0).
    projection = await loadGraphWithWarming(
      () => window.kbApi.healthReport(),
      () => renderWarming(container, HEADER, () => void render(container)),
    );
  } catch (err) {
    // Un-swallow to the app-log (was a bare `catch {}`), then route honestly: a timeout = still WARMING
    // (calm, the scan just needs longer), any real throw = retryable error face.
    reportLoadFailure('health', err);
    if (isWarming(err)) renderWarming(container, HEADER, () => void render(container));
    else renderLoadError(container, HEADER, () => void render(container));
    return;
  }
  // STATE-9/10: honor the projection's own status too (forward-compat with DEV-5's maintained projection,
  // which can report warming/unavailable directly) — the same calm/error faces, never a blank panel.
  if (projection.status === 'warming') {
    renderWarming(container, HEADER, () => void render(container));
    return;
  }
  if (projection.status === 'unavailable') {
    renderLoadError(container, HEADER, () => void render(container));
    return;
  }
  container.innerHTML = `<div class="health viz-surface">${HEADER}<div class="health-glance viz-card">${summary(projection)}${rows(projection)}</div>${footnote()}</div>`;
  wire(container);
}

/** Pluralize a noun by count (numeric face applied by the caller). */
function plural(n: number, singular: string, p = `${singular}s`): string {
  return n === 1 ? singular : p;
}

/** A human "as of <time>" stamp from the projection's ISO build time (mono); '' when absent (degrade-safe). */
function asOf(iso: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return ` <span class="health-asof viz-numeric">· as of ${esc(d.toLocaleString())}</span>`;
}

/** The glance summary line: calm "structurally sound" when clean, else the honest issue count — plus the
 *  scanned-entities readout + the build stamp. `overall:ok` is never a blank panel (a settled affirmation). */
function summary(p: HealthProjection): string {
  const reading =
    p.overall === 'ok'
      ? `<span class="health-tick viz-state-settled" aria-hidden="true">✓</span> Structurally sound`
      : `<span class="health-count viz-numeric viz-state-blocked">${p.totalIssues}</span> structural ${plural(p.totalIssues, 'issue')}`;
  return `<div class="health-summary" role="status">${reading} <span class="health-scanned">· scanned <span class="viz-numeric">${p.scanned}</span> ${plural(p.scanned, 'entity', 'entities')}</span>${asOf(p.generatedAt)}</div>`;
}

/** Severity → DL-2's tile class (`.hi.ok/.warn/.bad`) + an aria-hidden glyph fallback (#184: the hue lives
 *  ONLY on the tile via the class, DL-2's CSS maps it to the sprout/brass/oxide token; the glyph is the
 *  reduced-motion / no-CSS fallback). */
const TILE: Record<HealthSeverity, { cls: string; glyph: string }> = {
  ok: { cls: 'ok', glyph: '✓' },
  warn: { cls: 'warn', glyph: '⚠' },
  bad: { cls: 'bad', glyph: '✕' },
};

/** A name that's safe to render even when missing — a muted "(untitled)" fallback (ENG-15/16). */
function nameCell(name: string): string {
  return name && name.trim() ? `<span class="health-finding-name viz-body">${esc(name)}</span>` : `<span class="health-finding-name health-untitled viz-body">(untitled)</span>`;
}

/** An entity finding row (orphan / thin): clickable name → open the node + the specific defect (muted). */
function findingRow(f: HealthFinding, defect: string): string {
  return `
        <li class="health-row">
          <button type="button" class="health-open viz-no-chrome viz-focusable" data-rel="${esc(f.rel ?? '')}" title="Open ${esc(f.name) || '(untitled)'}">
            ${nameCell(f.name)}
            <span class="health-kind viz-chip">${esc(f.kind ?? '')}</span>
            <span class="health-defect viz-body">${esc(defect)}</span>
          </button>
        </li>`;
}

/** A dead-link row: source entity (openable) → the unresolved target, the defect in muted (not error hue). */
function danglingRow(d: DanglingLink): string {
  return `
        <li class="health-row">
          <button type="button" class="health-open viz-no-chrome viz-focusable" data-rel="${esc(d.from ?? '')}" title="Open ${esc(d.fromName) || '(untitled)'}">
            ${nameCell(d.fromName)}
            <span class="health-defect viz-body">→ ${esc(d.target ?? '')} (no node)</span>
          </button>
        </li>`;
}

/** Render one finding — discriminating a dead-link from an entity finding (ENG-15/16: a malformed entry is
 *  degraded per-item via the nameCell fallback + `?? ''` guards, so one bad finding can't crash the glance). */
function renderFinding(key: HealthDimension['key'], f: HealthDimensionFinding): string {
  if (key === 'dangling' || isDanglingFinding(f)) return danglingRow(f as DanglingLink);
  const ef = f as HealthFinding;
  return key === 'thin' ? findingRow(ef, `stub · ${ef.chars ?? 0} chars`) : findingRow(ef, '0 in · 0 out');
}

/** One dimension: DL-2's `.hrow` glance row (severity tile `.hi` + `.ht` title/desc + mono `.hn` count),
 *  over its (capped) click-through findings. A clean dimension shows the ok tile + desc only (never a
 *  blank/odd empty list). The `.hrow` matches the prototype exactly; the findings list is a sibling. */
function dimensionRow(d: HealthDimension): string {
  const tile = TILE[d.severity] ?? TILE.ok;
  const list =
    d.count > 0
      ? `<ul class="health-row-list">${d.findings.map((f) => renderFinding(d.key, f)).join('')}</ul>${d.count > d.findings.length ? `<p class="health-more viz-body">+${d.count - d.findings.length} more not shown.</p>` : ''}`
      : '';
  return `
    <section class="health-dimension" data-key="${esc(d.key)}" data-severity="${esc(d.severity)}">
      <div class="hrow">
        <span class="hi ${tile.cls}" aria-hidden="true">${tile.glyph}</span>
        <span class="ht">
          <b>${esc(d.label)}</b>
          <span>${esc(d.desc)}</span>
        </span>
        <span class="hn viz-numeric">${d.count}</span>
      </div>
      ${list}
    </section>`;
}

/** The three dimension rows in display order — always all three (each with findings or a clean tile). */
function rows(p: HealthProjection): string {
  return p.dimensions.map(dimensionRow).join('');
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
