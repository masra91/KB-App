// Reviews view — the "needs you" queue (SPEC-0018 REVIEW-10). Lists open reviews; each is a
// single yes/no question with expandable context, a Confirm / Reject pair, and an optional
// note (a correction or extra context that becomes a primary source — REVIEW-7). Thin DOM
// over the typed IPC (REVIEW-11); the main process owns the store.
import { esc } from '../html';
import type { ReviewSummary } from '../../kb/types';

export async function mountReviews(container: HTMLElement): Promise<void> {
  container.innerHTML = `<div class="card"><h1>🔍 Reviews</h1><p class="muted">Loading…</p></div>`;
  await render(container);
}

async function render(container: HTMLElement): Promise<void> {
  let reviews: ReviewSummary[];
  try {
    reviews = await window.kbApi.listReviews();
  } catch {
    container.innerHTML = `<div class="card"><h1>🔍 Reviews</h1><p class="error">Could not load reviews right now.</p></div>`;
    return;
  }

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
  // Answered → the item leaves the queue; re-render the list.
  await render(container);
}

/** Minimal CSS.escape fallback (review ids are ULIDs, so this is belt-and-suspenders). */
function cssEscape(s: string): string {
  return s.replace(/["\\]/g, '\\$&');
}
