// Pipeline Status view (SPEC-0030 OBS-5/6/7/8/9/11/15) — the live "what's the pipeline doing, and
// why is it stuck?" observatory. READ-ONLY (OBS-9): no retries/config here (those live in Reviews /
// Control Panel) — it reports, never mutates. Complements Activity (SPEC-0029): Activity = what
// happened; Status = what's happening now + where it broke.
//
// Shows (OBS-5/6/7/15): overall state (running/idle/stalled), per-stage flow (state + queue depth +
// current item + set-aside), the canonical-writer lock holder/waiters, recent errors with
// drill-down, the live worktrees, and the latency/throughput breakdown (Copilot p50/p95,
// where-time-goes). Live-updates by polling `kb:pipelineStatusView` (OBS-8) — but only while the
// view is visible (the shell mounts once + toggles display; idle polling when hidden is wasteful,
// per the #86 dogfood). Thin DOM over the typed IPC; `esc()` on every interpolation (XSS-safe);
// render helpers are pure (data → HTML string) so they unit-test without a DOM.
import { esc } from '../html';
import { withTimeout } from '../loadGuard';
import type { PipelineStatusView, StageStatus, RecentError, WorktreeInfo } from '../../kb/types';

const POLL_MS = 2500;

// View-local, ephemeral state (the shell mounts once + toggles visibility).
let view: PipelineStatusView | null = null;
let loading = false;
let errorMsg = '';
let expanded = new Set<number>(); // recent-error rows drilled-down to their cause (OBS-6)
let timer: ReturnType<typeof setInterval> | null = null;

export function mountStatus(container: HTMLElement): void {
  view = null;
  loading = true;
  errorMsg = '';
  expanded = new Set();
  container.innerHTML = `
    <div class="card status-view">
      <h1>📊 Pipeline Status</h1>
      <p class="muted">What the pipeline is doing right now — and where it's stuck. Read-only.</p>
      <div class="status-body" id="statusBody"></div>
    </div>`;
  wire(container);
  void load(container);
  // Live-update (OBS-8) — poll only while visible (don't burn IPC when another view is showing).
  // Clear any prior interval first so a re-mount never stacks pollers.
  if (timer !== null) clearInterval(timer);
  timer = setInterval(() => {
    if (isVisible(container)) void load(container);
  }, POLL_MS);
}

/** Stop the live-update poll (clean shutdown / tests). */
export function stopStatusPolling(): void {
  if (timer !== null) {
    clearInterval(timer);
    timer = null;
  }
}

/** True when the view is actually on screen (the shell hides inactive views with display:none). */
function isVisible(container: HTMLElement): boolean {
  return container.offsetParent !== null || container.getClientRects().length > 0;
}

async function load(container: HTMLElement): Promise<void> {
  if (view === null) {
    loading = true;
    renderBody(container);
  }
  try {
    // #145: bound the wait — a hung `pipelineStatusView` must surface as an error, not an infinite
    // "Loading…". The live poll (POLL_MS) then auto-retries, so no manual retry button is needed here.
    view = await withTimeout(window.kbApi.pipelineStatusView());
    errorMsg = '';
  } catch (err) {
    errorMsg = err instanceof Error ? err.message : String(err);
  } finally {
    loading = false;
    renderBody(container);
  }
}

function wire(container: HTMLElement): void {
  container.addEventListener('click', (e) => {
    const el = (e.target as HTMLElement).closest<HTMLElement>('[data-act]');
    if (!el) return;
    if (el.dataset.act === 'toggle-err') {
      const i = Number(el.dataset.i);
      if (expanded.has(i)) expanded.delete(i);
      else expanded.add(i);
      renderBody(container);
    }
  });
}

function renderBody(container: HTMLElement): void {
  const el = container.querySelector<HTMLElement>('#statusBody');
  if (el) el.innerHTML = bodyHtml({ view, loading, errorMsg, expanded });
}

// ── Render (pure helpers return HTML strings) ─────────────────────────────────────────────────

interface BodyState {
  view: PipelineStatusView | null;
  loading: boolean;
  errorMsg: string;
  expanded: Set<number>;
}

export function bodyHtml(s: BodyState): string {
  if (s.errorMsg) return `<p class="status-error error">Couldn’t load status: ${esc(s.errorMsg)}</p>`;
  if (s.loading && s.view === null) return `<p class="muted">Loading…</p>`;
  if (s.view === null) return `<p class="muted status-empty">No knowledge base open.</p>`;
  return [
    overallHtml(s.view),
    stagesHtml(s.view.stages),
    lockHtml(s.view.lock),
    errorsHtml(s.view.recentErrors, s.expanded),
    latencyHtml(s.view),
    worktreesHtml(s.view.worktrees),
  ].join('');
}

/** OBS-5/11: the headline state. A stall is called out prominently (the silent stall, made loud). */
export function overallHtml(v: PipelineStatusView): string {
  const label = { running: 'Running', idle: 'Idle', stalled: 'Stalled' }[v.overall];
  const stalledNote = v.stalled
    ? `<p class="status-stall-note error">⚠️ Work is queued but nothing has progressed${v.lastActivity ? ` since ${esc(v.lastActivity)}` : ''} — the pipeline looks stuck. Check recent errors + the lock below.</p>`
    : '';
  const last = v.lastActivity ? `<span class="status-lastact muted">last activity ${esc(v.lastActivity)}</span>` : '';
  return `<div class="status-overall status-overall-${esc(v.overall)}"><span class="status-badge status-${esc(v.overall)}">${esc(label)}</span>${last}</div>${stalledNote}`;
}

