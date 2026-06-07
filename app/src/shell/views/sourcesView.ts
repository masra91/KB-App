// Control Panel · Sources — the unified Sources management view (SPEC-0027 PANEL-4: INTAKE-14 feed
// connectors + WATCH-9 watched folders, ONE surface). Built on the WS2 design-system primitives
// (shell/design-system.css `viz-*`), reusing the shared manage-view strip layout (`rdesk-*`, token-
// based + generic) for visual consistency with Researchers/Jobs. The INTAKE feed section is live; the
// WATCH watched-folders section consumes DEV-5's `kb:listWatchFolders` when the backend lands (shown as
// "arriving" until then — graceful, never a broken canvas, PANEL-9).
import { esc } from '../html';
import { withTimeout, renderLoadError } from '../loadGuard';
import {
  schedulePresetLabel,
  SCHEDULE_OPTIONS,
  INTAKE_CONNECTOR_CATALOG,
  isRiskyIntakeChange,
  intakeRunEligibility,
  intakeOutcomeLabel,
} from '../../kb/intakeSourcingPanel';
import type { IntakeConnectorView, IntakeConnectorConfigPatch } from '../../kb/types';
import type { IntakeConnectorConfig } from '../../kb/intakeConnectors';

/** A glyph per connector type — never the dev slug; the typeLabel carries the words. */
const TYPE_GLYPH: Record<string, string> = { rss: '📰', 'm365-mail': '✉' };

const HEADER = `<h1 class="rdesk-title viz-signage">Sources</h1><p class="rdesk-sub viz-body">Where your knowledge comes from — feeds you subscribe to and folders you watch. New items arrive as sources in your KB.</p>`;

export async function mountSources(container: HTMLElement): Promise<void> {
  container.innerHTML = `<div class="rdesk viz-surface">${HEADER}<p class="viz-body">Loading…</p></div>`;
  await render(container);
}

async function render(container: HTMLElement): Promise<void> {
  let connectors: IntakeConnectorView[];
  try {
    // #145: bound the wait so a hung IPC can't leave an infinite spinner.
    connectors = await withTimeout(window.kbApi.listIntakeConnectors());
  } catch {
    renderLoadError(container, HEADER, () => void render(container));
    return;
  }
  const feeds = connectors.length
    ? `<ul class="rdesk-roster">${connectors.map(strip).join('')}</ul>`
    : `<p class="rdesk-empty viz-body">No feeds yet — add one from a template below.</p>`;
  container.innerHTML = `<div class="rdesk viz-surface">${HEADER}
    <section class="src-section">
      <h2 class="src-section-head viz-signage">Feeds</h2>
      ${feeds}
      ${addDock()}
    </section>
    <section class="src-section">
      <h2 class="src-section-head viz-signage">Watched folders</h2>
      <p class="rdesk-empty viz-body">Drop files into a folder and they arrive as sources, kept verbatim. Arriving soon.</p>
    </section>
  </div>`;
  wire(container, connectors);
}

/** A segmented control (role=radiogroup of buttons — no native &lt;select&gt;, the WS2 SegmentedControl). */
function segmented(cls: string, label: string, options: readonly { value: string; text: string }[], selected: string): string {
  const opts = options
    .map((o) => `<button type="button" role="radio" class="rdesk-seg-opt viz-seg-opt viz-signage viz-focusable" data-value="${esc(o.value)}" aria-checked="${o.value === selected ? 'true' : 'false'}">${esc(o.text)}</button>`)
    .join('');
  return `<div class="rdesk-seg"><span class="rdesk-seg-label viz-signage">${esc(label)}</span><span class="viz-seg ${esc(cls)}" role="radiogroup" aria-label="${esc(label)}">${opts}</span></div>`;
}

/** A labeled instrument field (caption + input) on the WS2 EditableField primitive. */
function field(label: string, cls: string, value: string, placeholder: string): string {
  return `<label class="rdesk-field viz-field"><span class="rdesk-field-label viz-field__label viz-signage">${esc(label)}</span><input type="text" class="${esc(cls)} rdesk-input viz-field__input viz-body viz-focusable" value="${esc(value)}" placeholder="${esc(placeholder)}" /></label>`;
}

const REPORT_FLAG: Record<string, string> = { intook: '✓', empty: '·', failed: '✕', never: '·' };

