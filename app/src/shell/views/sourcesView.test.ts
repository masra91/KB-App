// @vitest-environment happy-dom
//
// SPEC-0027 PANEL-4 / INTAKE-14 — the unified Sources Manage view, component tier (happy-dom). IPC
// mocked; asserts the rendered feed strips, the WS2 guardrails (segmented schedule, NO native <select>),
// the enable-confirm gate (enabling starts an outbound pull), the typed pull report, add-from-tile, the
// Watched-folders "arriving" section, and HTML escaping of untrusted connector fields.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mountSources } from './sourcesView';
import type { IntakeConnectorView, WatchFolderView, KbApi } from '../../kb/types';

const rss: IntakeConnectorView = {
  id: 'news', type: 'rss', typeLabel: 'RSS / Atom feed', label: 'news', enabled: false, schedule: 'off',
  scope: 'global', sensitivity: 'internal', maxItemsPerPass: 25, feedUrl: 'https://example.com/feed.xml', tenantId: '', folder: '', lastRun: null,
};
const folder: WatchFolderView = {
  id: 'inbox', folderPath: '/Users/me/KB-Inbox', label: 'inbox', enabled: true, scope: 'global', sensitivity: 'internal',
  ignoreGlobs: ['*.tmp'], recursive: false, maxDepth: 0, leaveOriginals: false, watching: true, lastEvent: { ts: '2025-06-03T09:00:00Z', kind: 'watch-ingested', path: 'note.md' },
};

let listIntakeConnectors: ReturnType<typeof vi.fn>;
let setIntakeConnectorConfig: ReturnType<typeof vi.fn>;
let removeIntakeConnector: ReturnType<typeof vi.fn>;
let runIntakeConnectorNow: ReturnType<typeof vi.fn>;
let listWatchFolders: ReturnType<typeof vi.fn>;
let setWatchFolder: ReturnType<typeof vi.fn>;
let removeWatchFolder: ReturnType<typeof vi.fn>;
let pickFolder: ReturnType<typeof vi.fn>;

function setApi(): void {
  (window as unknown as { kbApi: Partial<KbApi> }).kbApi = {
    listIntakeConnectors: listIntakeConnectors as unknown as KbApi['listIntakeConnectors'],
    setIntakeConnectorConfig: setIntakeConnectorConfig as unknown as KbApi['setIntakeConnectorConfig'],
    removeIntakeConnector: removeIntakeConnector as unknown as KbApi['removeIntakeConnector'],
    runIntakeConnectorNow: runIntakeConnectorNow as unknown as KbApi['runIntakeConnectorNow'],
    listWatchFolders: listWatchFolders as unknown as KbApi['listWatchFolders'],
    setWatchFolder: setWatchFolder as unknown as KbApi['setWatchFolder'],
    removeWatchFolder: removeWatchFolder as unknown as KbApi['removeWatchFolder'],
    pickFolder: pickFolder as unknown as KbApi['pickFolder'],
  };
}
const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  listIntakeConnectors = vi.fn(async () => [rss]);
  setIntakeConnectorConfig = vi.fn(async () => [{ ...rss, enabled: true }]);
  removeIntakeConnector = vi.fn(async () => []);
  runIntakeConnectorNow = vi.fn(async () => ({ ran: true, sourceIds: ['SRC1'], note: 'ok' }));
  listWatchFolders = vi.fn(async () => [folder]);
  setWatchFolder = vi.fn(async () => [folder]);
  removeWatchFolder = vi.fn(async () => []);
  pickFolder = vi.fn(async () => '/Users/me/Newsletters');
  setApi();
});

async function mount(): Promise<HTMLElement> {
  const c = document.createElement('div');
  document.body.appendChild(c);
  await mountSources(c);
  await flush();
  return c;
}

