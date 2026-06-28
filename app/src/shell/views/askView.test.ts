// @vitest-environment happy-dom
//
// SPEC-0026 ASK-1/2/8 — the Ask view, in the component tier (SPEC-0012 TEST-5, opened here:
// happy-dom via per-file env; the node tier stays the default). The IPC is mocked
// (`window.kbApi.ask`); we assert the rendered DOM and the request shape (incl. multi-turn history).
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
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

  describe('UX v2 (DL-2 render contract)', () => {
    it('is a material .viz-card with a Spectral (.viz-voice) head — no emoji, no flat legacy .card', () => {
      setAsk(vi.fn(async () => GROUNDED));
      mountAsk(root);
      const view = root.querySelector('.ask-view');
      expect(view?.classList.contains('viz-card')).toBe(true);
      expect(view?.classList.contains('viz-grain')).toBe(true);
      expect(view?.classList.contains('card')).toBe(false); // off the flat legacy chrome
      expect(root.querySelector('h1')?.classList.contains('viz-voice')).toBe(true);
      expect(root.querySelector('h1')?.textContent).not.toMatch(/💬|🗨|📣/);
    });

    it('shows a calm empty prompt before any question (never a blank panel)', () => {
      setAsk(vi.fn(async () => GROUNDED));
      mountAsk(root);
      expect(root.querySelector('.ask-empty')).toBeTruthy();
    });

    it('renders the answer as Spectral prose with accent Plex-Mono citation chips (WS-A preserved)', async () => {
      setAsk(vi.fn(async () => GROUNDED));
      mountAsk(root);
      type(root, 'Who was Ada Lovelace?');
      submit(root);
      await tick();
      expect(root.querySelector('.ask-answer')?.classList.contains('viz-voice')).toBe(true); // scholarly prose
      // the References entry is the clickable deep-link with a mono [n] + named source (WS-A intact)
      const ref = root.querySelector('.cite-ref');
      expect(ref).toBeTruthy();
      expect(ref?.querySelector('.cite-name')?.textContent).toContain('first computer programmer');
    });

    it('shows a calm "Searching your library…" state while in flight (never a scary spinner), and no ember anywhere', async () => {
      let resolve!: (r: AskResult) => void;
      setAsk(vi.fn(() => new Promise<AskResult>((r) => (resolve = r))));
      mountAsk(root);
      type(root, 'Who was Ada Lovelace?');
      submit(root);
      await tick();
      expect(root.querySelector('.ask-searching')?.textContent).toContain('Searching your library');
      expect(root.querySelector('[class*="ember"]')).toBeNull(); // Ask is a read, never a decision
      resolve(GROUNDED);
      await tick();
      expect(root.querySelector('.ask-answer.viz-voice')).toBeTruthy(); // resolves to the answer card
    });
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
    { kind: 'entity', ref: 'entities/ada.md', label: 'Ada Lovelace' },
    { kind: 'claim', ref: 'claims/bug.md', label: 'coined bug' },
  ];
  it('wraps each [n] in an href-less role=link anchor with the 1-based index + a source-naming aria-label (§5)', () => {
    const out = linkifyCitationMarkers('Ada [1] and Grace [2].', 3, CITES);
    expect(out).toContain('class="cite-link viz-focusable"');
    expect(out).toContain('role="link"'); // a11y: it IS a link (deep-link), not a generic button
    expect(out).not.toContain('role="button"'); // the wrong role is gone
    expect(out).toContain('tabindex="0"');
    expect(out).toContain('data-turn="3"');
    expect(out).toContain('data-cite="1"');
    expect(out).toContain('aria-label="Citation 1: Ada Lovelace"'); // names the source, not an anonymous anchor
    expect(out).toContain('aria-label="Citation 2: coined bug"');
    expect(out).not.toContain('href'); // the obsidian:// scheme never enters the DOM (built in main)
  });
  it('falls back to a bare "Citation n" label when a marker outruns citations[] (malformed output)', () => {
    expect(linkifyCitationMarkers('See [5].', 0, [])).toContain('aria-label="Citation 5"');
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

// WS3 migration (DESIGN-LEGACY-VIEWS §5): the Ask view moved off the legacy off-system primitives
// (.muted text, the framework-indigo button.primary, role=button on href-less citation anchors) onto
// The Line's blessed .viz-* primitives + the a11y baseline. Fails-before/passes-after guards on the CLASS.
describe('WS3 design-system migration (DESIGN-LEGACY-VIEWS §5 — onto The Line)', () => {
  let root: HTMLElement;
  beforeEach(() => {
    document.body.innerHTML = '<div id="r"></div>';
    root = document.getElementById('r')!;
  });
  const CITED: AskResult = {
    ...GROUNDED,
    answer: 'Ada [1] pioneered computing.',
    citations: [{ kind: 'entity', ref: 'entities/person/ada-lovelace.md', label: 'Ada Lovelace' }],
  };
  async function askOnce(): Promise<void> {
    type(root, 'q');
    submit(root);
    await tick();
  }

  it('renders the Ask submit button as a blessed .viz-btn--primary (was button.primary)', () => {
    setAsk(vi.fn(async () => GROUNDED));
    mountAsk(root);
    const btn = root.querySelector<HTMLButtonElement>('#askBtn')!;
    expect(btn.classList.contains('viz-btn')).toBe(true);
    expect(btn.classList.contains('viz-btn--primary')).toBe(true);
    expect(btn.classList.contains('primary')).toBe(false); // legacy indigo class gone
  });

  it('gives inline + reference citation links role=link + a source-naming aria-label, keyboard-reachable (§5 a11y)', async () => {
    setAsk(vi.fn(async () => CITED));
    mountAsk(root);
    await askOnce();
    const inline = root.querySelector<HTMLElement>('.ask-answer .cite-link')!;
    expect(inline.getAttribute('role')).toBe('link'); // was role=button
    expect(inline.getAttribute('href')).toBeNull(); // scheme stays out of the DOM
    expect(inline.getAttribute('aria-label')).toBe('Citation 1: Ada Lovelace');
    expect(inline.getAttribute('tabindex')).toBe('0');
    expect(inline.classList.contains('viz-focusable')).toBe(true); // ember focus ring
    const ref = root.querySelector<HTMLElement>('.ask-citations .cite-ref')!;
    expect(ref.getAttribute('role')).toBe('link');
    expect(ref.getAttribute('aria-label')).toBe('Citation 1: Ada Lovelace');
  });

  it('carries NO legacy off-system primitives (.muted / button.primary) on any render path', async () => {
    setAsk(vi.fn(async () => CITED));
    mountAsk(root);
    await askOnce(); // exercises header, transcript, answer, citations, save-row
    expect(root.querySelector('.muted')).toBeNull(); // header note / "You" / flags / saved-row / refs label migrated
    expect(root.querySelector('button.primary')).toBeNull(); // Ask + Save are .viz-btn now
  });

  // The long-token wrap (§5) is CSS-only — happy-dom applies no stylesheet, so assert the CSS SOURCE
  // (the same guard pattern as confirmDismissCss.test.ts).
  it('wraps long unbroken answer tokens — .ask-answer carries overflow-wrap in the CSS source (§5)', () => {
    const indexCss = readFileSync(path.resolve(process.cwd(), 'src/index.css'), 'utf8');
    const m = indexCss.match(/\.ask-answer\s*\{([^}]*)\}/);
    expect(m).not.toBeNull();
    expect(m![1]).toMatch(/overflow-wrap\s*:\s*anywhere/);
  });
});
