// Design-System Showcase — the primitive gallery (design: design-system-showcase.md / DESIGN-SHOWCASE).
//
// A STATIC, copilot-free, pipeline-free, `active`-free page that renders every blessed WS2 primitive in
// all its variants × states on one deterministic page — the living design reference AND the home for the
// re-homed HYBRID e2e visual snapshot (SPEC-0033 §6 / DESIGN-9; #233 parked because feature-surface
// snapshots needed a git+pipeline harness). It composes the EXACT shipped `.viz-*` classes from
// design-system.css — it adds NO new primitive CSS (faithful-mirror): a cell that can't render with the
// shipped classes is flagged as a PRIMITIVE GAP, not papered over with showcase-only styling.
//
// Interaction-only states (:hover, :focus-visible) are forced statically via `.is-hover`/`.is-focus`
// hooks that share the primitive's pseudo rule (design-system.css) — so the snapshot pins the real
// styling without real interaction. `busy`/`active`/`disabled`/`invalid` are real classes/attrs.
//
// Reachability: dev-only, mounted by renderer.ts on a `?showcase` / `#showcase` flag — never in the user
// nav, no IPC. Theme capture is the snapshot's job (Playwright `emulateMedia` forces dark/light), so the
// page renders once and the e2e screenshots it under each scheme.
import { esc } from '../html';

/** A captioned cell: the live primitive + a mono caption naming variant/state, so a diff is legible. */
function cell(caption: string, body: string): string {
  return `<div class="showcase-cell"><div class="showcase-demo">${body}</div><span class="showcase-cap viz-numeric">${esc(caption)}</span></div>`;
}

/** A flagged PRIMITIVE GAP — a matrix cell the shipped CSS can't render. We render the markup the spec
 *  implies (so the gap is visible) + a loud caption naming the missing class. NO invented styling. */
function gap(caption: string, missing: string, body = ''): string {
  return `<div class="showcase-cell showcase-cell--gap">${body ? `<div class="showcase-demo">${body}</div>` : ''}<span class="showcase-cap showcase-cap--gap viz-numeric">⚠ gap · ${esc(caption)} · missing ${esc(missing)}</span></div>`;
}

function section(title: string, ref: string, cells: string[]): string {
  return `<section class="showcase-section"><h2 class="showcase-h2 viz-signage">${esc(title)} <span class="showcase-ref viz-numeric">${esc(ref)}</span></h2><div class="showcase-grid">${cells.join('')}</div></section>`;
}

// ── Button (§3) ───────────────────────────────────────────────────────────────────────────────
function buttonSection(): string {
  const variants: { mod: string; label: string }[] = [
    { mod: '', label: 'default' },
    { mod: ' viz-btn--primary', label: 'primary' },
    { mod: ' viz-btn--danger', label: 'danger' },
    { mod: ' viz-btn--ghost', label: 'ghost' },
  ];
  const states: { cls: string; attr: string; label: string }[] = [
    { cls: '', attr: '', label: 'resting' },
    { cls: ' is-hover', attr: '', label: 'hover' },
    { cls: ' is-focus', attr: '', label: 'focus' },
    { cls: '', attr: ' disabled', label: 'disabled' },
  ];
  const cells: string[] = [];
  for (const v of variants) {
    for (const s of states) {
      cells.push(cell(`${v.label}/${s.label}`, `<button type="button" class="viz-btn viz-focusable${v.mod}${s.cls}"${s.attr}>Action</button>`));
    }
  }
  // busy — only default + primary carry it (a dispatching emphasized action).
  cells.push(cell('default/busy', `<button type="button" class="viz-btn viz-btn--busy">Working…</button>`));
  cells.push(cell('primary/busy', `<button type="button" class="viz-btn viz-btn--primary viz-btn--busy">Working…</button>`));
  // sizes
  cells.push(cell('default/sm', `<button type="button" class="viz-btn viz-btn--sm">Action</button>`));
  cells.push(cell('default/md', `<button type="button" class="viz-btn">Action</button>`));
  // GAP: the _design-system.md §3 `clearance-tinted` Button variant isn't a shipped class — the
  // researcher Run/arm coloring lives in surface CSS (.rdesk-*), not a .viz-btn--clearance modifier.
  cells.push(gap('clearance-tinted (patina/brass/ember)', '.viz-btn--clearance', `<button type="button" class="viz-btn">Run</button>`));
  return section('Button', '_design-system §3', cells);
}

