// Quick Capture sheet (SPEC-0038, visual = DESIGN-QCAP "the intake slot"). The frictionless global
// capture surface the menubar agent summons. Reuses the single renderer bundle via the `#qcap` route
// (shared preload `kbApi`), plain DOM, talks ONLY to `window.kbApi` → fully testable in happy-dom.
//
// It is NOT a generic capture box (the most-summoned surface — GATE-1 anti-generic): a flat-ink
// instrument slot built on the WS2 design-system language — a hero EditableField (`.viz-field__input
// --multiline`) on `--viz-field` ground, a top `--viz-ember` "live" hairline, keyboard-first. Flow:
// the focused-app SELECTION (Slice 2, QCAP-7) — or the clipboard — prefills as a tagged "loaded" state
// → Enter saves onto the SPEC-0013 path (fire-and-forget, CAPTURE-2, surface=quick-capture) → the rule
// takes `--viz-ember` + a `--viz-patina` `preserved` tick (QCAP-10) → auto-dismiss + focus-restore
// (QCAP-2); Esc cancels; a failure holds in `--viz-oxide` with `⏎ retry` and does NOT auto-dismiss (no
// silent loss). When selection-capture is DENIED (QCAP-9) a subtle steer-to-Settings affordance shows —
// the sheet still works clipboard-only (graceful degrade). All state is aria-live announced.
import { esc } from '../shell/html';

/** Auto-dismiss dwell after a successful save — within DESIGN-QCAP §10's 350–500ms band (QCAP-2/10). */
export const QCAP_CONFIRM_MS = 450;

export function mountQuickCaptureSheet(root: HTMLElement): void {
  root.innerHTML = `
    <div class="qcap-sheet viz-surface">
      <div class="qcap-head">
        <span class="qcap-mark viz-signage">Capture</span>
        <span class="qcap-head__meta">
          <span id="qcapClipTag" class="viz-chip qcap-cliptag" hidden>clipboard</span>
          <button id="qcapAxEnable" type="button" class="qcap-ax" hidden
            title="Turn on Accessibility to capture the selected text from any app">selection capture off — enable</button>
        </span>
      </div>
      <div class="viz-field qcap-field">
        <textarea id="qcapText" class="viz-field__input viz-field__input--multiline viz-focusable qcap-input"
          rows="3" aria-label="Quick capture"></textarea>
      </div>
      <div class="qcap-row">
        <span class="qcap-hint viz-numeric">⏎ save · ⇧⏎ newline · esc dismiss</span>
        <span id="qcapNote" class="qcap-note viz-numeric" role="status" aria-live="assertive"></span>
        <button id="qcapSave" type="button" class="viz-btn viz-btn--ghost qcap-save">⏎ save</button>
      </div>
    </div>`;

  const field = root.querySelector('.qcap-field') as HTMLElement;
  const ta = root.querySelector('#qcapText') as HTMLTextAreaElement;
  const note = root.querySelector('#qcapNote') as HTMLElement;
  const clipTag = root.querySelector('#qcapClipTag') as HTMLElement;
  const axEnable = root.querySelector('#qcapAxEnable') as HTMLButtonElement;

  // QCAP-7 (Slice 2): pre-fill as a "loaded" state — the focused-app SELECTION takes precedence over the
  // clipboard ("save what I'm looking at" is one gesture), tagged by source + selected so Enter saves it
  // in one stroke; editing/clearing drops the tag (it's now typed material). QCAP-9: a denied grant
  // surfaces the subtle steer-to-Settings affordance, but the clipboard prefill above still works
  // (graceful degrade — selection just isn't available).
  void window.kbApi
    .quickCaptureContext()
    .then((ctx) => {
      const prefill =
        ctx.selection && ctx.selection.length > 0
          ? { text: ctx.selection, source: 'selection' }
          : ctx.clipboard && ctx.clipboard.length > 0
            ? { text: ctx.clipboard, source: 'clipboard' }
            : null;
      if (prefill && ta.value.length === 0) {
        ta.value = prefill.text;
        ta.select();
        clipTag.textContent = prefill.source; // 'selection' | 'clipboard' — names where the text came from
        clipTag.hidden = false;
        field.classList.add('is-loaded');
      }
      // QCAP-9: only when the OS could grant selection-capture but hasn't — never on unsupported platforms.
      if (ctx.accessibility === 'denied') axEnable.hidden = false;
    })
    .catch(() => {});

  // QCAP-9: steer to System Settings → Privacy & Security → Accessibility (the SPEC-0034 pattern); the
  // main process opens the pane (with a fallback) — never a dead-end. The sheet keeps working meanwhile.
  axEnable.addEventListener('click', () => void window.kbApi.openAccessibilitySettings());

  ta.addEventListener('input', () => {
    if (!clipTag.hidden) {
      clipTag.hidden = true;
      field.classList.remove('is-loaded');
    }
    note.textContent = ''; // a fresh edit clears a prior failure notice
    note.className = 'qcap-note viz-numeric';
  });

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
      // QCAP-10: the rule takes ember + a patina `preserved` tick, then auto-dismiss (the line took it).
      field.classList.add('is-saving');
      note.textContent = 'preserved';
      note.className = 'qcap-note viz-numeric viz-state-settled';
      setTimeout(() => void window.kbApi.quickCaptureClose(), QCAP_CONFIRM_MS); // QCAP-2 auto-dismiss
    } else {
      // Failure HOLDS in oxide with ⏎ retry — never auto-dismisses, so a lost capture can't be missed.
      field.classList.add('is-error');
      note.textContent = `couldn't save — ⏎ retry${res.message ? ` (${esc(res.message)})` : ''}`;
      note.className = 'qcap-note viz-numeric viz-state-error';
    }
  };

  root.querySelector('#qcapSave')!.addEventListener('click', () => void submit());
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
