// Activity view (SPEC-0029 AUDIT-5/6/7/8) — the "observatory". A read-only window on what the KB
// has been doing: a curated, human-friendly feed (one entry per run) with drill-down to the raw
// audit events, filter/search (by actor + free text), and a lineage tracer for any subject id.
//
// READ-ONLY (AUDIT-8): no retries, edits, approvals, or config here — those live in Reviews /
// Control Panel. Thin DOM over the typed IPC, matching the other views; `esc()` on every
// interpolation (XSS-safe). Render helpers are pure (data → HTML string) so they unit-test without
// a DOM; `mountActivity` wires the IPC + events.
//
// NB: imports here are TYPE-ONLY from kb/types (erased at build) — the renderer must not pull the
// audit domain modules' node:fs/simple-git runtime deps (STACK-6). The actor filter options are
// derived from the loaded data, not imported from AUDIT_ACTORS (a runtime value).
import { esc } from '../html';
import { withTimeout } from '../loadGuard';
import { formatTimestamp } from '../formatTime';
import { stageDisplayName } from '../stageLabels';
import type { ActivityFeedEntry, AuditEvent, Lineage, ActivityFilter, AuditActor } from '../../kb/types';

// View-local, ephemeral state (the shell mounts once + toggles visibility).
let entries: ActivityFeedEntry[] = [];
let total = 0;
let truncated = false;
let knownActors: string[] = []; // the actor universe, captured from the first unfiltered load
let filter: ActivityFilter = {};
let expanded = new Set<string>(); // entry ids currently drilled-down to raw events
let lineage: Lineage | null = null;
let loading = false;
let errorMsg = '';

export function mountActivity(container: HTMLElement): void {
  entries = [];
  total = 0;
  truncated = false;
  knownActors = [];
  filter = {};
  expanded = new Set();
  lineage = null;
  loading = true;
  errorMsg = '';
  container.innerHTML = `
    <div class="card activity-view">
      <h1>📜 Activity</h1>
      <p class="activity-note">What your knowledge base has been doing — and why. Read-only.</p>
      <div class="activity-controls" id="activityControls"></div>
      <div class="activity-body" id="activityBody"></div>
      <div class="activity-lineage" id="activityLineage"></div>
    </div>`;
  wire(container);
  renderControls(container);
  void load(container);
}

/** (Re)load the feed for the current filter (AUDIT-5/7). buildActivityIndex on the main side keeps
 *  it fresh; the first unfiltered load seeds the actor dropdown universe. */
async function load(container: HTMLElement): Promise<void> {
  loading = true;
  errorMsg = '';
  renderBody(container);
  try {
    // #145: bound the wait so a hung `activityFeed` can't leave an infinite spinner.
    const res = await withTimeout(window.kbApi.activityFeed(filter));
    entries = res.entries;
    total = res.total;
    truncated = res.truncated;
    if (knownActors.length === 0 && !hasActiveFilter()) {
      knownActors = [...new Set(entries.map((e) => e.actor))].sort();
      renderControls(container);
    }
  } catch (err) {
    errorMsg = err instanceof Error ? err.message : String(err);
  } finally {
    loading = false;
    renderBody(container);
  }
}

function hasActiveFilter(): boolean {
  return Boolean(filter.actors?.length || filter.text);
}

// ── Event wiring ────────────────────────────────────────────────────────────────────────────────

function wire(container: HTMLElement): void {
  // Delegate: controls + feed rerender, so handlers survive innerHTML swaps.
  container.addEventListener('input', (e) => {
    const t = e.target as HTMLElement;
    if (t.id === 'activitySearch') {
      const v = (t as HTMLInputElement).value.trim();
      filter = { ...filter, text: v || undefined };
      void load(container);
    }
  });
  container.addEventListener('change', (e) => {
    const t = e.target as HTMLElement;
    if (t.id === 'activityActor') {
      const v = (t as HTMLSelectElement).value;
      filter = { ...filter, actors: v ? [v as AuditActor] : undefined };
      void load(container);
    }
  });
  container.addEventListener('click', (e) => {
    const el = (e.target as HTMLElement).closest<HTMLElement>('[data-act]');
    if (!el) return;
    const act = el.dataset.act;
    if (act === 'toggle') {
      const id = el.dataset.id!;
      if (expanded.has(id)) expanded.delete(id);
      else expanded.add(id);
      renderBody(container);
    } else if (act === 'lineage') {
      void traceLineage(container, el.dataset.id!);
    } else if (act === 'clear-lineage') {
      lineage = null;
      renderLineage(container);
    } else if (act === 'retry-load') {
      void load(container); // #145: re-run the feed load after a failure/timeout
    }
  });
}

