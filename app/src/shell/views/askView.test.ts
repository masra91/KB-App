// @vitest-environment happy-dom
//
// SPEC-0026 ASK-1/2/8 — the Ask view, in the component tier (SPEC-0012 TEST-5, opened here:
// happy-dom via per-file env; the node tier stays the default). The IPC is mocked
// (`window.kbApi.ask`); we assert the rendered DOM and the request shape (incl. multi-turn history).
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mountAsk, linkifyCitationMarkers } from './askView';
import type { AskResult, Citation, KbApi } from '../../kb/types';

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
    // #2: the reference shows the human label + capitalized kind; the raw vault path is in the tooltip, not inline.
    expect(transcript.querySelector('.ask-citations .cite-ref')!.textContent).toContain('Claim');
    expect(transcript.querySelector('.ask-citations')!.textContent).not.toContain('claims/person/ada-lovelace.md');
    expect(transcript.querySelector('.ask-citations .cite-ref')!.getAttribute('title')).toContain('claims/person/ada-lovelace.md');
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

describe('Ask view · save-as-Output (SPEC-0026 ASK-6)', () => {
  let root: HTMLElement;
  beforeEach(() => {
    document.body.innerHTML = '<div id="r"></div>';
    root = document.getElementById('r')!;
  });

  function setApi(ask: KbApi['ask'], saveRecallOutput: KbApi['saveRecallOutput']): void {
    (window as unknown as { kbApi: Pick<KbApi, 'ask' | 'saveRecallOutput'> }).kbApi = { ask, saveRecallOutput };
  }
  async function askOnce(): Promise<void> {
    type(root, 'Who was Ada Lovelace?');
    submit(root);
    await tick();
  }
  const saveBtn = (): HTMLButtonElement | null => root.querySelector('.ask-save');

  it('offers "Save as report" on an answered turn and persists it on click (ASK-6)', async () => {
    const save = vi.fn(async () => ({ ok: true, rel: 'outputs/recall/OUT1.md', message: 'Saved to outputs/recall/OUT1.md' }));
    setApi(vi.fn(async () => GROUNDED), save);
    mountAsk(root);
    await askOnce();

    expect(saveBtn()).toBeTruthy();
    saveBtn()!.click();
    await tick();

    expect(save).toHaveBeenCalledWith(GROUNDED); // the rendered AskResult is what gets saved
    expect(root.querySelector('.ask-save-row')?.textContent).toContain('Saved as Output');
    expect(root.querySelector('.ask-save-row code')?.textContent).toBe('outputs/recall/OUT1.md');
    expect(saveBtn()).toBeNull(); // button replaced by the saved confirmation
  });

  it('surfaces a save failure inline and keeps the button (retryable)', async () => {
    const save = vi.fn(async () => ({ ok: false, message: 'No active knowledge base.' }));
    setApi(vi.fn(async () => GROUNDED), save);
    mountAsk(root);
    await askOnce();
    saveBtn()!.click();
    await tick();
    expect(root.querySelector('.ask-save-status')?.textContent).toContain('No active knowledge base.');
    expect(saveBtn()).toBeTruthy(); // still offered
  });

  it('allows saving an UNGROUNDED answer too (F4 — honesty preserved by the banner)', async () => {
    const ungrounded: AskResult = { ...GROUNDED, grounded: false, citations: [] };
    setApi(vi.fn(async () => ungrounded), vi.fn(async () => ({ ok: true, rel: 'outputs/recall/U.md', message: 'ok' })));
    mountAsk(root);
    await askOnce();
    expect(saveBtn()).toBeTruthy(); // save offered even when not grounded
  });
});

describe('Ask view · sanitized markdown rendering (#93)', () => {
  let root: HTMLElement;
  beforeEach(() => {
    document.body.innerHTML = '<div id="r"></div>';
    root = document.getElementById('r')!;
  });
  const answerWith = (answer: string): AskResult => ({ ...GROUNDED, answer });
  async function ask(answer: string): Promise<void> {
    setAsk(vi.fn(async () => answerWith(answer)));
    mountAsk(root);
    type(root, 'q');
    submit(root);
    await tick();
  }

  it('renders markdown (no literal `**`/`#` left in the panel)', async () => {
    await ask('**Ada** was a _pioneer_.');
    const panel = root.querySelector('.ask-answer')!;
    expect(panel.querySelector('strong')?.textContent).toBe('Ada');
    expect(panel.querySelector('em')?.textContent).toBe('pioneer');
    expect(panel.innerHTML).not.toContain('**'); // raw markers gone
  });

  it('SANITIZES model output — strips an event-handler attribute (E1), keeps benign content', async () => {
    await ask('Hello <img src=x onerror="window.__pwned=1"> world');
    const panel = root.querySelector('.ask-answer')!;
    expect(panel.querySelector('img')?.getAttribute('onerror') ?? null).toBeNull(); // onerror stripped
    expect((window as unknown as { __pwned?: number }).__pwned).toBeUndefined();
    expect(panel.textContent).toContain('Hello'); // benign text + the safe <img src> survive
  });

  it('SANITIZES model output — strips <script> entirely (E1)', async () => {
    await ask('before <script>window.__pwned=1</script> after');
    const panel = root.querySelector('.ask-answer')!;
    expect(panel.querySelector('script')).toBeNull();
    expect(panel.innerHTML).not.toContain('<script');
    expect(panel.textContent).toContain('before');
    expect(panel.textContent).toContain('after');
  });

  it('keeps a safe markdown link but drops a javascript: URL', async () => {
    await ask('[ok](https://example.com) and [bad](javascript:alert(1))');
    const hrefs = Array.from(root.querySelectorAll('.ask-answer a')).map((a) => a.getAttribute('href'));
    expect(hrefs).toContain('https://example.com');
    expect(hrefs.some((h) => h?.startsWith('javascript:'))).toBe(false);
  });
});

