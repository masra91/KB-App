// Reviews view — the "needs you" queue (SPEC-0018 REVIEW-10). Lists open reviews; each is a
// single yes/no question with expandable context, a Confirm / Reject pair, and an optional
// note (a correction or extra context that becomes a primary source — REVIEW-7). Thin DOM
// over the typed IPC (REVIEW-11); the main process owns the store.
//
// #110: the view is mounted ONCE and shown by un-hiding it (shell mount-once, SHELL-8), while the
// rail badge live-polls `listReviews()` every 5s. So a review raised AFTER the view first mounted
// (e.g. a CONNECT-15 ambiguous-link review) made the badge tick to "1" while this list stayed frozen
// on its initial "Nothing needs you" — count vs list disagreed and a real review couldn't be acted
// on. Fix: a visibility-aware refresh poll, same cadence as the badge, so the list always reflects
// the same `listReviews()` the badge counts. It re-renders only when the open-review *set* changes
// and never while a note is being written (so it can't clobber in-progress input).
import { esc } from '../html';
import type { ReviewSummary } from '../../kb/types';

/** Poll cadence — matches the rail badge (shell.ts) so the list and the count never drift. */
const REVIEW_POLL_MS = 5000;

// View-local state (the shell mounts this view once; reset on each mount for test isolation).
let pollTimer: ReturnType<typeof setInterval> | undefined;
let renderedSig = ''; // the open-review id set currently painted — re-render only when it changes

export async function mountReviews(container: HTMLElement): Promise<void> {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = undefined;
  renderedSig = '';
  container.innerHTML = `<div class="card"><h1>🔍 Reviews</h1><p class="muted">Loading…</p></div>`;
  await refresh(container);
  startPoll(container);
}

/** Keep the list in sync with the live badge: re-fetch while visible; skip when hidden or mid-note. */
function startPoll(container: HTMLElement): void {
  pollTimer = setInterval(() => {
    if (!document.contains(container)) {
      // The shell tore the view out — stop polling.
      if (pollTimer) clearInterval(pollTimer);
      pollTimer = undefined;
      return;
    }
    // Not visible (another view is shown, or the window is backgrounded) → nobody's looking.
    if (document.hidden || container.classList.contains('hidden')) return;
    // Don't yank the list out from under someone composing a correction note.
    if (hasDirtyNote(container)) return;
    void refresh(container, { onlyIfChanged: true });
  }, REVIEW_POLL_MS);
}

/** A note the Principal is actively writing (focused or non-empty) — re-rendering would lose it. */
function hasDirtyNote(container: HTMLElement): boolean {
  for (const ta of Array.from(container.querySelectorAll<HTMLTextAreaElement>('.review-note'))) {
    if (ta === document.activeElement || ta.value.trim().length > 0) return true;
  }
  return false;
}

/**
 * Fetch the open reviews and paint them. With `onlyIfChanged` (the poll path) it repaints only when
 * the set of open review ids differs from what's shown — so an unchanged poll is a no-op (no flicker,
 * no lost focus) — and a transient IPC error leaves the current list in place. The initial/forced
 * path surfaces a load error.
 */
async function refresh(container: HTMLElement, opts: { onlyIfChanged?: boolean } = {}): Promise<void> {
  let reviews: ReviewSummary[];
  try {
    reviews = await window.kbApi.listReviews();
  } catch {
    if (!opts.onlyIfChanged) {
      container.innerHTML = `<div class="card"><h1>🔍 Reviews</h1><p class="error">Could not load reviews right now.</p></div>`;
    }
    return; // poll error → keep the last good list
  }
  const sig = reviews.map((r) => r.id).join(',');
  if (opts.onlyIfChanged && sig === renderedSig) return;
  renderedSig = sig;
  paint(container, reviews);
}

/** Render the review list (or the empty state) and wire the per-item Confirm/Reject buttons. */
function paint(container: HTMLElement, reviews: ReviewSummary[]): void {
  const header = `<h1>🔍 Reviews</h1>`;
  if (reviews.length === 0) {
    container.innerHTML = `<div class="card">${header}<p class="muted">Nothing needs you right now. 🎉</p></div>`;
    return;
  }

  const items = reviews
    .map(
      (r) => `
      <li class="review" data-id="${esc(r.id)}">
        <div class="review-q">${esc(r.question)}</div>
        <details class="review-detail">
          <summary>Why this matters</summary>
          <p>${esc(r.detail)}</p>
          ${r.refs.length ? `<p class="muted">About: ${r.refs.map(esc).join(', ')}</p>` : ''}
          <p class="muted">Raised by: ${esc(r.stage)}</p>
        </details>
        <textarea class="review-note" rows="2" placeholder="Optional note (e.g. a correction) — saved as a source"></textarea>
        <div class="review-actions">
          <button type="button" class="primary review-confirm" data-id="${esc(r.id)}">Confirm</button>
          <button type="button" class="review-reject" data-id="${esc(r.id)}">Reject</button>
        </div>
      </li>`,
    )
    .join('');

  container.innerHTML = `
    <div class="card">
      ${header}
      <p class="muted">${reviews.length} question${reviews.length === 1 ? '' : 's'} for you. Each is a quick yes/no.</p>
      <ul class="review-list">${items}</ul>
    </div>`;

  for (const btn of Array.from(container.querySelectorAll<HTMLButtonElement>('.review-confirm, .review-reject'))) {
    btn.addEventListener('click', () => {
      const verdict = btn.classList.contains('review-confirm') ? 'confirm' : 'reject';
      void answer(container, btn.dataset.id!, verdict);
    });
  }
}

async function answer(container: HTMLElement, id: string, verdict: 'confirm' | 'reject'): Promise<void> {
  const li = container.querySelector<HTMLElement>(`.review[data-id="${cssEscape(id)}"]`);
  const note = li?.querySelector<HTMLTextAreaElement>('.review-note')?.value ?? '';
  // Disable the item's buttons while the answer is in flight (avoid a double-submit).
  for (const b of Array.from(li?.querySelectorAll('button') ?? [])) (b as HTMLButtonElement).disabled = true;
  try {
    const res = await window.kbApi.answerReview({ id, verdict, note: note.trim() || undefined });
    if (!res.ok) {
      for (const b of Array.from(li?.querySelectorAll('button') ?? [])) (b as HTMLButtonElement).disabled = false;
      return;
    }
  } catch {
    for (const b of Array.from(li?.querySelectorAll('button') ?? [])) (b as HTMLButtonElement).disabled = false;
    return;
  }
  // Answered → the item leaves the queue; force a re-render (its id drops from the set).
  await refresh(container);
}

/** Minimal CSS.escape fallback (review ids are ULIDs, so this is belt-and-suspenders). */
function cssEscape(s: string): string {
  return s.replace(/["\\]/g, '\\$&');
}
