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
import { withTimeout, renderLoadError } from '../loadGuard';
import type { ReviewSummary } from '../../kb/types';
import type { ReviewSubjectCandidate } from '../../kb/reviews';

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
    // #145: bound the wait so a hung `listReviews` can't leave an infinite spinner; a hang then
    // surfaces as a normal rejection this catch handles.
    reviews = await withTimeout(window.kbApi.listReviews());
  } catch {
    if (!opts.onlyIfChanged) {
      // Initial/forced load failed → a retryable error (the poll keeps trying too).
      renderLoadError(container, '<h1>🔍 Reviews</h1>', () => void refresh(container));
    }
    return; // poll error → keep the last good list
  }
  // ENG-16: the change-signature must tolerate a malformed item too (a null/odd entry can't be
  // allowed to throw here and abort the whole render before `paint` ever runs).
  const sig = (Array.isArray(reviews) ? reviews : []).map((r) => r?.id ?? '∅').join(',');
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

  // ENG-16 per-item failure isolation: one malformed review degrades its OWN row, never the whole
  // list. A field with an unexpected shape (e.g. `refs` not an array, a candidate row that throws)
  // must not take down every other review + leave the surface stuck on "Loading…" (REVIEW-19).
  const items = reviews
    .map((r) => {
      try {
        return reviewItemHtml(r);
      } catch (err) {
        console.warn('reviews: a review item failed to render — showing a fallback row', err);
        return reviewItemFallback(r);
      }
    })
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

  // REVIEW-16: each candidate row's "Open in Obsidian" opens its source dir in Obsidian. Reuses the
  // ASK-14/EXPLORE-4 `openCitation` IPC (repo-relative path → obsidian:// deep link in the main
  // process) — the renderer never builds a URL itself, so the agent-authored `sourceRel` can't reach
  // a markup/href sink. `data-rel` was esc()'d at render; we read it back as a plain string.
  for (const btn of Array.from(container.querySelectorAll<HTMLButtonElement>('.review-candidate-open'))) {
    btn.addEventListener('click', () => {
      const rel = btn.dataset.rel;
      if (rel) void window.kbApi.openCitation(rel);
    });
  }
}

/** The full markup for one review item. Extracted so the list `.map` can isolate a per-item render
 *  failure (ENG-16) — a throw here drops to `reviewItemFallback`, never the whole list. */
function reviewItemHtml(r: ReviewSummary): string {
  const refs = Array.isArray(r.refs) ? r.refs : []; // legacy/malformed: refs may be absent/non-array
  return `
      <li class="review" data-id="${esc(r.id)}">
        <div class="review-q">${esc(r.question)}</div>
        ${candidatesBlock(r)}
        <details class="review-detail">
          <summary>Why this matters</summary>
          <p>${esc(r.detail)}</p>
          ${refs.length ? `<p class="muted">About: ${refs.map(esc).join(', ')}</p>` : ''}
          <p class="muted">Raised by: ${esc(r.stage)}</p>
        </details>
        <label class="viz-field review-note-field">
          <span class="viz-field__label viz-signage">Note (optional)</span>
          <textarea class="review-note viz-field__input viz-field__input--multiline" rows="2" placeholder="Optional note (e.g. a correction) — saved as a source"></textarea>
        </label>
        <div class="review-actions">
          <button type="button" class="viz-btn viz-btn--primary review-confirm" data-id="${esc(r.id)}">Confirm</button>
          <button type="button" class="viz-btn review-reject" data-id="${esc(r.id)}">Reject</button>
        </div>
      </li>`;
}

/** A minimal, still-actionable fallback row when a review item can't be fully rendered (ENG-16). The
 *  Confirm/Reject pair stays wired (keyed by id) so the Principal can still clear the item; the rest
 *  of the list is unaffected. Every field is esc()'d (null-safe) so the fallback itself can't throw. */
function reviewItemFallback(r: ReviewSummary): string {
  const id = esc(r?.id);
  const actions = id
    ? `<div class="review-actions">
          <button type="button" class="viz-btn viz-btn--primary review-confirm" data-id="${id}">Confirm</button>
          <button type="button" class="viz-btn review-reject" data-id="${id}">Reject</button>
        </div>`
    : '';
  return `
      <li class="review" data-id="${id}">
        <div class="review-q">${esc(r?.question) || 'This review couldn’t be fully displayed.'}</div>
        <p class="muted">Some details for this item are unavailable.</p>
        ${actions}
      </li>`;
}

/**
 * REVIEW-16 — the disambiguation candidate rows. A "same entity?" review's candidates usually share
 * a name, so the distinguishing **gloss** ("from the fishing trip" vs "Dave's wedding") is the star;
 * each row also offers a working Obsidian link whose TEXT is the source's human title (PRIN-24 — never
 * the raw ULID), opening that candidate's `source.md` when known. This enriches the decision *context*
 * only — the Confirm/Reject verdict (REVIEW-2) is unchanged.
 *
 * Returns '' for an ordinary review (no candidates) so nothing renders. Name/gloss/title/sourceRel are
 * source-/agent-derived (untrusted) → every interpolation is esc()'d, including the `data-rel` the
 * click handler reads back (KB-QD-2's forward-flagged XSS).
 *
 * REVIEW-19 / ENG-15/16: the data is partial in the LIVE queue — candidates raised before
 * title-persistence (#295/#305) carry `title: null` (55 such candidates / 9 open reviews observed,
 * incl. "Jordan"). So the link text falls back title → name → a generic "Open" (NEVER `esc(undefined)`,
 * NEVER a raw ULID), and each candidate row is isolated: one malformed candidate degrades its OWN row.
 */
function candidatesBlock(r: ReviewSummary): string {
  if (!r.candidates?.length) return '';
  const rows = r.candidates
    .map((c) => {
      try {
        return candidateRowHtml(c);
      } catch (err) {
        console.warn('reviews: a candidate row failed to render — showing a fallback', err);
        return `<li class="review-candidate viz-spine"><span class="review-candidate-gloss viz-body muted">This candidate couldn’t be displayed.</span></li>`;
      }
    })
    .join('');
  return `<ul class="review-candidates" aria-label="Candidates to tell apart">${rows}</ul>`;
}

/** One candidate row. The Obsidian link TEXT is the source title with a robust fallback chain so a
 *  legacy `title: null` candidate still renders a real, working link (REVIEW-19 / PRIN-24). */
function candidateRowHtml(c: ReviewSubjectCandidate): string {
  // title → name → (neither) a generic label. NEVER the raw ULID/sourceRel basename (PRIN-24), and
  // NEVER `esc(undefined)`. `name` is the legacy fall-through (e.g. "Jordan") when title is absent.
  const label = firstNonEmpty(c.title, c.name);
  const linkText = label ? `${esc(label)} ↗` : 'Open in Obsidian ↗';
  const link = c.sourceRel
    ? `<button type="button" class="review-candidate-open viz-btn viz-btn--ghost viz-focusable" data-rel="${esc(c.sourceRel)}" title="Open in Obsidian">${linkText}</button>`
    : '';
  return `
        <li class="review-candidate viz-spine">
          <span class="review-candidate-name viz-signage">${esc(c.name)}</span>
          <span class="review-candidate-gloss viz-body">${esc(c.gloss)}</span>
          ${link}
        </li>`;
}

/** First value that is a non-empty string (trims) — for null-safe display fallbacks. */
function firstNonEmpty(...vals: Array<string | null | undefined>): string | undefined {
  for (const v of vals) if (typeof v === 'string' && v.trim().length > 0) return v;
  return undefined;
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