/** The last-pull report line — typed, jargon-free (never the raw audit slug). */
function reportLine(c: IntakeConnectorView): string {
  const flag = (state: string): string => `<span class="rdesk-report-flag" aria-hidden="true">${REPORT_FLAG[state]}</span> `;
  if (!c.lastRun) return `<span class="rdesk-report" data-state="never">${flag('never')}never pulled</span>`;
  const lr = c.lastRun;
  const state = lr.eventType === 'intook' ? 'intook' : lr.eventType === 'intake-failed' ? 'failed' : 'empty';
  const when = new Date(lr.ts).toLocaleString();
  const outcome = intakeOutcomeLabel(lr.eventType);
  const detail =
    state === 'intook'
      ? ` — brought in <span class="viz-numeric">${lr.count}</span> item${lr.count === 1 ? '' : 's'}`
      : state === 'failed' && lr.error
        ? ` — ${esc(lr.error)}`
        : '';
  return `<span class="rdesk-report" data-state="${state}">${flag(state)}last pull ${esc(when)} · ${esc(outcome)}${detail}</span>`;
}

/** Type-specific config fields: RSS = feed URL; M365-mail = tenant + folder. */
function configFields(c: IntakeConnectorView): string {
  if (c.type === 'rss') return field('Feed URL', 'intake-feedurl', c.feedUrl, 'https://example.com/feed.xml');
  if (c.type === 'm365-mail') return `${field('Tenant', 'intake-tenant', c.tenantId, 'your tenant id')}${field('Folder', 'intake-folder', c.folder, 'Inbox')}`;
  return '';
}

function strip(c: IntakeConnectorView): string {
  const armed = c.enabled;
  const elig = intakeRunEligibility(c);
  const scheduleOpts = SCHEDULE_OPTIONS.map((s) => ({ value: s, text: schedulePresetLabel(s) }));
  return `
    <li class="rdesk-strip viz-no-chrome viz-spine" data-id="${esc(c.id)}" data-armed="${armed ? 'true' : 'false'}">
      <div class="rdesk-strip-head">
        <span class="rdesk-id viz-numeric">${esc(c.id)}</span>
        <button type="button" class="rdesk-arm intake-arm viz-signage viz-focusable" role="switch" aria-checked="${armed ? 'true' : 'false'}">${armed ? '◉ ENABLED' : '○ PAUSED'}</button>
      </div>
      <div class="rdesk-identity">
        <span class="rdesk-kind viz-signage">${esc(TYPE_GLYPH[c.type] ?? '🔌')} ${esc(c.typeLabel)}</span>
      </div>
      <div class="rdesk-orders">
        <div class="rdesk-fields">
          ${configFields(c)}
          ${field('Scope', 'intake-scope', c.scope, 'global')}
          ${field('Sensitivity', 'intake-sensitivity', c.sensitivity, 'internal')}
          <label class="rdesk-field viz-field"><span class="rdesk-field-label viz-field__label viz-signage">items / pull</span><input type="number" class="intake-maxitems viz-field__input viz-field__input--numeric viz-focusable" min="1" max="200" step="1" value="${c.maxItemsPerPass}" aria-label="Max items per pull" /></label>
          <button type="button" class="viz-btn intake-save rdesk-save">Save</button>
        </div>
      </div>
      <div class="rdesk-config">
        ${segmented('intake-schedule', 'Schedule', scheduleOpts, c.schedule)}
      </div>
      <p class="rdesk-eligibility intake-eligibility viz-body" data-will-run="${elig.willRun ? 'true' : 'false'}">${esc(elig.note)}</p>
      <div class="rdesk-footer viz-ruled">
        ${reportLine(c)}
        <button type="button" class="viz-btn rdesk-run intake-run">▷ Pull now</button>
      </div>
      <div class="rdesk-confirm viz-confirm intake-confirm" hidden>
        <p class="rdesk-confirm-msg viz-confirm__msg intake-confirm-msg viz-body"></p>
        <button type="button" class="viz-btn intake-confirm-cancel">Cancel</button>
        <button type="button" class="viz-btn viz-btn--primary intake-confirm-go">Confirm</button>
      </div>
      <p class="rdesk-status intake-status viz-body" role="status" aria-live="polite"></p>
    </li>`;
}

/** The add-dock — named template TILES (glyph + label), not a &lt;select&gt;. Each creates a PAUSED
 *  connector; enabling it later is the gated step (enabling starts an outbound pull). */
