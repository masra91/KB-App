// @vitest-environment happy-dom
//
// SPEC-0027 PANEL-8 — the Reviews "needs you" count badge on the nav rail, in the component tier.
// IPC mocked; we assert the badge reflects the open-review count (visible from the rail, hence from
// the Manage section) and that the Reviews item is the link to the queue. The badge text/label logic
// is node-tested in reviewBadge.test.ts; this covers the shell's DOM wiring + graceful degradation.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mountShell } from './shell';
import { VIEW_REVIEWS } from './views';
import type { KbApi, ReviewSummary } from '../kb/types';

const review = (id: string): ReviewSummary => ({ id, question: 'q', detail: 'd', stage: 'claims', refs: [], createdAt: 't' });

function setApi(listReviews: KbApi['listReviews']): void {
  (window as unknown as { kbApi: Partial<KbApi> }).kbApi = {
    listReviews,
    // Capture (the default view) polls pipelineStatus on mount; stub it so the shell mounts cleanly.
    pipelineStatus: vi.fn(async () => ({ queueDepth: 0, processing: null, lastArchived: null, updatedAt: null })),
    capture: vi.fn(),
  };
}
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));
const reviewsBtn = (root: HTMLElement): HTMLElement => root.querySelector(`.nav-item[data-view="${VIEW_REVIEWS}"]`)!;

describe('shell review-count badge (SPEC-0027 PANEL-8)', () => {
  let root: HTMLElement;
  beforeEach(() => {
    document.body.innerHTML = '<div id="app"></div>';
    root = document.getElementById('app')!;
  });
  afterEach(() => {
    document.body.innerHTML = ''; // detach → the badge poll stops itself
    vi.restoreAllMocks();
  });

  it('shows the open-review count on the Reviews rail item (visible from Manage)', async () => {
    setApi(vi.fn(async () => [review('a'), review('b'), review('c')]));
    mountShell(root, '/vault', 'KB');
    await tick();
    const badge = reviewsBtn(root).querySelector('.nav-badge');
    expect(badge?.textContent).toBe('3');
    // The Reviews item is the link to the queue — present in the rail alongside the Manage group.
    expect(reviewsBtn(root)).toBeTruthy();
    expect(reviewsBtn(root).getAttribute('aria-label')).toContain('3 reviews need your attention');
  });

  it('shows no badge when nothing needs you', async () => {
    setApi(vi.fn(async () => []));
    mountShell(root, '/vault', 'KB');
    await tick();
    expect(reviewsBtn(root).querySelector('.nav-badge')).toBeNull();
  });

  it('degrades gracefully (no badge, no throw) if listReviews fails', async () => {
    setApi(
      vi.fn(async () => {
        throw new Error('boom');
      }),
    );
    mountShell(root, '/vault', 'KB');
    await tick();
    expect(reviewsBtn(root).querySelector('.nav-badge')).toBeNull();
  });
});
