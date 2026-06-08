// Ask view (SPEC-0026 ASK-1/2/8) — the "out" surface. A chat-like panel: the Principal types a
// question, the main process runs grounded recall (kb:ask → recall engine on the Copilot SDK), and
// the answer renders with its citations. Pull-only (ASK-2): a recall runs ONLY on the Principal's
// submit, never automatically. Multi-turn (ASK-8): prior Q/A in this view are passed as history;
// state is view-local + ephemeral (F5), surviving shell view-switches but not relaunch.
//
// Thin DOM over the typed IPC, matching the other views. Markdown/citation rich-rendering (F6) is
// KB-Lead's slice-3 call — slice 2 renders the answer text + an evidence list.
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import { esc } from '../html';
import type { AskResult, Citation, RecallTurn } from '../../kb/types';

/**
 * Render the recall answer's markdown to **sanitized** HTML (#93 — the panel previously showed raw
 * `**markdown**`). The answer is LLM/ingested content, so this ALWAYS sanitizes: `marked` turns the
 * markdown (incl. any embedded raw HTML) into HTML, then DOMPurify strips anything unsafe (scripts,
 * event handlers, `javascript:` URLs) before it ever reaches the DOM. Never render model output as
 * HTML un-sanitized (E1). Synchronous (`async:false`) so it slots into the string-built transcript.
 */
function renderMarkdown(md: string): string {
  return DOMPurify.sanitize(marked.parse(md, { async: false }) as string);
}

/**
 * Make inline `[n]` citation markers clickable (ASK-14, Ask-panel surface). Runs BEFORE markdown
 * parsing: each `[n]` becomes a class-tagged anchor carrying the 1-based index in `data-cite` — the
 * delegated handler maps it to `citations[n-1]` (DEV-3's contract: markers are dense + gap-free,
 * 1:1 with `citations[]`). The anchor has NO `href`: the `obsidian://` deep-link is built and opened
 * in the main process (`shell.openExternal`), so the `obsidian:` scheme never enters the DOM and
 * DOMPurify's default URL allowlist stays untouched (ASK-15/#93). `n` is a bare integer from the
 * regex, so nothing untrusted reaches the attribute; wrapping it also stops markdown from
 * reinterpreting a bare `[1]` as a link-reference. Pure + exported for unit testing.
 *
 * A11y (DESIGN-LEGACY-VIEWS §5/§7): the marker is an href-less anchor that navigates (opens the
 * source in Obsidian), so it carries `role="link"` + keyboard activation (Enter/Space, via the
 * delegated keydown handler) + an `aria-label` naming the source — its only visible text is the bare
 * `[n]`, which is meaningless to a screen reader on its own. The label is built from the matching
 * citation when present (`Citation n: <source name>`), else falls back to `Citation n`.
 */
export function linkifyCitationMarkers(answer: string, turnIndex: number, citations: Citation[] = []): string {
  return answer.replace(/\[(\d+)\]/g, (_m, n: string) => {
    const c = citations[Number(n) - 1];
    const label = c ? `Citation ${n}: ${refDisplayName(c)}` : `Citation ${n}`;
    return `<a class="cite-link" role="link" tabindex="0" aria-label="${esc(label)}" data-turn="${turnIndex}" data-cite="${n}">[${n}]</a>`;
  });
}

interface Turn {
  question: string;
  result: AskResult | null; // null while in flight
  error?: string;
  savedRel?: string; // set once saved as an Output (ASK-6) — its repo path
  saveError?: string; // a failed save, surfaced inline
  citeError?: string; // a failed citation deep-link (ASK-14), surfaced inline
}

// View-local, ephemeral session state (F5). The shell mounts once + toggles visibility.
let turns: Turn[] = [];
let busy = false;