async function traceLineage(container: HTMLElement, id: string): Promise<void> {
  try {
    lineage = await withTimeout(window.kbApi.activityLineage(id));
  } catch (err) {
    lineage = { subjectId: id, kind: 'unknown', sources: [], events: [], decisions: [] };
    errorMsg = err instanceof Error ? err.message : String(err);
  }
  renderLineage(container);
}

// ── Render (pure helpers return HTML strings) ─────────────────────────────────────────────────

function renderControls(container: HTMLElement): void {
  const el = container.querySelector<HTMLElement>('#activityControls');
  if (el) el.innerHTML = controlsHtml(knownActors, filter);
}
function renderBody(container: HTMLElement): void {
  const el = container.querySelector<HTMLElement>('#activityBody');
  if (el) el.innerHTML = bodyHtml({ entries, total, truncated, expanded, loading, errorMsg });
}
function renderLineage(container: HTMLElement): void {
  const el = container.querySelector<HTMLElement>('#activityLineage');
  if (el) el.innerHTML = lineage ? lineageHtml(lineage) : '';
}

export function controlsHtml(actors: readonly string[], f: ActivityFilter): string {
  const opts = ['<option value="">All activity</option>']
    .concat(actors.map((a) => `<option value="${esc(a)}"${f.actors?.[0] === a ? ' selected' : ''}>${esc(a)}</option>`))
    .join('');
  return `
    <label class="viz-field activity-field">
      <span class="viz-field__label viz-signage">actor</span>
      <select id="activityActor" class="activity-actor viz-field__input viz-body viz-focusable" aria-label="Filter by actor">${opts}</select>
    </label>
    <label class="viz-field activity-field">
      <span class="viz-field__label viz-signage">search</span>
      <input id="activitySearch" class="activity-search viz-field__input viz-body viz-focusable" type="search" placeholder="Search activity…" aria-label="Search activity" value="${esc(f.text ?? '')}" />
    </label>`;
}

interface BodyState {
  entries: ActivityFeedEntry[];
  total: number;
  truncated: boolean;
  expanded: Set<string>;
  loading: boolean;
  errorMsg: string;
}

export function bodyHtml(s: BodyState): string {
  if (s.loading) return `<p class="activity-note">Loading…</p>`;
  // #145: a failed/timed-out load is retryable, never an infinite spinner. The view's header +
  // controls stay mounted around this body, so a button here (not a full renderLoadError) suffices.
  if (s.errorMsg) return `<p class="activity-error error">Couldn’t load activity: ${esc(s.errorMsg)} <button type="button" class="viz-btn viz-btn--sm viz-focusable load-retry" data-act="retry-load">Retry</button></p>`;
  if (s.entries.length === 0) return `<p class="activity-note activity-empty">No activity yet — once your KB starts processing, what it does shows up here.</p>`;
  const note = s.truncated
    ? `<p class="activity-note activity-truncation">Showing the ${s.entries.length} most recent of ${s.total} events.</p>`
    : `<p class="activity-note activity-count">${s.total} event${s.total === 1 ? '' : 's'}.</p>`;
  return note + `<ul class="activity-feed">${s.entries.map((e) => entryHtml(e, s.expanded.has(e.id))).join('')}</ul>`;
}

/** A subject id to offer a lineage trace on (entity preferred, else source/claim). */
function traceableSubject(e: ActivityFeedEntry): string | null {
  const s = e.events[0]?.subjects ?? {};
  return s.entityId ?? s.sourceId ?? s.claimId ?? null;
}

