// Ask view (SPEC-0026 ASK-1/2/8) — the "out" surface. A chat-like panel: the Principal types a
// question, the main process runs grounded recall (kb:ask → recall engine on the Copilot SDK), and
// the answer renders with its citations. Pull-only (ASK-2): a recall runs ONLY on the Principal's
// submit, never automatically. Multi-turn (ASK-8): prior Q/A in this view are passed as history;
// state is view-local + ephemeral (F5), surviving shell view-switches but not relaunch.
//
// Thin DOM over the typed IPC, matching the other views. Markdown/citation rich-rendering (F6) is
// KB-Lead's slice-3 call — slice 2 renders the answer text + an evidence list.
import { esc } from '../html';
import type { AskResult, Citation, RecallTurn } from '../../kb/types';

interface Turn {
  question: string;
  result: AskResult | null; // null while in flight
  error?: string;
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
        <button id="askBtn" class="primary" type="submit">Ask</button>
      </form>
    </div>`;
  const form = container.querySelector<HTMLFormElement>('#askForm');
  form?.addEventListener('submit', (e) => {
    e.preventDefault();
    void onAsk(container);
  });
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

function renderCitations(citations: Citation[]): string {
  if (citations.length === 0) return '';
  const items = citations
    .map((c) => `<li><code>${esc(c.kind)}</code> ${esc(c.ref)}${c.label ? ` — ${esc(c.label)}` : ''}</li>`)
    .join('');
  return `<div class="ask-citations"><span class="muted">Evidence</span><ul>${items}</ul></div>`;
}

function renderAnswer(r: AskResult): string {
  const flags: string[] = [];
  if (!r.grounded) flags.push('⚠ not grounded in the KB');
  if (r.truncated) flags.push('partial — retrieval budget reached');
  const flagHtml = flags.length ? `<div class="ask-flags muted">${flags.map(esc).join(' · ')}</div>` : '';
  return `<div class="ask-answer">${esc(r.answer)}</div>${renderCitations(r.citations)}${flagHtml}`;
}

function renderTurn(t: Turn): string {
  let body: string;
  if (t.error) body = `<div class="ask-answer error">Sorry — recall failed: ${esc(t.error)}</div>`;
  else if (t.result === null) body = `<div class="ask-answer muted">Thinking…</div>`;
  else body = renderAnswer(t.result);
  return `<li class="ask-turn"><div class="ask-q"><span class="muted">You</span> ${esc(t.question)}</div><div class="ask-a">${body}</div></li>`;
}

function renderTranscript(container: HTMLElement): void {
  const el = container.querySelector<HTMLElement>('#askTranscript');
  if (!el) return;
  el.innerHTML = turns.map(renderTurn).join('');
}