export function mountAsk(container: HTMLElement): void {
  turns = [];
  busy = false;
  container.innerHTML = `
    <div class="card ask-view">
      <h1>💬 Ask</h1>
      <p class="muted">Ask your knowledge base a question. Answers are grounded in your sources, entities, and claims — with citations.</p>
      <ul class="ask-transcript" id="askTranscript"></ul>
      <form class="ask-form" id="askForm">
        <input id="askInput" class="ask-input" type="text" autocomplete="off" placeholder="Ask a question…" aria-label="Ask a question" />
        <button id="askBtn" class="viz-btn viz-btn--primary viz-focusable" type="submit">Ask</button>
      </form>
    </div>`;
  const form = container.querySelector<HTMLFormElement>('#askForm');
  form?.addEventListener('submit', (e) => {
    e.preventDefault();
    void onAsk(container);
  });
  // ASK-6/14: delegated handlers — the transcript <ul> persists across re-renders, so one listener
  // each handles every turn's "Save as report" button (ASK-6) and every citation deep-link (ASK-14),
  // keyed by data-turn / data-cite indices.
  const transcript = container.querySelector<HTMLElement>('#askTranscript');
  transcript?.addEventListener('click', (e) => {
    const target = e.target as HTMLElement;
    const btn = target.closest<HTMLElement>('.ask-save');
    if (btn) {
      void saveTurn(container, Number(btn.dataset.turn));
      return;
    }
    const cite = target.closest<HTMLElement>('.cite-link, .cite-ref');
    if (cite) {
      e.preventDefault();
      void openCitation(container, Number(cite.dataset.turn), Number(cite.dataset.cite));
    }
  });
  // Keyboard parity (ASK-14 / §7): citation anchors are href-less role=link/tabindex=0 — open on Enter/Space.
  transcript?.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const cite = (e.target as HTMLElement).closest<HTMLElement>('.cite-link, .cite-ref');
    if (!cite) return;
    e.preventDefault();
    void openCitation(container, Number(cite.dataset.turn), Number(cite.dataset.cite));
  });
  renderTranscript(container);
}

const CITE_ERRORS: Record<string, string> = {
  'no-vault': 'No active knowledge base.',
  'invalid-ref': 'That citation could not be opened.',
  'open-failed': 'Could not open Obsidian — is it installed?',
};

/**
 * Open a citation's canonical target in Obsidian (ASK-14). Maps the clicked marker's 1-based index to
 * `citations[n-1]` (dense/gap-free per DEV-3) and hands its vault-relative `ref` to main, which
 * resolves + contains it and opens the `obsidian://` deep-link. Failures surface inline (never throw).
 */
async function openCitation(container: HTMLElement, turnIndex: number, citeIndex: number): Promise<void> {
  const t = turns[turnIndex];
  const c = t?.result?.citations[citeIndex - 1];
  if (!t || !c) return;
  t.citeError = undefined;
  try {
    const res = await window.kbApi.openCitation(c.ref);
    if (!res.ok) t.citeError = CITE_ERRORS[res.reason ?? ''] ?? 'That citation could not be opened.';
  } catch (err) {
    t.citeError = err instanceof Error ? err.message : String(err);
  }
  if (t.citeError) renderTranscript(container);
}

/** Save a completed turn's answer as a KB Output (ASK-6) — once; updates the turn + re-renders. */
async function saveTurn(container: HTMLElement, index: number): Promise<void> {
  const t = turns[index];
  if (!t || !t.result || t.savedRel) return;
  t.saveError = undefined;
  const btn = container.querySelector<HTMLButtonElement>(`.ask-save[data-turn="${index}"]`);
  if (btn) {
    btn.disabled = true;
    btn.textContent = 'Saving…';
  }
  try {
    const res = await window.kbApi.saveRecallOutput(t.result);
    if (res.ok && res.rel) t.savedRel = res.rel;
    else t.saveError = res.message;
  } catch (err) {
    t.saveError = err instanceof Error ? err.message : String(err);
  }
  renderTranscript(container);
}

async function onAsk(container: HTMLElement): Promise<void> {
  if (busy) return;
  const input = container.querySelector<HTMLInputElement>('#askInput');
  const question = (input?.value ?? '').trim();
  if (!question) return;

  // History = the Q/A of prior completed turns (ASK-8), gathered before this turn is added.
  const history: RecallTurn[] = turns
    .filter((t) => t.result !== null)
    .map((t) => ({ question: t.question, answer: t.result!.answer }));

  const turn: Turn = { question, result: null };
  turns.push(turn);
  if (input) input.value = '';
  busy = true;
  setBusy(container, true);
  renderTranscript(container);

  try {
    turn.result = await window.kbApi.ask({ question, history });
  } catch (err) {
    turn.error = err instanceof Error ? err.message : String(err);
  } finally {
    busy = false;
    setBusy(container, false);
    renderTranscript(container);
    container.querySelector<HTMLInputElement>('#askInput')?.focus();
  }
}

function setBusy(container: HTMLElement, on: boolean): void {
  const btn = container.querySelector<HTMLButtonElement>('#askBtn');
  const input = container.querySelector<HTMLInputElement>('#askInput');
  if (btn) {
    btn.disabled = on;
    btn.textContent = on ? 'Asking…' : 'Ask';
  }
  if (input) input.disabled = on;
}