/** OBS-5: per-stage flow — state, queue depth, current item, set-aside count. */
export function stagesHtml(stages: StageStatus[]): string {
  const rows = stages
    .map((st) => {
      const current = st.currentItem ? `<span class="status-current muted">▶ ${esc(st.currentItem)}</span>` : '';
      const setAside = st.setAside > 0 ? `<span class="status-setaside error">${st.setAside} set aside</span>` : '';
      return `
        <li class="status-stage status-stage-${esc(st.state)}">
          <span class="status-stage-name">${esc(st.stage)}</span>
          <span class="status-badge status-${esc(st.state)}">${esc(st.state)}</span>
          <span class="status-queue muted">queue ${st.queueDepth}</span>
          ${current}
          ${setAside}
        </li>`;
    })
    .join('');
  return `<h2 class="status-h2">Stages</h2><ul class="status-stages">${rows}</ul>`;
}

/** OBS-7: the canonical-writer lock — held/holder/waiters (so a stall's cause is visible). */
export function lockHtml(lock: PipelineStatusView['lock']): string {
  if (!lock.held) {
    const waiting = lock.waiters > 0 ? ` <span class="muted">(${lock.waiters} waiting)</span>` : '';
    return `<h2 class="status-h2">Canonical-writer lock</h2><p class="status-lock muted">free${waiting}</p>`;
  }
  const who = lock.holder ? esc(lock.holder) : 'a stage';
  const since = lock.since ? ` since ${esc(lock.since)}` : '';
  const waiting = lock.waiters > 0 ? `, ${lock.waiters} waiting` : '';
  return `<h2 class="status-h2">Canonical-writer lock</h2><p class="status-lock">held by <strong>${who}</strong>${esc(since)}${esc(waiting)}</p>`;
}

/** OBS-6: recent errors + set-aside markers, each expandable to its cause (drill-down). */
export function errorsHtml(errors: RecentError[], expanded: Set<number>): string {
  if (errors.length === 0) return `<h2 class="status-h2">Recent errors</h2><p class="muted">None — clean.</p>`;
  const rows = errors
    .map((e, i) => {
      const open = expanded.has(i);
      const where = [e.stage, e.itemId].filter(Boolean).map((x) => esc(String(x))).join(' · ');
      const detail = open
        ? `<div class="status-err-detail"><pre><code>${esc(e.message ?? '(no message)')}</code></pre>${e.runId ? `<div class="muted">runId ${esc(e.runId)}</div>` : ''}</div>`
        : '';
      return `
        <li class="status-err status-err-${esc(e.level)}${open ? ' open' : ''}">
          <button class="status-err-head" data-act="toggle-err" data-i="${i}" aria-expanded="${open}">
            <span class="status-badge status-${esc(e.level)}">${esc(e.level)}</span>
            <span class="status-err-event">${esc(e.event)}</span>
            ${where ? `<span class="muted">${where}</span>` : ''}
            <span class="status-err-ts muted">${esc(e.ts)}</span>
          </button>
          ${detail}
        </li>`;
    })
    .join('');
  return `<h2 class="status-h2">Recent errors</h2><ul class="status-errors">${rows}</ul>`;
}

/** OBS-15: latency & throughput — Copilot p50/p95, per-stage throughput, where-time-goes. */
export function latencyHtml(v: PipelineStatusView): string {
  const c = v.perf.copilot;
  const w = v.perf.whereTimeGoes;
  const copilot =
    c.count > 0
      ? `<p class="status-latency">Copilot calls: <strong>${c.count}</strong> · avg ${c.avgMs}ms · p50 ${c.p50Ms}ms · p95 ${c.p95Ms}ms</p>`
      : `<p class="muted">No Copilot calls recorded yet.</p>`;
  const where =
    w.totalMs > 0
      ? `<p class="status-where muted">Where time goes: ${Math.round(w.copilotPct * 100)}% Copilot, ${100 - Math.round(w.copilotPct * 100)}% other (${Math.round(w.copilotMs / 1000)}s / ${Math.round(w.totalMs / 1000)}s)</p>`
      : '';
  const stages = v.perf.stages.length
    ? `<ul class="status-throughput">${v.perf.stages
        .map((st) => `<li class="muted">${esc(st.stage)}: ${st.throughputPerMin}/min · ${st.runs} runs · avg ${st.avgMs}ms</li>`)
        .join('')}</ul>`
    : '';
  // Recent slow operations (OBS-15) — the few longest spans, so an outlier is visible.
  const slow = v.perf.slowest.length
    ? `<div class="status-slowops"><span class="muted">Slowest ops:</span><ul>${v.perf.slowest
        .slice(0, 5)
        .map((s) => {
          const where2 = [s.stage, s.itemId].filter(Boolean).map((x) => esc(String(x))).join(' · ');
          return `<li class="muted">${esc(s.op)}${where2 ? ` (${where2})` : ''}: ${s.durationMs}ms</li>`;
        })
        .join('')}</ul></div>`
    : '';
  return `<h2 class="status-h2">Latency &amp; throughput</h2>${copilot}${where}${stages}${slow}`;
}

/** OBS-7: the live worktrees + the branch each is on. */
export function worktreesHtml(worktrees: WorktreeInfo[]): string {
  if (worktrees.length === 0) return '';
  const rows = worktrees
    .map((w) => `<li class="muted"><code>${esc(w.path)}</code>${w.branch ? ` → ${esc(w.branch)}` : ''}</li>`)
    .join('');
  return `<h2 class="status-h2">Worktrees</h2><ul class="status-worktrees">${rows}</ul>`;
}
