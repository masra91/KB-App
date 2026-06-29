// @vitest-environment happy-dom
//
// WATCH-9 / SPEC-0060 — the Watched-folders section (component tier, happy-dom). Moved out of Connectors
// into its own self-contained mountable module (hosted by Settings). IPC mocked; asserts the roster +
// the per-folder rules (recursive/depth/drain) + the PANEL-7 confirm gates + the WATCH-6/10 loop-guard
// surfacing + the OS-picker add flow. Same wiring/contract as before — just mounted standalone now.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mountWatchedFolders } from './watchedFolders';
import type { WatchFolderView, KbApi } from '../../kb/types';

const folder: WatchFolderView = {
  id: 'inbox', folderPath: '/Users/me/KB-Inbox', label: 'inbox', enabled: true, scope: 'global', sensitivity: 'internal',
  ignoreGlobs: ['*.tmp'], recursive: false, maxDepth: 0, leaveOriginals: false, watching: true, lastEvent: { ts: '2025-06-03T09:00:00Z', kind: 'watch-ingested', path: 'note.md' },
};

let listWatchFolders: ReturnType<typeof vi.fn>;
let setWatchFolder: ReturnType<typeof vi.fn>;
let removeWatchFolder: ReturnType<typeof vi.fn>;
let pickFolder: ReturnType<typeof vi.fn>;

function setApi(): void {
  (window as unknown as { kbApi: Partial<KbApi> }).kbApi = {
    listWatchFolders: listWatchFolders as unknown as KbApi['listWatchFolders'],
    setWatchFolder: setWatchFolder as unknown as KbApi['setWatchFolder'],
    removeWatchFolder: removeWatchFolder as unknown as KbApi['removeWatchFolder'],
    pickFolder: pickFolder as unknown as KbApi['pickFolder'],
  };
}
const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  listWatchFolders = vi.fn(async () => [folder]);
  setWatchFolder = vi.fn(async () => [folder]);
  removeWatchFolder = vi.fn(async () => []);
  pickFolder = vi.fn(async () => '/Users/me/Newsletters');
  setApi();
});

async function mount(): Promise<HTMLElement> {
  const c = document.createElement('div');
  document.body.appendChild(c);
  await mountWatchedFolders(c);
  await flush();
  return c;
}

describe('Watched folders (WATCH-9) — self-contained section', () => {
  it('renders a live watched-folder strip (path, sentence-case armed label, typed last-event)', async () => {
    const c = await mount();
    const watch = c.querySelector('.rdesk-strip[data-watch-id="inbox"]')!;
    expect(watch).toBeTruthy();
    expect(watch.textContent).toContain('/Users/me/KB-Inbox');
    expect(watch.querySelector('.watch-arm')!.textContent).toContain('Watching'); // enabled + watching (sentence case)
    expect(watch.textContent).toContain('brought in a file'); // typed lastEvent, no raw slug
    expect(c.querySelector('select')).toBeNull(); // no native <select>
  });

  it('shows a calm empty state when there are no watched folders', async () => {
    listWatchFolders = vi.fn(async () => []);
    setApi();
    const c = await mount();
    expect(c.querySelector('.viz-empty')).not.toBeNull();
  });

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
    pickFolder = vi.fn(async () => '/Users/me/MyVault/.kb'); // a path the backend loop-guard refuses
    setWatchFolder = vi.fn(async () => [folder]); // unchanged list — the refused folder is absent
    setApi();
    const c = await mount();
    (c.querySelector('.watch-add-pick') as HTMLButtonElement).click();
    await flush();
    expect(setWatchFolder).toHaveBeenCalled(); // the client sent it to the guarded backend (no client bypass)
    expect(c.querySelector('.watch-add-status')!.textContent).toMatch(/Couldn.t watch that folder.*inside your library/i);
    expect(c.querySelector('.rdesk-strip[data-watch-id="kb"]')).toBeNull(); // the refused folder never renders
  });

  it('a failed listWatchFolders degrades to a retryable load error (#145)', async () => {
    listWatchFolders = vi.fn(async () => {
      throw new Error('boom');
    });
    setApi();
    const c = await mount();
    expect(c.querySelector('.load-error, .load-retry')).not.toBeNull();
  });
});

describe('Watched folders · per-folder rules (WATCH-12/14/16)', () => {
  it('toggling "Include subfolders" applies directly — a local read, no confirm (WATCH-12)', async () => {
    const c = await mount();
    const rec = c.querySelector('.rdesk-strip[data-watch-id="inbox"] .watch-recursive') as HTMLButtonElement;
    expect(rec.getAttribute('aria-checked')).toBe('false');
    rec.click();
    await flush();
    expect(setWatchFolder).toHaveBeenCalledWith({ id: 'inbox', recursive: true }); // was off → on
  });

  it('the depth field is hidden until recursive, then visible; a change applies clamped to [0,32] (WATCH-12)', async () => {
    let c = await mount();
    expect((c.querySelector('.rdesk-strip[data-watch-id="inbox"] .watch-depth-wrap') as HTMLElement).hidden).toBe(true);

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

  it('WATCH-16: the add-folder flow makes drain-by-default clear (files move at creation)', async () => {
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

  it('WATCH-16: turning OFF "leave originals" CONFIRMS (starts draining/relocating files), then applies consume:true', async () => {
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