// ── SegmentedControl (§4) ─────────────────────────────────────────────────────────────────────
function seg(opts: { label: string; checked?: boolean; cls?: string; temp?: string }[]): string {
  const inner = opts
    .map(
      (o) =>
        `<button type="button" role="radio" class="viz-seg-opt viz-signage viz-focusable${o.cls ?? ''}"${o.temp ? ` data-temp="${o.temp}"` : ''} aria-checked="${o.checked ? 'true' : 'false'}">${esc(o.label)}</button>`,
    )
    .join('');
  return `<span class="viz-seg" role="radiogroup" aria-label="demo">${inner}</span>`;
}
function segmentedSection(): string {
  const cells: string[] = [];
  // neutral: ghosted resting, active, hover, focus
  cells.push(cell('neutral/resting', seg([{ label: 'Off' }, { label: 'Daily' }, { label: 'Hourly' }])));
  cells.push(cell('neutral/active', seg([{ label: 'Off' }, { label: 'Daily', checked: true }, { label: 'Hourly' }])));
  cells.push(cell('neutral/hover', seg([{ label: 'Off' }, { label: 'Daily', cls: ' is-hover' }, { label: 'Hourly' }])));
  cells.push(cell('neutral/focus', seg([{ label: 'Off' }, { label: 'Daily', cls: ' is-focus' }, { label: 'Hourly' }])));
  // clearance: active rung at each temperature
  const clear = (active: string): string =>
    seg([
      { label: 'LOCAL', cls: ' viz-seg-opt--clearance', temp: 'local-only', checked: active === 'local-only' },
      { label: 'INTERNAL', cls: ' viz-seg-opt--clearance', temp: 'internal-tenant', checked: active === 'internal-tenant' },
      { label: 'PUBLIC', cls: ' viz-seg-opt--clearance', temp: 'public-web', checked: active === 'public-web' },
    ]);
  cells.push(cell('clearance/local·patina', clear('local-only')));
  cells.push(cell('clearance/internal·brass', clear('internal-tenant')));
  cells.push(cell('clearance/public·ember', clear('public-web')));
  // GAP: _design-system.md §4 says the disabled group dims to 0.5, but no `:disabled`/group-disabled rule
  // is shipped for .viz-seg-opt.
  cells.push(gap('neutral/disabled (dim 0.5)', '.viz-seg-opt disabled rule', seg([{ label: 'Off' }, { label: 'Daily', checked: true }, { label: 'Hourly' }])));
  return section('SegmentedControl', '_design-system §4', cells);
}

// ── ConfirmInline + Dialog (§5) ───────────────────────────────────────────────────────────────
function confirmBody(danger: boolean): string {
  return `<div class="viz-confirm${danger ? ' viz-confirm--danger' : ''}"><p class="viz-confirm__msg viz-body">This starts egress to the public web.</p><button type="button" class="viz-btn">Cancel</button><button type="button" class="viz-btn viz-btn--danger">Confirm</button></div>`;
}
function confirmSection(): string {
  const cells: string[] = [];
  cells.push(cell('inline/caution·brass', confirmBody(false)));
  cells.push(cell('inline/danger·oxide', confirmBody(true)));
  // hidden — proves the [hidden]{display:none} contract (#215). It renders nothing visible by design;
  // the caption documents it (the contract itself is unit-asserted in confirmDismissCss.test.ts).
  cells.push(cell('inline/hidden ([hidden]→none)', `<div class="viz-confirm" hidden><p class="viz-confirm__msg">hidden</p></div><span class="showcase-note viz-body">renders nothing (hidden) — contract OK</span>`));
  // GAP: _design-system.md §5 describes a `dialog` variant (overlay on a scrim); only the inline
  // presentation is shipped (.viz-confirm) — no dialog/scrim class.
  cells.push(gap('dialog (scrim overlay)', '.viz-confirm--dialog / scrim', confirmBody(true)));
  return section('ConfirmInline + Dialog', '_design-system §5', cells);
}

