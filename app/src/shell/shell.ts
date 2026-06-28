// App Navigation Shell — DOM layer (SPEC-0017 SHELL-1/2/3/4).
//
// Thin glue over the pure navModel (SHELL-6): it renders a persistent left rail and
// a single content region, mounts each view lazily once, and switches by toggling
// visibility (which is what lets in-progress capture text survive a switch — SHELL-8).
import { createNavModel, type NavView } from './navModel';
import {
  NAV_VIEWS,
  DEFAULT_VIEW_ID,
  VIEW_CAPTURE,
  VIEW_REVIEWS,
  VIEW_ACTIVITY,
  VIEW_STATUS,
  VIEW_ASK,
  VIEW_EXPLORE,
  VIEW_HEALTH,
  VIEW_AGENTS,
  VIEW_SOURCES,
  VIEW_SETTINGS,
} from './views';
import { esc } from './html';
import { navIcon } from './icons';
import { NAVIGATE_EVENT, type NavigateDetail } from './nav';
import { reviewBadgeText, reviewBadgeAria } from './reviewBadge';
import { mountCapture } from './views/captureView';
import { mountReviews } from './views/reviewsView';
import { mountActivity } from './views/activityView';
import { mountStatus } from './views/statusView';
import { mountAsk } from './views/askView';
import { mountExplore } from './views/exploreView';
import { mountHealth } from './views/healthView';
import { mountAgentsHub } from './views/agentsHubView';
import { mountSources } from './views/sourcesView';
import { mountSettings } from './views/settingsView';

// The Vellum crystalline mark (brand/assets/icon/vellum-glyph-mono.svg) — gold-stroked via --viz-brass
// (rationed accent; unchanged on dark). Inlined (no asar-asset path gotcha). Decorative → aria-hidden.
const BRAND_GLYPH =
  `<svg class="sidebar-brand-glyph" width="24" height="24" viewBox="0 0 24 24" aria-hidden="true">` +
  `<g fill="none" stroke="var(--viz-brass)" stroke-linejoin="round"><polygon points="12,2 22,12 12,22 2,12" stroke-width="1.4"/>` +
  `<polygon points="12,7 17,12 12,17 7,12" stroke-width="1.1"/></g><circle cx="12" cy="12" r="1.9" fill="var(--viz-brass)"/></svg>`;
// A large, very-faint fractal-lattice watermark low in the sidebar (UX v2 shell language).
const SIDEBAR_WMARK =
  `<div class="sidebar-wmark" aria-hidden="true"><svg width="220" height="220" viewBox="0 0 24 24">` +
  `<g fill="none" stroke="var(--viz-brass)" stroke-linejoin="round" stroke-width="0.5"><polygon points="12,2 22,12 12,22 2,12"/>` +
  `<polygon points="12,7 17,12 12,17 7,12"/><line x1="2" y1="12" x2="22" y2="12"/><line x1="12" y1="2" x2="12" y2="22"/></g></svg></div>`;

/** Build the rail's inner HTML: a section heading before each new `group`, then one button per view. */
function railHtml(views: readonly NavView[]): string {
  let lastGroup: string | undefined;
  let html = '';
  for (const v of views) {
    if (v.group && v.group !== lastGroup) {
      html += `<div class="nav-group" role="presentation">${esc(v.group)}</div>`;
    }
    lastGroup = v.group;
    html +=
      `<button type="button" class="nav-item" data-view="${esc(v.id)}">` +
      // v.icon is a trusted icon-set KEY → inline line-icon SVG (UX v2); navIcon returns '' for an unknown key.
      `<span class="nav-icon" aria-hidden="true">${v.icon ? navIcon(v.icon) : ''}</span>` +
      `<span class="nav-label">${esc(v.label)}</span></button>`;
  }
  return html;
}

/** Mount a view's content into its (freshly created) container. */
type MountFn = (container: HTMLElement) => void | Promise<void>;

/** The active shell's `kb:navigate` handler — module-scoped so a vault switch (re-mount) removes the
 *  prior shell's handler before binding the new model, never leaking listeners / firing a stale model. */
let navHandler: ((e: Event) => void) | null = null;

