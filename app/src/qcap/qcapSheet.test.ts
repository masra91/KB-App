// @vitest-environment happy-dom
//
// Quick Capture sheet tests (SPEC-0038). Drives the sheet against a mocked `window.kbApi`, so the
// surface behaviors are asserted without Electron: clipboard prefill (QCAP-7), Enter → fire-and-forget
// capture (QCAP-1/2), non-modal confirm + auto-dismiss (QCAP-10/2), Esc/empty cancel, failure keeps
// the sheet (no silent loss).
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Mock } from 'vitest';
import { mountQuickCaptureSheet, QCAP_CONFIRM_MS } from './qcapSheet';
import type { KbApi, CaptureResult, QuickCaptureContext } from '../kb/types';

const OK: CaptureResult = { ok: true, ids: ['1'], captureBatch: 'b1', committed: true, message: 'Captured 1 item(s).' };
const flush = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
};

function setApi(
  opts: {
    capture?: CaptureResult;
    clipboard?: string;
    selection?: string | null;
    accessibility?: 'granted' | 'denied' | 'unsupported';
  } = {},
): void {
  (window as unknown as { kbApi: Partial<KbApi> }).kbApi = {
    quickCapture: vi.fn().mockResolvedValue(opts.capture ?? OK),
    quickCaptureClose: vi.fn().mockResolvedValue(undefined),
    openAccessibilitySettings: vi.fn().mockResolvedValue({ ok: true }),
    quickCaptureContext: vi.fn().mockResolvedValue({
      clipboard: opts.clipboard ?? '',
      selection: opts.selection ?? null,
      accessibility: opts.accessibility ?? 'unsupported',
    } as QuickCaptureContext),
  };
}
const api = () => (window as unknown as { kbApi: KbApi }).kbApi;
const enter = (ta: HTMLTextAreaElement, shift = false) =>
  ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', shiftKey: shift, bubbles: true, cancelable: true }));
const esc = (ta: HTMLTextAreaElement) =>
  ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));

