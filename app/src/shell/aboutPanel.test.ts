// @vitest-environment happy-dom
//
// About Vellum modal (#406 part-2 / SPEC-0057) — component tier. Asserts the identity hero renders, the
// version line resolves via the (defensive) RELEASE-6 IPC with an honest fallback (#160), and the modal
// mechanics (role=dialog/aria-modal, Esc + scrim + Close dismiss, focus into the dialog).
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mountAboutPanel } from './aboutPanel';

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

function setVersionApi(impl?: () => Promise<string>): void {
  (window as unknown as { kbApi: Record<string, unknown> }).kbApi = impl ? { getAppVersion: vi.fn(impl) } : {};
}

beforeEach(() => setVersionApi(async () => '1.2.3'));
afterEach(() => {
  document.querySelectorAll('.about-scrim').forEach((n) => n.remove());
});

describe('About panel (#406)', () => {
  it('renders the identity hero: dialog, Spectral wordmark, crystalline mark, gold rule, tagline', async () => {
    mountAboutPanel(document.body);
    const dlg = document.querySelector('.about-modal[role="dialog"]');
    expect(dlg).not.toBeNull();
    expect(dlg!.getAttribute('aria-modal')).toBe('true');
    expect(document.querySelector('.about-wordmark.viz-voice')?.textContent).toBe('Vellum');
    expect(document.querySelector('.about-mark svg')).not.toBeNull(); // crystalline lattice mark
    expect(document.querySelector('.about-rule')).not.toBeNull(); // the one rationed-gold note
    expect(document.querySelector('.about-tagline.viz-voice')).not.toBeNull();
  });

  it('renders the version (Plex Mono) from the RELEASE-6 IPC', async () => {
    mountAboutPanel(document.body);
    await flush();
    const v = document.querySelector('.about-version.viz-numeric');
    expect(v?.textContent).toBe('Vellum · v1.2.3');
  });

  it('honest fallback (#160): "Version unavailable" when the IPC is absent or throws — never blank/crash', async () => {
    setVersionApi(); // no getAppVersion
    mountAboutPanel(document.body);
    await flush();
    expect(document.querySelector('.about-version')?.textContent).toBe('Version unavailable');
    document.querySelector('.about-scrim')!.remove();

    setVersionApi(async () => { throw new Error('ipc down'); });
    mountAboutPanel(document.body);
    await flush();
    expect(document.querySelector('.about-version')?.textContent).toBe('Version unavailable');
  });

  it('focuses into the dialog on open (Close button)', async () => {
    mountAboutPanel(document.body);
    expect(document.activeElement).toBe(document.querySelector('.about-close'));
  });

  it('Close button dismisses the modal', async () => {
    mountAboutPanel(document.body);
    (document.querySelector('.about-close') as HTMLButtonElement).click();
    expect(document.querySelector('.about-scrim')).toBeNull();
  });

  it('Esc dismisses the modal', async () => {
    mountAboutPanel(document.body);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(document.querySelector('.about-scrim')).toBeNull();
  });

  it('a click on the scrim (outside the modal) dismisses; a click inside does not', async () => {
    mountAboutPanel(document.body);
    const scrim = document.querySelector('.about-scrim') as HTMLElement;
    // inside the modal — stays open
    (document.querySelector('.about-modal') as HTMLElement).dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    expect(document.querySelector('.about-scrim')).not.toBeNull();
    // on the scrim itself — dismiss
    scrim.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    expect(document.querySelector('.about-scrim')).toBeNull();
  });
});