export function mountShell(root: HTMLElement, vaultPath: string, name: string): void {
  const mounts: Record<string, MountFn> = {
    [VIEW_CAPTURE]: (c) => mountCapture(c, vaultPath, name),
    [VIEW_REVIEWS]: mountReviews,
    [VIEW_ACTIVITY]: mountActivity,
    [VIEW_STATUS]: mountStatus,
    [VIEW_ASK]: mountAsk,
    [VIEW_EXPLORE]: mountExplore,
    [VIEW_HEALTH]: mountHealth,
    [VIEW_AGENTS]: mountAgentsHub,
    [VIEW_SOURCES]: mountSources,
    [VIEW_SETTINGS]: mountSettings,
  };

  const model = createNavModel(NAV_VIEWS, DEFAULT_VIEW_ID);

  // View→view deep-links (SHELL): a view dispatches `kb:navigate` (e.g. the Field Desk escalation report
  // → Reviews); we select the named view if it's a real one. Re-bind per mount (vault switch) so the
  // handler always drives the CURRENT model — remove the prior shell's first (no leak / stale select).
  if (navHandler) document.removeEventListener(NAVIGATE_EVENT, navHandler);
  navHandler = (e: Event): void => {
    const view = (e as CustomEvent<NavigateDetail>).detail?.view;
    if (typeof view === 'string' && view in mounts) model.select(view);
  };
  document.addEventListener(NAVIGATE_EVENT, navHandler);

  document.body.classList.add('shell-active');
  root.innerHTML = `
    <div class="shell">
      <nav class="sidebar" aria-label="Primary">
        <div class="sidebar-brand">${BRAND_GLYPH}<span class="sidebar-brand-name viz-voice">Vellum</span></div>
        <div class="sidebar-nav">${railHtml(NAV_VIEWS)}</div>
        ${SIDEBAR_WMARK}
      </nav>
      <main class="content" id="viewHost"></main>
    </div>`;

  const host = root.querySelector('#viewHost') as HTMLElement;
  const buttons = Array.from(root.querySelectorAll<HTMLButtonElement>('.nav-item'));
  const containers = new Map<string, HTMLElement>();

  function render(): void {
    const activeId = model.activeId;

    // Lazily create + mount the active view's container on first activation.
    if (!containers.has(activeId)) {
      const el = document.createElement('div');
      el.className = 'view';
      el.dataset.view = activeId;
      host.appendChild(el);
      containers.set(activeId, el);
      void mounts[activeId]?.(el);
    }

    for (const [id, el] of containers) el.classList.toggle('hidden', id !== activeId);
    for (const b of buttons) {
      const isActive = b.dataset.view === activeId;
      b.classList.toggle('active', isActive);
      if (isActive) b.setAttribute('aria-current', 'page');
      else b.removeAttribute('aria-current');
    }
  }

  for (const b of buttons) {
    b.addEventListener('click', () => model.select(b.dataset.view!));
  }
  model.onChange(render);
  render(); // initial paint → Capture (SHELL-4)

  // PANEL-8: surface the "needs you" review count on the Reviews rail item, so it's visible from
  // anywhere (incl. the Manage section) and the item links to the queue (clicking it navigates).
  // Live via a light poll; stops if the shell is detached. Never errors the shell (degrades to no badge).
  const reviewsBtn = buttons.find((b) => b.dataset.view === VIEW_REVIEWS);
  if (reviewsBtn) {
    const updateReviewBadge = async (): Promise<void> => {
      let count = 0;
      try {
        count = (await window.kbApi.listReviews()).length;
      } catch {
        return; // leave the last-known badge
      }
      let badge = reviewsBtn.querySelector<HTMLElement>('.nav-badge');
      const text = reviewBadgeText(count);
      if (!text) {
        badge?.remove();
        reviewsBtn.removeAttribute('aria-label');
        return;
      }
      if (!badge) {
        badge = document.createElement('span');
        badge.className = 'nav-badge';
        badge.setAttribute('aria-hidden', 'true');
        reviewsBtn.appendChild(badge);
      }
      badge.textContent = text;
      reviewsBtn.setAttribute('aria-label', `${reviewsBtn.textContent?.trim() ?? 'Reviews'} — ${reviewBadgeAria(count)}`);
    };
    void updateReviewBadge();
    const timer = setInterval(() => {
      if (!document.contains(root)) {
        clearInterval(timer);
        return;
      }
      // The badge lives in the always-visible rail, so it stays live across in-app view switches —
      // but skip the IPC when the window itself is hidden/backgrounded (no one's looking).
      if (document.hidden) return;
      void updateReviewBadge();
    }, 5000);
  }
}