describe('linkifyCitationMarkers (ASK-14, pure)', () => {
  const CITES: Citation[] = [
    { kind: 'entity', ref: 'entities/person/ada.md', label: 'Ada Lovelace' },
    { kind: 'claim', ref: 'claims/grace/bug.md', label: 'coined bug' },
  ];
  it('wraps each [n] in a class-tagged, href-less role=link anchor with a source-naming aria-label (§5/§7)', () => {
    const out = linkifyCitationMarkers('Ada [1] and Grace [2].', 3, CITES);
    expect(out).toContain(
      '<a class="cite-link" role="link" tabindex="0" aria-label="Citation 1: Ada Lovelace" data-turn="3" data-cite="1">[1]</a>',
    );
    expect(out).toContain('aria-label="Citation 2: coined bug"');
    expect(out).toContain('data-cite="2">[2]</a>');
    expect(out).not.toContain('href'); // the obsidian:// scheme never enters the DOM (built in main)
    expect(out).not.toContain('role="button"'); // migrated off the legacy button role → link semantics
  });
  it('falls back to a bare "Citation n" aria-label when no matching citation is present', () => {
    expect(linkifyCitationMarkers('orphan [5] marker', 0)).toContain('aria-label="Citation 5"');
  });
  it('leaves non-citation text untouched', () => {
    expect(linkifyCitationMarkers('no markers here', 0)).toBe('no markers here');
  });
});

describe('Ask view · citation deep-links (SPEC-0026 ASK-14)', () => {
  let root: HTMLElement;
  beforeEach(() => {
    document.body.innerHTML = '<div id="r"></div>';
    root = document.getElementById('r')!;
  });

  const CITED: AskResult = {
    question: 'q',
    answer: 'Ada [1] pioneered computing; Grace [2] coined "bug".',
    citations: [
      { kind: 'entity', ref: 'entities/person/ada-lovelace.md', label: 'Ada Lovelace' },
      { kind: 'claim', ref: 'claims/person/grace/bug.md', label: 'coined bug' },
    ],
    grounded: true,
    toolCalls: 2,
    truncated: false,
  };

  function setApi(open: KbApi['openCitation']): void {
    (window as unknown as { kbApi: Pick<KbApi, 'ask' | 'openCitation'> }).kbApi = {
      ask: vi.fn(async () => CITED),
      openCitation: open,
    };
  }
  async function askOnce(): Promise<void> {
    type(root, 'q');
    submit(root);
    await tick();
  }

  it('renders each inline [n] as a clickable, href-less .cite-link (ASK-14)', async () => {
    setApi(vi.fn(async () => ({ ok: true })));
    mountAsk(root);
    await askOnce();
    const links = root.querySelectorAll('.ask-answer .cite-link');
    expect(links).toHaveLength(2);
    expect(links[0].getAttribute('href')).toBeNull(); // protocol stays out of the DOM
    expect((links[0] as HTMLElement).dataset.cite).toBe('1');
    expect(links[0].textContent).toBe('[1]');
  });

  it('renders a numbered References list from citations[] (ASK-13/14)', async () => {
    setApi(vi.fn(async () => ({ ok: true })));
    mountAsk(root);
    await askOnce();
    const refs = root.querySelectorAll('.ask-citations .cite-ref');
    expect(refs).toHaveLength(2);
    expect(root.querySelector('.ask-citations')?.textContent).toContain('References');
    expect(refs[0].textContent).toContain('[1]');
    // #2: label-first + capitalized kind inline; the raw path lives in the tooltip, not the visible text.
    expect(refs[0].textContent).toContain('Ada Lovelace'); // the human label
    expect(refs[0].textContent).toContain('Entity'); // capitalized kind
    expect(refs[0].textContent).not.toContain('entities/person/ada-lovelace.md');
    expect(refs[0].getAttribute('title')).toContain('entities/person/ada-lovelace.md');
    expect(refs[1].textContent).toContain('coined bug');
  });

  it('clicking an inline [n] opens its citation via the canonical ref (index-mapped, ASK-14)', async () => {
    const open = vi.fn(async () => ({ ok: true }));
    setApi(open);
    mountAsk(root);
    await askOnce();
    (root.querySelectorAll('.cite-link')[1] as HTMLElement).click(); // [2]
    await tick();
    expect(open).toHaveBeenCalledWith('claims/person/grace/bug.md'); // citations[1].ref
  });

  it('clicking a References entry opens the same canonical target', async () => {
    const open = vi.fn(async () => ({ ok: true }));
    setApi(open);
    mountAsk(root);
    await askOnce();
    (root.querySelectorAll('.cite-ref')[0] as HTMLElement).click(); // [1]
    await tick();
    expect(open).toHaveBeenCalledWith('entities/person/ada-lovelace.md'); // citations[0].ref
  });

  it('opens on keyboard (Enter) for a11y — anchors are role=link/tabindex=0', async () => {
    const open = vi.fn(async () => ({ ok: true }));
    setApi(open);
    mountAsk(root);
    await askOnce();
    root
      .querySelectorAll('.cite-link')[0]
      .dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await tick();
    expect(open).toHaveBeenCalledWith('entities/person/ada-lovelace.md');
  });

  it('surfaces a failed open inline (never throws to the user)', async () => {
    setApi(vi.fn(async () => ({ ok: false, reason: 'open-failed' as const })));
    mountAsk(root);
    await askOnce();
    (root.querySelector('.cite-link') as HTMLElement).click();
    await tick();
    expect(root.querySelector('.ask-cite-status.error')?.textContent).toContain('Obsidian');
  });
});

