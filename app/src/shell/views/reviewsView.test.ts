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

function setApi(list: KbApi['listReviews'], answerReview?: KbApi['answerReview'], openCitation?: KbApi['openCitation']): void {
  (window as unknown as { kbApi: Pick<KbApi, 'listReviews' | 'answerReview' | 'openCitation'> }).kbApi = {
    listReviews: list,
    answerReview: answerReview ?? vi.fn(async () => ({ ok: true, message: 'answered' })),
    openCitation: openCitation ?? vi.fn(async () => ({ ok: true as const })),
  };
}

// REVIEW-16: a disambiguation review — two candidates that share the name "Ada", told apart by their
// agent-authored glosses, each with a working source link. The view renders these as rows.
const DISAMBIG_REVIEW: ReviewSummary = {
  id: 'D1',
  question: 'Is "Ada" from the fishing trip the same person as "Ada" from Dave\'s wedding?',
  detail: 'Two sources mention "Ada" in unrelated contexts.',
  stage: 'connect',
  refs: ['Ada'],
  candidates: [
    { name: 'Ada', gloss: 'from the fishing trip', title: 'Fishing trip notes', sourceRel: 'sources/2026/06/01/01ABC/source.md' },
    { name: 'Ada', gloss: "from Dave's wedding", title: "Dave's wedding guest list", sourceRel: 'sources/2026/06/02/01XYZ/source.md' },
  ],
  createdAt: '2026-06-02T12:00:00.000Z',
};

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

  it('WS2 PR3: composes the shared Button + EditableField primitives (DESIGN-SYS §8/§9)', async () => {
    setApi(vi.fn(async () => [CLAIM_REVIEW]));
    await mountReviews(root);
    // Button — Confirm is the emphasized action (.viz-btn--primary); Reject is the neutral .viz-btn.
    const confirm = root.querySelector('.review-confirm');
    expect(confirm?.classList.contains('viz-btn')).toBe(true);
    expect(confirm?.classList.contains('viz-btn--primary')).toBe(true);
    expect(confirm?.classList.contains('primary')).toBe(false); // bespoke chrome dropped → the primitive
    const reject = root.querySelector('.review-reject');
    expect(reject?.classList.contains('viz-btn')).toBe(true);
    // EditableField — the note is a labelled multiline input (a11y: the .viz-field label wraps the control).
    const field = root.querySelector('.review-note-field.viz-field');
    expect(field).not.toBeNull();
    expect(field?.querySelector('.viz-field__label')).not.toBeNull();
    const note = root.querySelector('.review-note');
    expect(note?.classList.contains('viz-field__input')).toBe(true);
    expect(note?.classList.contains('viz-field__input--multiline')).toBe(true);
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

  // --- REVIEW-16: disambiguation candidate rows -------------------------------------------------
  describe('REVIEW-16 candidate rows', () => {
    it('renders one row per candidate, gloss-first, so the Principal can tell them apart', async () => {
      setApi(vi.fn(async () => [DISAMBIG_REVIEW]));
      await mountReviews(root);
      const rows = root.querySelectorAll('.review-candidate');
      expect(rows).toHaveLength(2);
      const glosses = Array.from(root.querySelectorAll('.review-candidate-gloss')).map((g) => g.textContent);
      expect(glosses).toEqual(['from the fishing trip', "from Dave's wedding"]);
      // The shared name is shown as the row label (both are "Ada"); the gloss is what distinguishes.
      expect(Array.from(root.querySelectorAll('.review-candidate-name')).map((n) => n.textContent)).toEqual(['Ada', 'Ada']);
    });

    it('"Open in Obsidian" opens that candidate\'s source via openCitation (reuses the EXPLORE-4 IPC)', async () => {
      const openCitation = vi.fn(async () => ({ ok: true as const }));
      setApi(vi.fn(async () => [DISAMBIG_REVIEW]), undefined, openCitation);
      await mountReviews(root);
      const links = root.querySelectorAll<HTMLButtonElement>('.review-candidate-open');
      expect(links).toHaveLength(2);
      links[1].click(); // open the second candidate's source
      expect(openCitation).toHaveBeenCalledWith('sources/2026/06/02/01XYZ/source.md'); // the FILE, not the dir
    });

    it('omits the link for a candidate with no known sourceRel (renders gloss only)', async () => {
      const review: ReviewSummary = {
        ...DISAMBIG_REVIEW,
        candidates: [
          { name: 'Ada', gloss: 'from the fishing trip', title: 'Fishing trip notes', sourceRel: 'sources/2026/06/01/01ABC/source.md' },
          { name: 'Ada', gloss: 'mentioned only in passing', title: 'Ada' }, // no sourceRel (title falls back to name)
        ],
      };
      setApi(vi.fn(async () => [review]));
      await mountReviews(root);
      expect(root.querySelectorAll('.review-candidate')).toHaveLength(2);
      expect(root.querySelectorAll('.review-candidate-open')).toHaveLength(1); // only the one with a source
    });

    it('esc()s the agent-authored gloss/name — untrusted LLM text never reaches an HTML sink (XSS)', async () => {
      const xss = '<img src=x onerror="window.__pwned=1">';
      const review: ReviewSummary = {
        ...DISAMBIG_REVIEW,
        candidates: [{ name: xss, gloss: xss, title: xss, sourceRel: '"><script>window.__pwned=1</script>' }],
      };
      setApi(vi.fn(async () => [review]));
      await mountReviews(root);
      // The payload renders as inert text, not DOM: no injected <img>/<script>, and the row is intact.
      expect(root.querySelector('.review-candidate-gloss')?.textContent).toBe(xss);
      expect(root.querySelector('.review-candidate-gloss img')).toBeNull();
      expect(root.querySelector('.review-candidate script')).toBeNull();
      expect((window as unknown as { __pwned?: number }).__pwned).toBeUndefined();
      // The malicious sourceRel survives only as an inert data attribute, round-tripped verbatim.
      expect(root.querySelector<HTMLButtonElement>('.review-candidate-open')?.dataset.rel).toBe('"><script>window.__pwned=1</script>');
    });

    it('an ordinary review (no candidates) renders no candidate block — unchanged behaviour', async () => {
      setApi(vi.fn(async () => [CLAIM_REVIEW]));
      await mountReviews(root);
      expect(root.querySelector('.review-candidates')).toBeNull();
    });
  });
});
