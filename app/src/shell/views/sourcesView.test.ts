// @vitest-environment happy-dom
//
// SPEC-0027 PANEL-4 / INTAKE-14 — the unified Sources Manage view, component tier (happy-dom). IPC
// mocked; asserts the rendered feed strips, the WS2 guardrails (segmented schedule, NO native <select>),
// the enable-confirm gate (enabling starts an outbound pull), the typed pull report, add-from-tile, the
// Watched-folders "arriving" section, and HTML escaping of untrusted connector fields.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mountSources } from './sourcesView';
import type { IntakeConnectorView, KbApi } from '../../kb/types';

const rss: IntakeConnectorView = {
  id: 'news', type: 'rss', typeLabel: 'RSS / Atom feed', label: 'news', enabled: false, schedule: 'off',
  scope: 'global', sensitivity: 'internal', maxItemsPerPass: 25, feedUrl: 'https://example.com/feed.xml', tenantId: '', folder: '', lastRun: null,
};

let listIntakeConnectors: ReturnType<typeof vi.fn>;
let setIntakeConnectorConfig: ReturnType<typeof vi.fn>;
let runIntakeConnectorNow: ReturnType<typeof vi.fn>;

function setApi(): void {
  (window as unknown as { kbApi: Partial<KbApi> }).kbApi = {
    listIntakeConnectors: listIntakeConnectors as unknown as KbApi['listIntakeConnectors'],
    setIntakeConnectorConfig: setIntakeConnectorConfig as unknown as KbApi['setIntakeConnectorConfig'],
    runIntakeConnectorNow: runIntakeConnectorNow as unknown as KbApi['runIntakeConnectorNow'],
  };
}
const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  listIntakeConnectors = vi.fn(async () => [rss]);
  setIntakeConnectorConfig = vi.fn(async () => [{ ...rss, enabled: true }]);
  runIntakeConnectorNow = vi.fn(async () => ({ ran: true, sourceIds: ['SRC1'], note: 'ok' }));
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
    expect(strip.querySelector('.intake-arm')!.textContent).toContain('PAUSED');
    expect((strip.querySelector('.intake-feedurl') as HTMLInputElement).value).toBe('https://example.com/feed.xml');
    expect(strip.querySelector('.intake-schedule[role="radiogroup"]')).toBeTruthy();
    expect(c.querySelector('select')).toBeNull(); // WS2: segmented control, never a native select
  });

  it('shows both Feeds + Watched-folders sections (folders arriving)', async () => {
    const c = await mount();
    const heads = Array.from(c.querySelectorAll('.src-section-head')).map((h) => h.textContent);
    expect(heads).toEqual(['Feeds', 'Watched folders']);
    expect(c.textContent).toContain('Arriving soon');
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
    const tiles = Array.from(c.querySelectorAll<HTMLButtonElement>('.rdesk-tile'));
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

  it('renders the empty state when there are no feeds', async () => {
    listIntakeConnectors = vi.fn(async () => []);
    setApi();
    const c = await mount();
    expect(c.querySelector('.rdesk-empty')!.textContent).toMatch(/No feeds yet/);
    expect(c.querySelector('.rdesk-tile')).toBeTruthy(); // add-dock still present
  });
});