// WS3 migration (DESIGN-LEGACY-VIEWS §5/§7): Ask moved off the legacy `.primary` button + role=button
// citation anchors onto the blessed `.viz-btn--primary` + role=link semantics with source-naming
// aria-labels. These are the fails-before/passes-after guards on the CLASS — a regression to `.primary`,
// a dropped aria-label, or role=button reappearing all trip here.
describe('Ask view · WS3 design-system migration (DESIGN-LEGACY-VIEWS §5/§7)', () => {
  let root: HTMLElement;
  beforeEach(() => {
    document.body.innerHTML = '<div id="r"></div>';
    root = document.getElementById('r')!;
  });

  const CITED_INLINE: AskResult = {
    question: 'q',
    answer: 'Ada [1] pioneered computing.',
    citations: [{ kind: 'entity', ref: 'entities/person/ada-lovelace.md', label: 'Ada Lovelace' }],
    grounded: true,
    toolCalls: 1,
    truncated: false,
  };

  it('the Ask button is the blessed .viz-btn--primary, not the legacy .primary (§5 swap)', () => {
    setAsk(vi.fn(async () => GROUNDED));
    mountAsk(root);
    const btn = root.querySelector<HTMLButtonElement>('#askBtn')!;
    expect(btn.classList.contains('viz-btn')).toBe(true);
    expect(btn.classList.contains('viz-btn--primary')).toBe(true);
    expect(btn.classList.contains('primary')).toBe(false); // legacy primitive gone
  });

  it('no legacy button.primary survives anywhere in the rendered view (no-legacy-primitives sweep)', async () => {
    setAsk(vi.fn(async () => CITED_INLINE));
    mountAsk(root);
    type(root, 'q');
    submit(root);
    await tick();
    expect(root.querySelector('button.primary')).toBeNull();
  });

  it('inline citation markers render as href-less role=link with a source-naming aria-label (§7)', async () => {
    setAsk(vi.fn(async () => CITED_INLINE));
    mountAsk(root);
    type(root, 'q');
    submit(root);
    await tick();
    const marker = root.querySelector<HTMLElement>('.ask-answer .cite-link')!;
    expect(marker.getAttribute('role')).toBe('link');
    expect(marker.getAttribute('tabindex')).toBe('0');
    expect(marker.getAttribute('aria-label')).toBe('Citation 1: Ada Lovelace'); // names the source, not bare "[1]"
    expect(marker.getAttribute('href')).toBeNull();
  });

  it('References entries are role=link (citation links navigate to a source) — no leftover role=button (§7)', async () => {
    setAsk(vi.fn(async () => CITED_INLINE));
    mountAsk(root);
    type(root, 'q');
    submit(root);
    await tick();
    const ref = root.querySelector<HTMLElement>('.ask-citations .cite-ref')!;
    expect(ref.getAttribute('role')).toBe('link');
    expect(root.querySelector('.ask-citations [role="button"]')).toBeNull();
  });
});