describe('Sources view (PANEL-4 / INTAKE-14)', () => {
  it('renders a feed strip with id, type label, enable switch, feed-url field, segmented schedule — no native <select>', async () => {
    const c = await mount();
    const strip = c.querySelector('.rdesk-strip[data-id="news"]')!;
    expect(strip).toBeTruthy();
    expect(strip.querySelector('.rdesk-id')!.textContent).toBe('news');
    expect(strip.querySelector('.rdesk-kind')!.textContent).toContain('RSS / Atom feed');
    expect(strip.querySelector('.intake-arm')!.textContent).toContain('Paused'); // UX v2 §4: sentence-case ink label + hue dot (was UPPERCASE ◉/○)
    expect((strip.querySelector('.intake-feedurl') as HTMLInputElement).value).toBe('https://example.com/feed.xml');
    expect(strip.querySelector('.intake-schedule[role="radiogroup"]')).toBeTruthy();
    expect(c.querySelector('select')).toBeNull(); // WS2: segmented control, never a native select
  });

  it('UX v2 (SPEC-0058): material-carded sections + tokenized marks, no emoji glyphs leaked (#184)', async () => {
    const c = await mount();
    // scoped material marker present (so the shared rdesk-* language isn't restyled globally)
    expect(c.querySelector('.rdesk.src-v2')).toBeTruthy();
    // sections are real cards (foundation material), not flat dividers
    const sections = Array.from(c.querySelectorAll('.src-section'));
    expect(sections.length).toBe(2);
    expect(sections.every((s) => s.classList.contains('viz-card') && s.classList.contains('viz-grain'))).toBe(true);
    // type marks are tokenized (hue-class), and the armed switch carries a hue dot — both aria-hidden
    expect(c.querySelector('.src-mark--rss')).toBeTruthy();
    expect(c.querySelector('.intake-arm .src-arm-dot')).toBeTruthy();
    // NO raw emoji glyphs anywhere in the rendered Sources view (the v2 tokenization, #184) — the marks
    // are GEOMETRIC symbols (◈/▣/●), never pictographic emoji. Guards the specific removed glyphs + the
    // emoji pictographic blocks (not the geometric U+25xx symbol block the tokenized marks legitimately use).
    expect(/[\u{1F300}-\u{1FAFF}\u{1F000}-\u{1F0FF}]|📰|📂|✉|🔌/u.test(c.textContent ?? '')).toBe(false);
  });

  it('shows both Feeds + Watched-folders sections, each with live rows', async () => {
    const c = await mount();
    const heads = Array.from(c.querySelectorAll('.src-section-head')).map((h) => h.textContent);
    expect(heads).toEqual(['Feeds', 'Watched folders']);
    // a real watched-folder strip renders (not a placeholder)
    const watch = c.querySelector('.rdesk-strip[data-watch-id="inbox"]')!;
    expect(watch).toBeTruthy();
    expect(watch.textContent).toContain('/Users/me/KB-Inbox');
    expect(watch.querySelector('.watch-arm')!.textContent).toContain('Watching'); // enabled + watching (UX v2 §4 sentence-case)
    expect(watch.textContent).toContain('brought in a file'); // typed lastEvent, no raw slug
  });

  it('enabling a paused feed asks to confirm (it starts an outbound pull), then applies on confirm', async () => {
    const c = await mount();
    const strip = c.querySelector('.rdesk-strip[data-id="news"]')!;
    (strip.querySelector('.intake-arm') as HTMLButtonElement).click();
    await flush();
    const confirm = strip.querySelector('.intake-confirm') as HTMLElement;
    expect(confirm.hidden).toBe(false);
    expect(strip.querySelector('.intake-confirm-msg')!.textContent).toMatch(/Enable .*pull from RSS/i);
    expect(setIntakeConnectorConfig).not.toHaveBeenCalled(); // gated — not applied yet
    (strip.querySelector('.intake-confirm-go') as HTMLButtonElement).click();
    await flush();
    expect(setIntakeConnectorConfig).toHaveBeenCalledWith({ id: 'news', enabled: true });
  });

  it('schedule change applies directly (no confirm — steering)', async () => {
    const c = await mount();
    const opts = Array.from(c.querySelectorAll<HTMLButtonElement>('.intake-schedule .rdesk-seg-opt'));
    const daily = opts.find((o) => o.dataset.value === 'daily')!;
    daily.click();
    await flush();
    expect(setIntakeConnectorConfig).toHaveBeenCalledWith({ id: 'news', schedule: 'daily' });
  });

  it('"Pull now" runs the connector and shows the typed item count', async () => {
    runIntakeConnectorNow = vi.fn(async () => ({ ran: true, sourceIds: ['A', 'B'], note: 'ok' }));
    setApi();
    const c = await mount();
    (c.querySelector('.rdesk-strip[data-id="news"] .intake-run') as HTMLButtonElement).click();
    await flush();
    (c.querySelector('.intake-confirm-go') as HTMLButtonElement).click();
    await flush();
    expect(runIntakeConnectorNow).toHaveBeenCalledWith('news');
    expect(c.querySelector('.rdesk-strip[data-id="news"] .intake-status')!.textContent).toContain('Brought in 2 new items');
  });

  it('a failed pull surfaces the error (failed ≠ empty), not "no items"', async () => {
    runIntakeConnectorNow = vi.fn(async () => ({ ran: true, sourceIds: [], note: 'x', failed: true, error: 'feed unreachable' }));
    setApi();
    const c = await mount();
    (c.querySelector('.intake-run') as HTMLButtonElement).click();
    await flush();
    (c.querySelector('.intake-confirm-go') as HTMLButtonElement).click();
    await flush();
    expect(c.querySelector('.intake-status')!.textContent).toMatch(/Couldn't pull — feed unreachable/);
  });

  it('add-from-tile: RSS + M365 tiles, then naming + re-click creates a PAUSED connector', async () => {
    const c = await mount();
    const tiles = Array.from(c.querySelectorAll<HTMLButtonElement>('.rdesk-tile[data-type]')); // feed tiles only
    expect(tiles.map((t) => t.dataset.type)).toEqual(['rss', 'm365-mail']);
    tiles[0].click(); // choose RSS
    (c.querySelector('.intake-add-id') as HTMLInputElement).value = 'Hacker News';
    tiles[0].click(); // re-click = create
    await flush();
    expect(setIntakeConnectorConfig).toHaveBeenCalledWith({ id: 'hacker-news', type: 'rss', enabled: false });
  });

  it('escapes untrusted connector fields (no HTML injection via feedUrl)', async () => {
    listIntakeConnectors = vi.fn(async () => [{ ...rss, id: 'x', feedUrl: '"><img src=x onerror=alert(1)>' }]);
    setApi();
    const c = await mount();
    expect(c.querySelector('img')).toBeNull(); // the payload is escaped, never parsed as a tag
  });

  it('renders the branded compact empty state (#406) when there are no feeds', async () => {
    listIntakeConnectors = vi.fn(async () => []);
    setApi();
    const c = await mount();
    const empty = c.querySelector('.src-section .viz-empty--compact');
    expect(empty).not.toBeNull();
    expect(empty!.textContent).toMatch(/No feeds yet/);
    expect(c.querySelector('.rdesk-tile[data-type]')).toBeTruthy(); // feed add-dock still present
  });

  // PANEL-11 lifecycle delete — a user-added feed is REMOVABLE behind a destructive confirm; the produced
  // items + audit are retained (the copy explains it), only the config is purged.
  it('a feed has a Remove affordance with its OWN destructive (danger) confirm', async () => {
    const c = await mount();
    const strip = c.querySelector('.rdesk-strip[data-id="news"]')!;
    const removeBtn = strip.querySelector('.intake-remove') as HTMLButtonElement;
    expect(removeBtn).toBeTruthy();
    // The remove confirm is its own block with a danger-styled Confirm — not the primary enable/pull confirm.
    expect(strip.querySelector('.intake-remove-confirm .viz-btn--danger')).toBeTruthy();
    // ...and the confirm frame itself is oxide (viz-confirm--danger) to match the danger button (DL coherence).
    expect(strip.querySelector('.intake-remove-confirm')?.classList.contains('viz-confirm--danger')).toBe(true);
  });

  it('Remove gates behind a confirm (items kept), then calls removeIntakeConnector only on confirm', async () => {
    const c = await mount();
    const strip = c.querySelector('.rdesk-strip[data-id="news"]')!;
    (strip.querySelector('.intake-remove') as HTMLButtonElement).click();
    await flush();
    const confirm = strip.querySelector('.intake-remove-confirm') as HTMLElement;
    expect(confirm.hidden).toBe(false);
    expect(strip.querySelector('.intake-remove-confirm-msg')!.textContent).toMatch(/Items already brought in.*stay in your KB/i);
    expect(removeIntakeConnector).not.toHaveBeenCalled(); // gated — not removed yet
    (strip.querySelector('.intake-remove-confirm-go') as HTMLButtonElement).click();
    await flush();
    expect(removeIntakeConnector).toHaveBeenCalledWith('news');
  });

  it('Remove can be cancelled — nothing is removed', async () => {
    const c = await mount();
    const strip = c.querySelector('.rdesk-strip[data-id="news"]')!;
    (strip.querySelector('.intake-remove') as HTMLButtonElement).click();
    await flush();
    (strip.querySelector('.intake-remove-confirm-cancel') as HTMLButtonElement).click();
    await flush();
    expect((strip.querySelector('.intake-remove-confirm') as HTMLElement).hidden).toBe(true);
    expect(removeIntakeConnector).not.toHaveBeenCalled();
  });

  // ENG-15/16 render safety: legacy/partial connector rows must not crash the view, and per-row isolation
  // means a malformed row never takes out a well-formed neighbor's Remove affordance.
  it('renders partial/legacy connector rows without crashing, keeping per-row Remove', async () => {
    const partial = { id: 'legacy', type: 'rss' } as unknown as IntakeConnectorView; // missing typeLabel/label/feedUrl/etc.
    listIntakeConnectors = vi.fn(async () => [partial, rss]);
    setApi();
    const c = await mount();
    expect(c.querySelectorAll('.rdesk-strip[data-id]').length).toBe(2); // both rows rendered, neither crashed
    expect(c.querySelector('.rdesk-strip[data-id="legacy"] .intake-remove')).toBeTruthy();
    expect(c.querySelector('.rdesk-strip[data-id="news"] .intake-remove')).toBeTruthy();
  });
});

describe('Sources view · Watched folders (WATCH-9)', () => {
  it('toggling a watched folder applies directly (local read, no confirm)', async () => {
    const c = await mount();
    (c.querySelector('.rdesk-strip[data-watch-id="inbox"] .watch-arm') as HTMLButtonElement).click();
    await flush();
    expect(setWatchFolder).toHaveBeenCalledWith({ id: 'inbox', enabled: false }); // was enabled → toggled off
  });

  it('removing a watched folder confirms first, then calls removeWatchFolder', async () => {
    const c = await mount();
    const strip = c.querySelector('.rdesk-strip[data-watch-id="inbox"]')!;
    (strip.querySelector('.watch-remove') as HTMLButtonElement).click();
    await flush();
    expect((strip.querySelector('.watch-confirm') as HTMLElement).hidden).toBe(false);
    expect(removeWatchFolder).not.toHaveBeenCalled(); // gated
    (strip.querySelector('.watch-confirm-go') as HTMLButtonElement).click();
    await flush();
    expect(removeWatchFolder).toHaveBeenCalledWith('inbox');
  });

  it('add-folder: OS picker → setWatchFolder with the slugified basename, PAUSED', async () => {
    setWatchFolder = vi.fn(async () => [folder, { ...folder, id: 'newsletters', folderPath: '/Users/me/Newsletters', label: 'newsletters', enabled: false }]);
    setApi();
    const c = await mount();
    (c.querySelector('.watch-add-pick') as HTMLButtonElement).click();
    await flush();
    expect(pickFolder).toHaveBeenCalled();
    expect(setWatchFolder).toHaveBeenCalledWith({ id: 'newsletters', folderPath: '/Users/me/Newsletters', enabled: false });
  });

  it('SECURITY: a loop-guard-refused folder is surfaced cleanly (no client-side bypass) — the folder is NOT shown', async () => {
    // The backend refuses an in-vault folder by NOT persisting it → returns a list without the new id.
    pickFolder = vi.fn(async () => '/Users/me/MyVault/.kb'); // a path the backend loop-guard refuses
    setWatchFolder = vi.fn(async () => [folder]); // unchanged list — the refused folder is absent
    setApi();
    const c = await mount();
    (c.querySelector('.watch-add-pick') as HTMLButtonElement).click();
    await flush();
    expect(setWatchFolder).toHaveBeenCalled(); // the client sent it to the guarded backend (no client bypass)
    expect(c.querySelector('.watch-add-status')!.textContent).toMatch(/Couldn.t watch that folder.*inside your knowledge base/i);
    expect(c.querySelector('.rdesk-strip[data-watch-id="kb"]')).toBeNull(); // the refused folder never renders
  });

  it('a failed listWatchFolders degrades just that section; Feeds still render', async () => {
    listWatchFolders = vi.fn(async () => { throw new Error('boom'); });
    setApi();
    const c = await mount();
    expect(c.querySelector('.rdesk-strip[data-id="news"]')).toBeTruthy(); // feeds still render
    expect(c.textContent).toMatch(/Couldn.t load watched folders/);
  });
});

describe('Sources view · Slice-2 per-folder rules (WATCH-12/14)', () => {
  it('toggling "Include subfolders" applies directly — a local read, no confirm (WATCH-12)', async () => {
    const c = await mount();
    const strip = c.querySelector('.rdesk-strip[data-watch-id="inbox"]')!;
    const rec = strip.querySelector('.watch-recursive') as HTMLButtonElement;
    expect(rec.getAttribute('aria-checked')).toBe('false');
    rec.click();
    await flush();
    expect(setWatchFolder).toHaveBeenCalledWith({ id: 'inbox', recursive: true }); // was off → on
  });

  it('the depth field is hidden until recursive, then visible; a change applies clamped to [0,32] (WATCH-12)', async () => {
    // non-recursive → depth control hidden
    let c = await mount();
    expect((c.querySelector('.rdesk-strip[data-watch-id="inbox"] .watch-depth-wrap') as HTMLElement).hidden).toBe(true);

    // recursive folder → depth control visible + steers on change (clamped)
    listWatchFolders = vi.fn(async () => [{ ...folder, recursive: true, maxDepth: 3 }]);
    setApi();
    c = await mount();
    const wrap = c.querySelector('.rdesk-strip[data-watch-id="inbox"] .watch-depth-wrap') as HTMLElement;
    expect(wrap.hidden).toBe(false);
    const depth = c.querySelector('.watch-depth') as HTMLInputElement;
    depth.value = '99';
    depth.dispatchEvent(new Event('change'));
    await flush();
    expect(setWatchFolder).toHaveBeenCalledWith({ id: 'inbox', maxDepth: 32 }); // clamped
  });

  it('WATCH-16: the add-folder flow makes drain-by-default clear (KB-Lead — files move at creation)', async () => {
    const c = await mount();
    const hint = c.querySelector('.watch-add-hint')!;
    expect(hint.textContent).toMatch(/drains like an inbox/i);
    expect(hint.textContent).toMatch(/\.kb-processed/);
    expect(hint.textContent).toMatch(/never deleted/i);
  });

  it('WATCH-16: a folder DRAINS by default — the toggle reads "leave originals: off"', async () => {
    const c = await mount();
    const toggle = c.querySelector('.rdesk-strip[data-watch-id="inbox"] .watch-consume') as HTMLButtonElement;
    expect(toggle.getAttribute('aria-checked')).toBe('false'); // leaveOriginals false → draining
    expect(toggle.textContent).toMatch(/Leave originals in place: off/i);
  });

  it('WATCH-16: turning OFF "leave originals" CONFIRMS (it starts draining/relocating files), then applies consume:true', async () => {
    listWatchFolders = vi.fn(async () => [{ ...folder, leaveOriginals: true }]); // currently copy mode
    setApi();
    const c = await mount();
    const strip = c.querySelector('.rdesk-strip[data-watch-id="inbox"]')!;
    (strip.querySelector('.watch-consume') as HTMLButtonElement).click();
    await flush();
    expect((strip.querySelector('.watch-consume-confirm') as HTMLElement).hidden).toBe(false);
    expect(strip.querySelector('.watch-consume-confirm-msg')!.textContent).toMatch(/drain.*\.kb-processed.*never deleted/i);
    expect(setWatchFolder).not.toHaveBeenCalled(); // gated
    (strip.querySelector('.watch-consume-confirm-go') as HTMLButtonElement).click();
    await flush();
    expect(setWatchFolder).toHaveBeenCalledWith({ id: 'inbox', consume: true }); // start draining
  });

  it('WATCH-16: turning ON "leave originals" applies directly — no confirm (stops moving files, safe)', async () => {
    const c = await mount(); // base fixture drains (leaveOriginals:false) → click opts into copy
    (c.querySelector('.rdesk-strip[data-watch-id="inbox"] .watch-consume') as HTMLButtonElement).click();
    await flush();
    expect(setWatchFolder).toHaveBeenCalledWith({ id: 'inbox', consume: false }); // leave originals
  });
});