// ── EditableField (§6) ────────────────────────────────────────────────────────────────────────
function field(label: string, inputHtml: string): string {
  return `<label class="viz-field"><span class="viz-field__label">${esc(label)}</span>${inputHtml}</label>`;
}
function editableFieldSection(): string {
  const cells: string[] = [];
  // types
  cells.push(cell('text/resting', field('scope', `<input type="text" class="viz-field__input viz-focusable" value="global" />`)));
  cells.push(cell('numeric/resting', field('reads / pass', `<input type="text" inputmode="numeric" class="viz-field__input viz-field__input--numeric viz-focusable" value="15" />`)));
  cells.push(cell('multiline/resting', field('standing orders', `<textarea class="viz-field__input viz-field__input--multiline viz-body viz-focusable" rows="2">What should this researcher look for?</textarea>`)));
  cells.push(cell('duration/resting (numeric+unit)', field('timeout', `<span class="showcase-inline"><input type="text" inputmode="numeric" class="viz-field__input viz-field__input--numeric viz-focusable" value="15" /> <span class="viz-field__label">min</span></span>`)));
  // states
  cells.push(cell('text/focus (ember rule)', field('scope', `<input type="text" class="viz-field__input viz-focusable is-focus" value="global" />`)));
  cells.push(cell('numeric/dirty (save shown)', `<span class="showcase-inline">${field('reads / pass', `<input type="text" inputmode="numeric" class="viz-field__input viz-field__input--numeric viz-focusable" value="20" />`)} <button type="button" class="viz-btn viz-btn--primary viz-btn--sm">Save</button></span>`));
  cells.push(cell('numeric/invalid (oxide rule, ink text)', field('reads / pass', `<input type="text" inputmode="numeric" class="viz-field__input viz-field__input--numeric viz-field__input--invalid viz-focusable" value="0" aria-invalid="true" />`)));
  cells.push(cell('multiline/invalid', field('standing orders', `<textarea class="viz-field__input viz-field__input--multiline viz-field__input--invalid viz-body viz-focusable" rows="2">…</textarea>`)));
  // GAP: _design-system.md §6 says disabled dims to 0.5, but no `.viz-field__input:disabled` rule is shipped.
  cells.push(gap('text/disabled (dim 0.5)', '.viz-field__input disabled rule', field('scope', `<input type="text" class="viz-field__input" value="global" disabled />`)));
  return section('EditableField', '_design-system §6', cells);
}

/** Mount the static showcase gallery (no IPC / pipeline / active dependency). */
export function mountShowcase(container: HTMLElement): void {
  document.body.classList.add('shell-active'); // reuse the full-bleed layout (not the centered setup card)
  container.innerHTML = `
    <div class="showcase viz-surface">
      <header class="showcase-head">
        <h1 class="showcase-title viz-signage">Design-System Showcase</h1>
        <p class="showcase-sub viz-body">Every blessed WS2 primitive × variant × state — the living reference + the home of the HYBRID visual snapshot. Faithful mirror of <span class="viz-numeric">design-system.css</span>; <span class="showcase-cap--gap">⚠ gap</span> cells flag spec'd states with no shipped class.</p>
      </header>
      ${buttonSection()}
      ${segmentedSection()}
      ${confirmSection()}
      ${editableFieldSection()}
    </div>`;
}