export function entryHtml(e: ActivityFeedEntry, open: boolean): string {
  const trace = traceableSubject(e);
  const traceBtn = trace ? `<button class="activity-trace viz-btn viz-btn--ghost viz-btn--sm viz-focusable" data-act="lineage" data-id="${esc(trace)}" aria-label="Trace the origin of: ${esc(e.summary)}">trace origin</button>` : '';
  const raw = open
    ? `<div class="activity-raw">${e.events.map(rawEventHtml).join('')}</div>`
    : '';
  // The expand toggle and the (optional) trace-origin action share one centered header row — trace can't
  // nest inside the head <button>, so the row aligns them as flex siblings (head fills, trace trails).
  return `
    <li class="activity-entry${open ? ' open' : ''}">
      <div class="activity-entry-row">
        <button class="activity-entry-head viz-focusable" data-act="toggle" data-id="${esc(e.id)}" aria-expanded="${open}">
          <span class="activity-actor-badge viz-chip" title="${esc(e.actor)}">${esc(stageDisplayName(e.actor))}</span>
          <span class="activity-summary">${esc(e.summary)}</span>
          <span class="activity-ts">${esc(formatTimestamp(e.ts))}</span>
          ${e.eventCount > 1 ? `<span class="activity-evcount">${e.eventCount} events</span>` : ''}
        </button>
        ${traceBtn}
      </div>
      ${raw}
    </li>`;
}

/** Drill-down: the raw canonical event behind a feed entry (AUDIT-5). */
export function rawEventHtml(ev: AuditEvent): string {
  const json = JSON.stringify({ ts: ev.ts, actor: ev.actor, eventType: ev.eventType, runId: ev.runId, model: ev.model, subjects: ev.subjects, payload: ev.payload }, null, 2);
  return `<pre class="activity-event"><code>${esc(json)}</code></pre><div class="activity-event-src">${esc(ev.provenance.file)}:${ev.provenance.line}</div>`;
}

export function lineageHtml(l: Lineage): string {
  if (l.events.length === 0) {
    return `<div class="lineage-panel"><div class="lineage-head"><strong>Lineage:</strong> <code>${esc(l.subjectId)}</code> <button class="viz-btn viz-btn--ghost viz-btn--sm viz-focusable" data-act="clear-lineage" aria-label="Close lineage panel">close</button></div><p class="activity-note">No lineage found for this id.</p></div>`;
  }
  const sources = l.sources.length ? `<div class="lineage-sources activity-note">From source${l.sources.length === 1 ? '' : 's'}: ${l.sources.map((s) => `<code>${esc(s)}</code>`).join(', ')}</div>` : '';
  const timeline = l.events
    .map((e) => `<li class="lineage-step"><span class="activity-actor-badge viz-chip" title="${esc(e.actor)}">${esc(stageDisplayName(e.actor))}</span> <span>${esc(e.eventType)}</span> <span class="lineage-step-ts">${esc(formatTimestamp(e.ts))}</span></li>`)
    .join('');
  const decisions = l.decisions.length
    ? `<div class="lineage-decisions"><span class="lineage-decisions-label viz-signage">Decisions:</span><ul>${l.decisions.map((d) => `<li>${esc(d.eventType)}${typeof d.payload.verdict === 'string' ? ` — ${esc(d.payload.verdict)}` : ''}${typeof d.payload.question === 'string' ? ` (${esc(d.payload.question)})` : ''}</li>`).join('')}</ul></div>`
    : '';
  return `
    <div class="lineage-panel">
      <div class="lineage-head"><strong>Lineage:</strong> <code>${esc(l.subjectId)}</code> <span class="lineage-kind">(${esc(l.kind)})</span> <button class="viz-btn viz-btn--ghost viz-btn--sm viz-focusable" data-act="clear-lineage" aria-label="Close lineage panel">close</button></div>
      ${sources}
      <ol class="lineage-timeline">${timeline}</ol>
      ${decisions}
    </div>`;
}
