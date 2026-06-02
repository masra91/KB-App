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
  VIEW_ASK,
  VIEW_PLACEHOLDER,
  VIEW_JOBS,
  VIEW_AGENTS,
  VIEW_RESEARCHERS,
  VIEW_SOURCES,
  VIEW_SETTINGS,
} from './views';
import { esc } from './html';
import { reviewBadgeText, reviewBadgeAria } from './reviewBadge';
import { mountCapture } from './views/captureView';
import { mountReviews } from './views/reviewsView';
import { mountActivity } from './views/activityView';
import { mountAsk } from './views/askView';
import { mountPlaceholder } from './views/placeholderView';
import { mountJobs } from './views/jobsView';
import { mountAgents } from './views/agentsView';
import { mountResearchers } from './views/researchersView';
import { mountSources } from './views/sourcesView';
import { mountSettings } from './views/settingsView';

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
      `<span class="nav-icon" aria-hidden="true">${esc(v.icon ?? '')}</span>` +
      `<span class="nav-label">${esc(v.label)}</span></button>`;
  }
  return html;
}

/** Mount a view's content into its (freshly created) container. */
type MountFn = (container: HTMLElement) => void | Promise<void>;

export function mountShell(root: HTMLElement, vaultPath: string, name: string): void {
  const mounts: Record<string, MountFn> = {
    [VIEW_CAPTURE]: (c) => mountCapture(c, vaultPath, name),
    [VIEW_REVIEWS]: mountReviews,
    [VIEW_ACTIVITY]: mountActivity,
    [VIEW_ASK]: mountAsk,
    [VIEW_PLACEHOLDER]: mountPlaceholder,
    [VIEW_JOBS]: mountJobs,
    [VIEW_AGENTS]: mountAgents,
    [VIEW_RESEARCHERS]: mountResearchers,
    [VIEW_SOURCES]: mountSources,
    [VIEW_SETTINGS]: mountSettings,
  };

  const model = createNavModel(NAV_VIEWS, DEFAULT_VIEW_ID);

  document.body.classList.add('shell-active');
  root.innerHTML = `
    <div class="shell">
      <nav class="sidebar" aria-label="Primary">
        ${railHtml(NAV_VIEWS)}
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
      void updateReviewBadge();
    }, 5000);
  }
}
