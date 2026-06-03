// @vitest-environment happy-dom
//
// SPEC-0018 Reviews view + #110 (badge/list reconciliation). Component tier (happy-dom). The IPC is
// mocked (`window.kbApi.listReviews` / `answerReview`); we assert the rendered DOM and that the list
// stays in sync with the live rail badge (both read `listReviews()`), including the CONNECT-15
// ambiguous-link review type (empty subject → empty `refs`).
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mountReviews } from './reviewsView';
import { LOAD_TIMEOUT_MS } from '../loadGuard';
import type { KbApi, ReviewSummary } from '../../kb/types';

const POLL_MS = 5000; // keep in sync with REVIEW_POLL_MS in reviewsView.ts

const CLAIM_REVIEW: ReviewSummary = {
  id: 'R1',
  question: 'Is "Ada" the mathematician Ada Lovelace?',
  detail: 'Two sources mention "Ada" with different roles.',
  stage: 'claims',
  refs: ['Ada'],
  createdAt: '2026-06-02T10:00:00.000Z',
};
// A CONNECT-15 ambiguous-link review: NO entity subject → empty refs, raised by `connect`.
const LINK_REVIEW: ReviewSummary = {
  id: 'L1',
  question: 'Should "Ada Lovelace" link to "Analytical Engine"?',
  detail: '"Ada Lovelace" relates to "engine", which matches multiple entities: Analytical Engine, Difference Engine.',
  stage: 'connect',
  refs: [],
  createdAt: '2026-06-02T11:00:00.000Z',
};

function setApi(list: KbApi['listReviews'], answerReview?: KbApi['answerReview']): void {
  (window as unknown as { kbApi: Pick<KbApi, 'listReviews' | 'answerReview'> }).kbApi = {
    listReviews: list,
    answerReview: answerReview ?? vi.fn(async () => ({ ok: true, message: 'answered' })),
  };
}

