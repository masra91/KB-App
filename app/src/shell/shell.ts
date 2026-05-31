// App Navigation Shell — DOM layer (SPEC-0017 SHELL-1/2/3/4).
//
// Thin glue over the pure navModel (SHELL-6): it renders a persistent left rail and
// a single content region, mounts each view lazily once, and switches by toggling
// visibility (which is what lets in-progress capture text survive a switch — SHELL-8).
import { createNavModel } from './navModel';
import { NAV_VIEWS, DEFAULT_VIEW_ID, VIEW_CAPTURE, VIEW_REVIEWS, VIEW_PLACEHOLDER, VIEW_SETTINGS } from './views';
import { esc } from './html';
import { mountCapture } from './views/captureView';
import { mountReviews } from './views/reviewsView';
import { mountPlaceholder } from './views/placeholderView';
import { mountSettings } from './views/settingsView';

/** Mount a view's content into its (freshly created) container. */
type MountFn = (container: HTMLElement) => void | Promise<void>;

export function mountShell(root: HTMLElement, vaultPath: string, name: string): void {
  const mounts: Record<string, MountFn> = {
    [VIEW_CAPTURE]: (c) => mountCapture(c, vaultPath, name),
    [VIEW_REVIEWS]: mountReviews,
    [VIEW_PLACEHOLDER]: mountPlaceholder,
    [VIEW_SETTINGS]: mountSettings,
  };

  const model = createNavModel(NAV_VIEWS, DEFAULT_VIEW_ID);

  document.body.classList.add('shell-active');
  root.innerHTML = `
    <div class="shell">
      <nav class="sidebar" aria-label="Primary">
        ${NAV_VIEWS.map(
          (v) =>
            `<button type="button" class="nav-item" data-view="${esc(v.id)}">` +
            `<span class="nav-icon" aria-hidden="true">${esc(v.icon ?? '')}</span>` +
            `<span class="nav-label">${esc(v.label)}</span></button>`,
        ).join('')}
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
}
