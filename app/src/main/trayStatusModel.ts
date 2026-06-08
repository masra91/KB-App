// QCAP-14: the read-only menubar tray live-status readout. A pure, DOM-free composition of the OBS
// pipeline-status view-model (SPEC-0030 OBS-5: per-stage queue depth + overall state) into the lines
// the tray menu renders as disabled (read-only) items — so the Principal can glance at the menubar
// without opening the app. Read-only (the observatory invariant, AUDIT-8 / OBS-9 — no actions here).
//
// Mirrors The Line's Status headline vocabulary VERBATIM (shared `OVERALL_GLYPH`/`OVERALL_LABEL` +
// `stageDisplayName`) so the two surfaces read as one system and can't drift (Design-Lead, QCAP-14).
// Pure + unit-tested; the Electron glue (quickCaptureElectron.setTray) just renders these strings.
import type { PipelineStatusView } from '../kb/pipelineStatusView';
import { stageIndex } from '../kb/pipelineStages';
import { OVERALL_GLYPH, OVERALL_LABEL } from '../kb/pipelineStatusLabels';
import { stageDisplayName } from '../shell/stageLabels';

/** Headline count-noun for the backlog total (Design-Lead ruling): the headline sums per-stage QUEUE
 *  depths = work *waiting* (not "in progress" — that's the In-flight/active count). "waiting" matches
 *  the VIZ-10 legend's own gloss ("queue = waiting") and reads plainest in the menubar. */
const WAITING_NOUN = 'waiting';

/** Per-stage detail shows at most the top-N busiest stages (by queue depth); the rest collapse to `…`
 *  so the menubar line stays compact (Design-Lead: canonical movers + overflow indicator). */
export const MAX_TRAY_STAGES = 3;

/** Round a count to a calm, approximate magnitude (2 significant figures; exact below 10) so the
 *  headline total reads as approximate (`~`) and doesn't twitch on every single item moving. The
 *  per-stage counts stay EXACT (that's where the precision lives). */
export function approxCount(n: number): number {
  if (n < 10) return n;
  const mag = Math.pow(10, Math.floor(Math.log10(n)) - 1);
  return Math.round(n / mag) * mag;
}

/** Build the read-only tray status readout lines from the OBS view-model (QCAP-14). Each string
 *  becomes one disabled menu item. State-gated (progressive disclosure, Design-Lead):
 *  - running with a backlog → two lines: `◐ Running — ~N waiting` + `Decompose 12 · Linking 340 · …`
 *  - running with nothing queued → one line: `◐ Running` (active, nothing waiting)
 *  - idle → one line: `○ Idle — all caught up`
 *  - stalled → one line: `✕ Stalled — needs you` (never hide a failure behind a friendly word)
 *  Returns `[]` when there's no status to show (no active KB / view-model unavailable) → no section. */
export function trayStatusModel(view: PipelineStatusView | null): string[] {
  if (!view) return [];
  const head = `${OVERALL_GLYPH[view.overall]} ${OVERALL_LABEL[view.overall]}`;
  if (view.overall === 'idle') return [`${head} — all caught up`];
  if (view.overall === 'stalled') return [`${head} — needs you`];

  // running: summarise the backlog (Σ queue depth) + the busiest stages.
  const withQueue = view.stages.filter((s) => s.queueDepth > 0);
  const totalWaiting = withQueue.reduce((sum, s) => sum + s.queueDepth, 0);
  if (totalWaiting === 0) return [head]; // active but nothing queued — just the state, no zero-noise

  const headline = `${head} — ~${approxCount(totalWaiting).toLocaleString('en-US')} ${WAITING_NOUN}`;
  // Top-N busiest stages, displayed in pipeline order; `…` when more stages still have a backlog.
  const top = [...withQueue].sort((a, b) => b.queueDepth - a.queueDepth).slice(0, MAX_TRAY_STAGES);
  const ordered = top.sort((a, b) => stageIndex(a.stage) - stageIndex(b.stage));
  const perStage =
    ordered.map((s) => `${stageDisplayName(s.stage)} ${s.queueDepth}`).join(' · ') +
    (withQueue.length > MAX_TRAY_STAGES ? ' · …' : '');
  return [headline, perStage];
}
