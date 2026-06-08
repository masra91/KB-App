// Quick Capture sheet (SPEC-0038) — the lightweight, frictionless capture surface the menubar agent
// summons. Reuses the single renderer bundle via the `#qcap` route (no separate Vite entry), so it
// shares the preload `kbApi`. Plain DOM, talks ONLY to `window.kbApi`, so it's fully testable in
// happy-dom. Behavior: prefill from clipboard (QCAP-7) → Enter saves onto the SPEC-0013 path (fire-
// and-forget, CAPTURE-2) → non-modal "saved" (QCAP-10) → auto-dismiss + focus-restore (QCAP-2);
// Esc cancels. The capture itself adds no preservation logic — it's surface=quick-capture (QCAP-1/5).
import { esc } from '../shell/html';

/** How long the "saved" confirmation shows before the sheet auto-dismisses (QCAP-2/10). */
export const QCAP_CONFIRM_MS = 600;

export function mountQuickCaptureSheet(root: HTMLElement): void {
  root.innerHTML = `
    <div class="qcap-sheet">
      <textarea id="qcapText" class="qcap-input" rows="3"
        placeholder="Capture a thought…"></textarea>
      <div class="qcap-row">
        <span class="qcap-hint muted">Enter to save · Shift+Enter for a newline · Esc to cancel</span>
        <span id="qcapNote" class="qcap-note muted" aria-live="polite"></span>
      </div>
    </div>`;

  const ta = root.querySelector('#qcapText') as HTMLTextAreaElement;
  const note = root.querySelector('#qcapNote') as HTMLElement;

  // QCAP-7: pre-fill from the current clipboard and select it, so "save what I'm looking at" is a
  // single gesture (Enter saves it; typing replaces it). Best-effort — never block the sheet on it.
  void window.kbApi
    .quickCaptureContext()
    .then((ctx) => {
      if (ctx.clipboard && ta.value.length === 0) {
        ta.value = ctx.clipboard;
        ta.select();
      }
    })
    .catch(() => {});

  ta.focus();

  const cancel = (): void => {
    void window.kbApi.quickCaptureClose(); // QCAP-2: dismiss + restore prior-app focus
  };

  const submit = async (): Promise<void> => {
    const text = ta.value;
    if (text.trim().length === 0) {
      cancel(); // nothing to save → frictionless cancel, never a stuck empty sheet
      return;
    }
    // QCAP-2 fast-out: capture returns on preserve+commit, never blocking on Enrich (CAPTURE-2).
    const res = await window.kbApi.quickCapture({ inputs: [{ kind: 'text', text }] });
    if (res.ok) {
      note.textContent = '✓ Saved'; // QCAP-10: brief, non-modal confirmation
      setTimeout(() => void window.kbApi.quickCaptureClose(), QCAP_CONFIRM_MS); // QCAP-2: auto-dismiss
    } else {
      // Keep the sheet open on failure so the thought is never silently lost.
      note.textContent = `⚠️ ${esc(res.message)}`;
    }
  };

  ta.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      cancel();
      return;
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void submit();
    }
  });
}