describe('QuickCapture sheet (SPEC-0038)', () => {
  let root: HTMLElement;
  beforeEach(() => {
    root = document.createElement('div');
    document.body.appendChild(root);
  });
  afterEach(() => {
    root.remove();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('QCAP-7: pre-fills the field from the clipboard as a tagged "loaded" state', async () => {
    setApi({ clipboard: 'a thought from elsewhere' });
    mountQuickCaptureSheet(root);
    await flush();
    expect((root.querySelector('#qcapText') as HTMLTextAreaElement).value).toBe('a thought from elsewhere');
    expect((root.querySelector('#qcapClipTag') as HTMLElement).hidden).toBe(false); // "clipboard" tag shown
    expect(root.querySelector('.qcap-field')!.classList.contains('is-loaded')).toBe(true);
  });

  it('QCAP-7: editing the loaded text drops the clipboard tag (now typed material)', async () => {
    setApi({ clipboard: 'loaded' });
    mountQuickCaptureSheet(root);
    await flush();
    const ta = root.querySelector('#qcapText') as HTMLTextAreaElement;
    ta.value = 'loaded + my edit';
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    expect((root.querySelector('#qcapClipTag') as HTMLElement).hidden).toBe(true);
  });

  // --- Slice 2: selection capture + permission UX (QCAP-7/9) ---

  it('QCAP-7 (Slice 2): the focused-app selection takes precedence over the clipboard, tagged "selection"', async () => {
    setApi({ selection: 'the paragraph I had highlighted', clipboard: 'older clipboard text', accessibility: 'granted' });
    mountQuickCaptureSheet(root);
    await flush();
    expect((root.querySelector('#qcapText') as HTMLTextAreaElement).value).toBe('the paragraph I had highlighted');
    const tag = root.querySelector('#qcapClipTag') as HTMLElement;
    expect(tag.hidden).toBe(false);
    expect(tag.textContent).toBe('selection'); // names the source — not the clipboard
    expect(root.querySelector('.qcap-field')!.classList.contains('is-loaded')).toBe(true);
    expect((root.querySelector('#qcapAxEnable') as HTMLElement).hidden).toBe(true); // granted → no steer
  });

  it('QCAP-1/7 (Slice 2): Enter saves the SELECTION through the real capture path (surface=quick-capture)', async () => {
    setApi({ selection: 'capture this exact sentence', accessibility: 'granted' });
    mountQuickCaptureSheet(root);
    await flush();
    const ta = root.querySelector('#qcapText') as HTMLTextAreaElement;
    enter(ta); // prefilled + selected → one keystroke saves it
    await flush();
    expect(api().quickCapture as unknown as Mock).toHaveBeenCalledWith({ inputs: [{ kind: 'text', text: 'capture this exact sentence' }] });
  });

  it('QCAP-9 (Slice 2): a DENIED grant shows the steer-to-Settings affordance but still prefills the clipboard (graceful degrade)', async () => {
    setApi({ selection: null, clipboard: 'clipboard fallback', accessibility: 'denied' });
    mountQuickCaptureSheet(root);
    await flush();
    // The sheet is NOT dead: clipboard prefill still works (selection just wasn't available).
    expect((root.querySelector('#qcapText') as HTMLTextAreaElement).value).toBe('clipboard fallback');
    expect((root.querySelector('#qcapClipTag') as HTMLElement).textContent).toBe('clipboard');
    const ax = root.querySelector('#qcapAxEnable') as HTMLButtonElement;
    expect(ax.hidden).toBe(false); // the steer is offered
    ax.click();
    await flush();
    expect(api().openAccessibilitySettings as unknown as Mock).toHaveBeenCalled(); // steers to Settings, never a no-op
  });

  it('QCAP-9 (Slice 2): when selection-capture is unsupported, NO permission steer is shown (no false alarm)', async () => {
    setApi({ clipboard: 'x', accessibility: 'unsupported' });
    mountQuickCaptureSheet(root);
    await flush();
    expect((root.querySelector('#qcapAxEnable') as HTMLElement).hidden).toBe(true);
  });

  it('QCAP-7 (Slice 2): a granted grant with an empty selection falls back to the clipboard', async () => {
    setApi({ selection: null, clipboard: 'on the clipboard', accessibility: 'granted' });
    mountQuickCaptureSheet(root);
    await flush();
    expect((root.querySelector('#qcapText') as HTMLTextAreaElement).value).toBe('on the clipboard');
    expect((root.querySelector('#qcapClipTag') as HTMLElement).textContent).toBe('clipboard');
  });

  it('QCAP-1/2/10: Enter captures (fire-and-forget) then confirms + auto-dismisses', async () => {
    vi.useFakeTimers();
    setApi();
    mountQuickCaptureSheet(root);
    const ta = root.querySelector('#qcapText') as HTMLTextAreaElement;
    ta.value = 'call Steve re: Q3';
    enter(ta);
    await flush();

    expect(api().quickCapture as unknown as Mock).toHaveBeenCalledWith({ inputs: [{ kind: 'text', text: 'call Steve re: Q3' }] });
    expect(root.querySelector('#qcapNote')!.textContent).toBe('preserved'); // ember-acknowledge + patina tick
    expect(root.querySelector('.qcap-field')!.classList.contains('is-saving')).toBe(true);
    expect(api().quickCaptureClose as unknown as Mock).not.toHaveBeenCalled(); // confirm shows first

    vi.advanceTimersByTime(QCAP_CONFIRM_MS);
    expect(api().quickCaptureClose as unknown as Mock).toHaveBeenCalled(); // QCAP-2 auto-dismiss
  });

  it('the ghost "⏎ save" button submits too (mouse discoverability)', async () => {
    setApi();
    mountQuickCaptureSheet(root);
    (root.querySelector('#qcapText') as HTMLTextAreaElement).value = 'via button';
    root.querySelector<HTMLButtonElement>('#qcapSave')!.click();
    await flush();
    expect(api().quickCapture as unknown as Mock).toHaveBeenCalledWith({ inputs: [{ kind: 'text', text: 'via button' }] });
  });

  it('Shift+Enter does NOT submit (newline for multi-line capture)', async () => {
    setApi();
    mountQuickCaptureSheet(root);
    const ta = root.querySelector('#qcapText') as HTMLTextAreaElement;
    ta.value = 'line one';
    enter(ta, true);
    await flush();
    expect(api().quickCapture as unknown as Mock).not.toHaveBeenCalled();
  });

  it('Esc cancels: dismisses without capturing', async () => {
    setApi();
    mountQuickCaptureSheet(root);
    const ta = root.querySelector('#qcapText') as HTMLTextAreaElement;
    ta.value = 'unsaved';
    esc(ta);
    await flush();
    expect(api().quickCapture as unknown as Mock).not.toHaveBeenCalled();
    expect(api().quickCaptureClose as unknown as Mock).toHaveBeenCalled();
  });

  it('empty + Enter is a frictionless cancel (nothing captured)', async () => {
    setApi();
    mountQuickCaptureSheet(root);
    const ta = root.querySelector('#qcapText') as HTMLTextAreaElement;
    ta.value = '   ';
    enter(ta);
    await flush();
    expect(api().quickCapture as unknown as Mock).not.toHaveBeenCalled();
    expect(api().quickCaptureClose as unknown as Mock).toHaveBeenCalled();
  });

  it('a failed capture keeps the sheet open (no silent loss) and shows the reason', async () => {
    vi.useFakeTimers();
    setApi({ capture: { ok: false, ids: [], captureBatch: null, committed: false, message: 'No active knowledge base.' } });
    mountQuickCaptureSheet(root);
    const ta = root.querySelector('#qcapText') as HTMLTextAreaElement;
    ta.value = 'keep me';
    enter(ta);
    await flush();
    const noteText = root.querySelector('#qcapNote')!.textContent ?? '';
    expect(noteText).toContain("couldn't save"); // held oxide notice with ⏎ retry
    expect(noteText).toContain('No active knowledge base.'); // the reason is still surfaced
    expect(root.querySelector('.qcap-field')!.classList.contains('is-error')).toBe(true);
    vi.advanceTimersByTime(QCAP_CONFIRM_MS * 2);
    expect(api().quickCaptureClose as unknown as Mock).not.toHaveBeenCalled(); // sheet stays so the thought survives
  });
});
