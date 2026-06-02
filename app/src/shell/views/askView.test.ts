// @vitest-environment happy-dom
//
// SPEC-0026 ASK-1/2/8 — the Ask view, in the component tier (SPEC-0012 TEST-5, opened here:
// happy-dom via per-file env; the node tier stays the default). The IPC is mocked
// (`window.kbApi.ask`); we assert the rendered DOM and the request shape (incl. multi-turn history).
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mountAsk } from './askView';
import type { AskResult, KbApi } from '../../kb/types';

const GROUNDED: AskResult = {
  question: 'Who was Ada Lovelace?',
  answer: 'Ada Lovelace is regarded as the first computer programmer.',
  citations: [{ kind: 'claim', ref: 'claims/person/ada-lovelace.md', label: 'first computer programmer' }],
  grounded: true,
  toolCalls: 2,
  truncated: false,
};

function setAsk(fn: KbApi['ask']): void {
  (window as unknown as { kbApi: Pick<KbApi, 'ask'> }).kbApi = { ask: fn };
}
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));
function type(root: HTMLElement, value: string): void {
  (root.querySelector('#askInput') as HTMLInputElement).value = value;
}
function submit(root: HTMLElement): void {
  root.querySelector('#askForm')!.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
}

describe('Ask view (SPEC-0026 ASK-1/2/8)', () => {
  let root: HTMLElement;
  beforeEach(() => {
    document.body.innerHTML = '<div id="r"></div>';
    root = document.getElementById('r')!;
  });

  it('renders the prompt, input, and Ask button', () => {
    setAsk(vi.fn(async () => GROUNDED));
    mountAsk(root);
    expect(root.querySelector('h1')?.textContent).toContain('Ask');
    expect(root.querySelector('#askInput')).toBeTruthy();
    expect(root.querySelector('#askBtn')?.textContent).toBe('Ask');
  });

  it('submitting renders a grounded answer with its citations (ASK-1/7)', async () => {
    const ask = vi.fn(async () => GROUNDED);
    setAsk(ask);
    mountAsk(root);
    type(root, 'Who was Ada Lovelace?');
    submit(root);
    await tick();

    expect(ask).toHaveBeenCalledWith({ question: 'Who was Ada Lovelace?', history: [] });
    const transcript = root.querySelector('.ask-transcript')!;
    expect(transcript.textContent).toContain('Who was Ada Lovelace?');
    expect(transcript.textContent).toContain('first computer programmer');
    expect(transcript.querySelector('.ask-citations')).toBeTruthy();
    expect(transcript.querySelector('.ask-citations')!.textContent).toContain('claims/person/ada-lovelace.md');
    // pull-only: nothing was asked before the user submitted
    expect(ask).toHaveBeenCalledTimes(1);
  });

  it('passes prior turns as history (ASK-8 multi-turn)', async () => {
    const ask = vi.fn(async () => GROUNDED);
    setAsk(ask);
    mountAsk(root);
    type(root, 'q1');
    submit(root);
    await tick();
    type(root, 'q2');
    submit(root);
    await tick();
    expect(ask).toHaveBeenLastCalledWith({ question: 'q2', history: [{ question: 'q1', answer: GROUNDED.answer }] });
    expect(root.querySelectorAll('.ask-turn')).toHaveLength(2);
  });

  it('flags an ungrounded answer', async () => {
    setAsk(vi.fn(async () => ({ question: 'q', answer: "I don't know.", citations: [], grounded: false, toolCalls: 1, truncated: false })));
    mountAsk(root);
    type(root, 'q');
    submit(root);
    await tick();
    expect(root.querySelector('.ask-flags')?.textContent).toContain('not grounded');
    expect(root.querySelector('.ask-citations')).toBeNull();
  });

  it('flags a truncated (budget-reached) answer', async () => {
    setAsk(vi.fn(async () => ({ ...GROUNDED, truncated: true })));
    mountAsk(root);
    type(root, 'q');
    submit(root);
    await tick();
    expect(root.querySelector('.ask-flags')?.textContent).toContain('budget');
  });

  it('renders an error (never throws to the user) if the recall IPC fails', async () => {
    setAsk(vi.fn(async () => {
      throw new Error('copilot CLI unavailable');
    }));
    mountAsk(root);
    type(root, 'q');
    submit(root);
    await tick();
    expect(root.querySelector('.ask-answer.error')?.textContent).toContain('copilot CLI unavailable');
  });

  it('ignores empty/whitespace questions (no IPC call)', async () => {
    const ask = vi.fn(async () => GROUNDED);
    setAsk(ask);
    mountAsk(root);
    type(root, '   ');
    submit(root);
    await tick();
    expect(ask).not.toHaveBeenCalled();
  });
});