function addDock(): string {
  const tiles = INTAKE_CONNECTOR_CATALOG.map(
    (o) => `<button type="button" class="rdesk-tile viz-no-chrome viz-focusable" data-type="${esc(o.type)}" title="${esc(o.description)}"><span class="rdesk-tile-glyph">${esc(TYPE_GLYPH[o.type] ?? '🔌')}</span><span class="rdesk-tile-label viz-signage">${esc(o.label)}</span></button>`,
  ).join('');
  return `
    <div class="rdesk-add">
      <span class="rdesk-add-head viz-signage">Add a feed</span>
      <div class="rdesk-tiles" role="group" aria-label="Feed templates">${tiles}</div>
      <input class="intake-add-id rdesk-add-id viz-body viz-focusable" type="text" placeholder="Name it (e.g. Hacker News)" aria-label="feed name" />
      <p class="intake-add-status rdesk-add-status viz-body" role="status" aria-live="polite"></p>
    </div>`;
}

/** Minimal connector shape the pure risk gate needs from a view row. */
function asIntakeConfig(v: IntakeConnectorView): IntakeConnectorConfig {
  return { id: v.id, type: v.type, schedule: v.schedule, enabled: v.enabled, scope: v.scope, sensitivity: v.sensitivity };
}

function wire(container: HTMLElement, connectors: IntakeConnectorView[]): void {
  const byId = new Map(connectors.map((c) => [c.id, c]));

  // Add-from-tile: a tile selects the type (highlights); the Name input + Enter (or re-click) creates.
  let chosenType: IntakeConnectorConfigPatch['type'] | null = null;
  const tiles = Array.from(container.querySelectorAll<HTMLButtonElement>('.rdesk-tile'));
  const addId = container.querySelector<HTMLInputElement>('.intake-add-id');
  for (const tile of tiles) {
    tile.addEventListener('click', () => {
      const t = tile.dataset.type as IntakeConnectorConfigPatch['type'];
      if (chosenType === t) {
        void addConnector(container, t);
        return;
      }
      chosenType = t;
      for (const x of tiles) x.setAttribute('aria-pressed', x === tile ? 'true' : 'false');
      addId?.focus();
    });
  }
  addId?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && chosenType) void addConnector(container, chosenType);
  });

  for (const li of Array.from(container.querySelectorAll<HTMLElement>('.rdesk-strip'))) {
    const id = li.dataset.id!;
    const current = byId.get(id)!;
    const armEl = li.querySelector<HTMLButtonElement>('.intake-arm')!;
    const feedUrlEl = li.querySelector<HTMLInputElement>('.intake-feedurl'); // rss only
    const tenantEl = li.querySelector<HTMLInputElement>('.intake-tenant'); // m365 only
    const folderEl = li.querySelector<HTMLInputElement>('.intake-folder'); // m365 only
    const scopeEl = li.querySelector<HTMLInputElement>('.intake-scope')!;
    const sensitivityEl = li.querySelector<HTMLInputElement>('.intake-sensitivity')!;
    const maxItemsEl = li.querySelector<HTMLInputElement>('.intake-maxitems')!;
    const saveBtn = li.querySelector<HTMLButtonElement>('.intake-save')!;
    const runBtn = li.querySelector<HTMLButtonElement>('.intake-run')!;
    const confirm = li.querySelector<HTMLElement>('.intake-confirm')!;
    const confirmMsg = li.querySelector<HTMLElement>('.intake-confirm-msg')!;
    const confirmGo = li.querySelector<HTMLButtonElement>('.intake-confirm-go')!;
    const confirmCancel = li.querySelector<HTMLButtonElement>('.intake-confirm-cancel')!;
    const status = li.querySelector<HTMLElement>('.intake-status')!;

    let pending: (() => Promise<void>) | null = null;
    const hideConfirm = (): void => {
      confirm.hidden = true;
      confirmMsg.textContent = '';
      pending = null;
    };
    const askConfirm = (message: string, run: () => Promise<void>): void => {
      pending = run;
      confirmMsg.textContent = message;
      confirm.hidden = false;
    };
    const apply = async (patch: IntakeConnectorConfigPatch): Promise<void> => {
      status.textContent = 'Saving…';
      try {
        await window.kbApi.setIntakeConnectorConfig(patch);
        await render(container);
      } catch {
        status.textContent = 'Could not save the change.';
      }
    };

    // Enable/disable — enabling starts an outbound pull (egress to the feed/tenant) → consequence-worded confirm.
    armEl.addEventListener('click', () => {
      const next = !current.enabled;
      const patch: IntakeConnectorConfigPatch = { id, enabled: next };
      if (isRiskyIntakeChange(asIntakeConfig(current), patch)) {
        askConfirm(`Enable “${current.label}”? It will pull from ${current.typeLabel} on its ${schedulePresetLabel(current.schedule)} schedule.`, () => apply(patch));
      } else void apply(patch);
    });

    // Schedule segmented — steering, not risky → applies directly.
    for (const opt of Array.from(li.querySelectorAll<HTMLButtonElement>('.intake-schedule .rdesk-seg-opt'))) {
      opt.addEventListener('click', () => {
        const v = opt.dataset.value;
        if (v && v !== current.schedule) void apply({ id, schedule: v as IntakeConnectorConfigPatch['schedule'] });
      });
    }

    // Config + scope/sensitivity — steering, saved on an explicit button (blank fields are dropped backend-side).
    saveBtn.addEventListener('click', () =>
      void apply({
        id,
        scope: scopeEl.value,
        sensitivity: sensitivityEl.value,
        ...(feedUrlEl ? { feedUrl: feedUrlEl.value } : {}),
        ...(tenantEl ? { tenantId: tenantEl.value } : {}),
        ...(folderEl ? { folder: folderEl.value } : {}),
      }),
    );

    // Editable items-per-pull (INTAKE-11) — applies on change; the IPC clamps, the re-render reflects the
    // persisted (clamped) value, so an out-of-range entry round-trips back to the pinned bound.
    maxItemsEl.addEventListener('change', () => {
      const n = Number(maxItemsEl.value);
      if (Number.isFinite(n)) void apply({ id, maxItemsPerPass: Math.round(n) });
      else void render(container);
    });

    runBtn.addEventListener('click', () => {
      askConfirm(`Pull “${current.label}” now? It performs one bounded pull.`, async () => {
        status.textContent = '';
        runBtn.disabled = true;
        runBtn.textContent = 'PULLING…';
        runBtn.classList.add('viz-btn--busy');
        try {
          const res = await window.kbApi.runIntakeConnectorNow(id);
          let msg: string;
          if ('reason' in res) msg = `Couldn't pull (${res.reason}).`;
          else if (res.failed) msg = `Couldn't pull${res.error ? ` — ${res.error}` : ''}.`; // failed ≠ empty (INTAKE-12)
          else msg = res.sourceIds.length ? `Brought in ${res.sourceIds.length} new item${res.sourceIds.length === 1 ? '' : 's'}.` : 'No new items this pull.';
          await render(container);
          const after = container.querySelector<HTMLElement>(`.rdesk-strip[data-id="${id}"] .intake-status`);
          if (after) after.textContent = msg;
        } catch {
          status.textContent = "Couldn't pull.";
          runBtn.disabled = false;
          runBtn.textContent = '▷ Pull now';
          runBtn.classList.remove('viz-btn--busy');
        }
      });
    });

    confirmGo.addEventListener('click', () => {
      const run = pending;
      hideConfirm();
      status.textContent = '';
      if (run) void run();
    });
    confirmCancel.addEventListener('click', () => hideConfirm());
  }
}

async function addConnector(container: HTMLElement, type: IntakeConnectorConfigPatch['type']): Promise<void> {
  const idEl = container.querySelector<HTMLInputElement>('.intake-add-id')!;
  const status = container.querySelector<HTMLElement>('.intake-add-status')!;
  const id = slugifyId(idEl.value.trim());
  if (!id) {
    status.textContent = 'Give the feed a name (letters or digits).';
    idEl.focus();
    return;
  }
  status.textContent = 'Adding…';
  try {
    // Created PAUSED — safe; enabling it later is the confirm gate (it starts an outbound pull).
    await window.kbApi.setIntakeConnectorConfig({ id, type, enabled: false });
    await render(container);
  } catch {
    status.textContent = 'Could not add — try a simpler name (letters, digits, spaces).';
  }
}

/** Slugify a friendly name into a canonical connector id ([a-z0-9-], no leading/trailing dashes). */
function slugifyId(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}