describe('Reviews view (SPEC-0018) + #110 list/badge reconciliation', () => {
  let root: HTMLElement;
  beforeEach(() => {
    vi.useFakeTimers();
    document.body.innerHTML = '<div id="host"></div>';
    root = document.createElement('div');
    document.getElementById('host')!.appendChild(root);
  });
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('renders open reviews with Confirm/Reject (REVIEW-10)', async () => {
    setApi(vi.fn(async () => [CLAIM_REVIEW]));
    await mountReviews(root);
    expect(root.querySelector('.review-q')?.textContent).toContain('Ada Lovelace');
    expect(root.querySelector('.review-confirm')).toBeTruthy();
    expect(root.querySelector('.review-reject')).toBeTruthy();
    expect(root.textContent).toContain('About: Ada');
  });

  it('#145: a hung listReviews times out → retryable error (no infinite spinner), and Retry re-loads', async () => {
    const list = vi.fn<KbApi['listReviews']>().mockReturnValue(new Promise<ReviewSummary[]>(() => {})); // hangs
    setApi(list);
    const mounted = mountReviews(root);
    expect(root.textContent).toContain('Loading…'); // spinner initially

    await vi.advanceTimersByTimeAsync(LOAD_TIMEOUT_MS); // trip the timeout
    await mounted;
    expect(root.textContent).not.toContain('Loading…'); // no infinite spinner
    expect(root.querySelector('.load-error')).toBeTruthy();
    expect(root.querySelector('.load-retry')).toBeTruthy();

    // Retry succeeds → the list renders.
    list.mockResolvedValue([CLAIM_REVIEW]);
    root.querySelector<HTMLButtonElement>('.load-retry')!.click();
    await vi.advanceTimersByTimeAsync(0);
    expect(root.querySelector('.review-q')?.textContent).toContain('Ada Lovelace');
  });

  it('renders a CONNECT-15 ambiguous-LINK review (empty subject) — confirm/reject, no "About" line (#110)', async () => {
    setApi(vi.fn(async () => [LINK_REVIEW]));
    await mountReviews(root);
    expect(root.querySelector('.review-q')?.textContent).toContain('Analytical Engine');
    expect(root.textContent).toContain('matches multiple entities'); // detail rendered verbatim
    expect(root.querySelector('.review-confirm')).toBeTruthy();
    expect(root.querySelector('.review-reject')).toBeTruthy();
    expect(root.textContent).toContain('Raised by: connect');
    expect(root.textContent).not.toContain('About:'); // empty refs → no subject line, not a crash
  });

  it('list catches up to the badge: a review raised after mount appears on the next poll (#110)', async () => {
    const list = vi
      .fn<KbApi['listReviews']>()
      .mockResolvedValueOnce([]) // mounted while the queue was empty
      .mockResolvedValue([LINK_REVIEW]); // then a link review is raised
    setApi(list);
    await mountReviews(root);
    expect(root.textContent).toContain('Nothing needs you'); // initial empty state (the frozen bug)

    await vi.advanceTimersByTimeAsync(POLL_MS); // the visibility-aware poll fires
    expect(root.textContent).not.toContain('Nothing needs you');
    expect(root.querySelector('.review-q')?.textContent).toContain('Analytical Engine');
  });

  it('does not repoll-repaint when the open set is unchanged (no flicker)', async () => {
    setApi(vi.fn(async () => [CLAIM_REVIEW]));
    await mountReviews(root);
    const firstList = root.querySelector('.review-list');
    await vi.advanceTimersByTimeAsync(POLL_MS);
    expect(root.querySelector('.review-list')).toBe(firstList); // same node — not re-innerHTML'd
  });

  it('skips the poll while the view is hidden (another view is shown)', async () => {
    const list = vi.fn<KbApi['listReviews']>().mockResolvedValueOnce([]).mockResolvedValue([LINK_REVIEW]);
    setApi(list);
    await mountReviews(root);
    root.classList.add('hidden'); // shell un-shows this view
    await vi.advanceTimersByTimeAsync(POLL_MS);
    expect(list).toHaveBeenCalledTimes(1); // no fetch while hidden
    expect(root.textContent).toContain('Nothing needs you');
  });

  it('never clobbers a note being written: defers the repaint while a note is dirty', async () => {
    const list = vi.fn<KbApi['listReviews']>().mockResolvedValueOnce([CLAIM_REVIEW]).mockResolvedValue([CLAIM_REVIEW, LINK_REVIEW]);
    setApi(list);
    await mountReviews(root);
    const note = root.querySelector<HTMLTextAreaElement>('.review-note')!;
    note.value = 'half-written correction'; // dirty
    await vi.advanceTimersByTimeAsync(POLL_MS);
    expect(note.value).toBe('half-written correction'); // preserved
    expect(root.querySelectorAll('.review')).toHaveLength(1); // repaint deferred — note intact

    note.value = ''; // note cleared → next poll is free to refresh
    await vi.advanceTimersByTimeAsync(POLL_MS);
    expect(root.querySelectorAll('.review')).toHaveLength(2);
  });

  it('answering removes the item from the queue', async () => {
    const list = vi.fn<KbApi['listReviews']>().mockResolvedValueOnce([CLAIM_REVIEW]).mockResolvedValue([]);
    const answerReview = vi.fn(async () => ({ ok: true, message: 'answered' }));
    setApi(list, answerReview);
    await mountReviews(root);
    root.querySelector<HTMLButtonElement>('.review-confirm')!.click();
    await vi.advanceTimersByTimeAsync(0); // flush the answer + forced refresh
    expect(answerReview).toHaveBeenCalledWith({ id: 'R1', verdict: 'confirm', note: undefined });
    expect(root.textContent).toContain('Nothing needs you');
  });

  it('stops polling once the view is detached from the document', async () => {
    const list = vi.fn(async () => [CLAIM_REVIEW]);
    setApi(list);
    await mountReviews(root);
    const callsAfterMount = list.mock.calls.length;
    root.remove(); // shell tears the view out
    await vi.advanceTimersByTimeAsync(POLL_MS * 2);
    expect(list.mock.calls.length).toBe(callsAfterMount); // no further polling
  });
});