/** Human-facing kind label for a citation (dogfood #2 — capitalized, not the raw lowercase id). */
const CITATION_KIND_LABEL: Record<string, string> = { entity: 'Entity', claim: 'Claim', source: 'Source' };

/** The display name for a reference (dogfood #2): the human label/title, else the note basename — never
 *  the full vault path (which is dev-facing). The canonical `ref` is untouched: it still drives the
 *  deep-link via `data-cite` (index → `citations[n-1].ref` in the handler) + rides along in the tooltip. */
function refDisplayName(c: Citation): string {
  if (c.label && c.label.trim().length > 0) return c.label.trim();
  const base = c.ref.replace(/\/+$/, '').split('/').pop() ?? c.ref;
  return base.replace(/\.md$/i, '');
}

/** The References list (ASK-13/14) — one entry per citation, numbered to match the inline `[n]`
 *  markers (DEV-3's dense/gap-free contract). Each is a deep-link into Obsidian (data-cite index;
 *  the handler opens it via main), mirroring the inline markers from the same canonical target.
 *  Display (dogfood #2): lead with the human name + capitalized kind; the raw vault path is demoted
 *  to the hover tooltip, not shown inline. */
function renderReferences(citations: Citation[], turnIndex: number): string {
  if (citations.length === 0) return '';
  const items = citations
    .map((c, i) => {
      const n = i + 1;
      const kind = CITATION_KIND_LABEL[c.kind] ?? c.kind;
      return `<li><a class="cite-ref" role="link" tabindex="0" data-turn="${turnIndex}" data-cite="${n}" title="${esc(c.ref)} — open in Obsidian"><span class="cite-num">[${n}]</span> <span class="cite-kind">${esc(kind)}</span> ${esc(refDisplayName(c))}</a></li>`;
    })
    .join('');
  return `<div class="ask-citations"><span class="muted">References</span><ul>${items}</ul></div>`;
}

function renderAnswer(r: AskResult, turnIndex: number, citeError?: string): string {
  const flags: string[] = [];
  if (!r.grounded) flags.push('⚠ not grounded in the KB');
  if (r.truncated) flags.push('partial — retrieval budget reached');
  const flagHtml = flags.length ? `<div class="ask-flags muted">${flags.map(esc).join(' · ')}</div>` : '';
  // ASK-14: linkify the inline `[n]` BEFORE sanitizing, so each marker is a clickable deep-link.
  // Pass citations so each marker gets an aria-label naming its source (§5 a11y).
  const answerHtml = renderMarkdown(linkifyCitationMarkers(r.answer, turnIndex, r.citations));
  const citeErr = citeError ? `<div class="ask-cite-status error">${esc(citeError)}</div>` : '';
  return `<div class="ask-answer">${answerHtml}</div>${renderReferences(r.citations, turnIndex)}${citeErr}${flagHtml}`;
}

/** The save-as-Output affordance for a completed turn (ASK-6): a button, or the saved confirmation. */
function renderSaveRow(t: Turn, index: number): string {
  if (t.savedRel) {
    return `<div class="ask-save-row muted">✓ Saved as Output — <code>${esc(t.savedRel)}</code></div>`;
  }
  const err = t.saveError ? `<span class="ask-save-status error"> ${esc(t.saveError)}</span>` : '';
  return `<div class="ask-save-row"><button type="button" class="ask-save" data-turn="${index}">Save as report</button>${err}</div>`;
}

function renderTurn(t: Turn, index: number): string {
  let body: string;
  let saveRow = '';
  if (t.error) body = `<div class="ask-answer error">Sorry — recall failed: ${esc(t.error)}</div>`;
  else if (t.result === null) body = `<div class="ask-answer muted">Thinking…</div>`;
  else {
    body = renderAnswer(t.result, index, t.citeError);
    saveRow = renderSaveRow(t, index); // grounded OR ungrounded — saving an ungrounded answer is allowed (F4)
  }
  return `<li class="ask-turn"><div class="ask-q"><span class="muted">You</span> ${esc(t.question)}</div><div class="ask-a">${body}${saveRow}</div></li>`;
}

function renderTranscript(container: HTMLElement): void {
  const el = container.querySelector<HTMLElement>('#askTranscript');
  if (!el) return;
  el.innerHTML = turns.map((t, i) => renderTurn(t, i)).join('');
}
