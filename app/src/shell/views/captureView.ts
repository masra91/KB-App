// Capture view (SPEC-0013) relocated into the navigation shell (SPEC-0017 SHELL-3), extended
// for Rich Ingestion (SPEC-0040 RICHIN): rich/formatted paste → Markdown (keeping the original
// clipboard verbatim), multi-file drag, pasted images, a size-aware manifest, and a soft
// large-capture warning. RICHIN-9: this only enriches the *composer surface* + the capture-time
// text→Markdown step — the inbox→commit→archive preservation spine is untouched.
import { esc } from '../html';
import { mountPermissionGate } from '../permissionGate';
import { interpretPaste } from '../../kb/richText';
import type { CaptureInput } from '../../kb/types';

// Soft thresholds (RICHIN-11): warn, never block. Preservation stays in-vault at any size.
const LARGE_TEXT_BYTES = 1 * 1024 * 1024; // ~1 MB pasted text
const LARGE_FILE_BYTES = 25 * 1024 * 1024; // ~25 MB file

// View-local state. The shell mounts each view once and toggles visibility, so this
// state (and the in-progress textarea) survives switching away and back (SHELL-8).
let stagedFiles: { name: string; data: Uint8Array }[] = [];
// The original clipboard HTML from the most recent rich paste, kept until capture so the
// verbatim sidecar can be preserved (RICHIN-2). Only attached when the textarea still holds
// exactly that pasted Markdown (a clean single rich paste).
let pendingPaste: { markdown: string; html: string } | null = null;
let statusTimer: ReturnType<typeof setInterval> | null = null;
let vaultPath = ''; // the active vault path (for the MACOS-7 Blocked recovery on a denied capture)
let vaultName = '';
// The window-level drop guard must only be installed once across (re)mounts.
let dropGuardInstalled = false;

function humanSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function renderStagedFiles(container: HTMLElement): void {
  const el = container.querySelector<HTMLElement>('#staged');
  if (!el) return;
  // RICHIN-6: per-item manifest — name · size, with a soft "large" flag (RICHIN-11), removable.
  el.innerHTML = stagedFiles
    .map((f, i) => {
      const big = f.data.byteLength > LARGE_FILE_BYTES ? ' <span class="warn">⚠️ large</span>' : '';
      return `<li>${esc(f.name)} <span class="muted">· ${humanSize(f.data.byteLength)}</span>${big} <button class="link" data-rm="${i}">remove</button></li>`;
    })
    .join('');
  el.querySelectorAll<HTMLButtonElement>('button[data-rm]').forEach((b) =>
    b.addEventListener('click', () => {
      stagedFiles.splice(Number(b.dataset.rm), 1);
      renderStagedFiles(container);
    }),
  );
}

function setNote(container: HTMLElement, text: string): void {
  const note = container.querySelector('#captureNote');
  if (note) note.textContent = text;
}

/** Add dropped files as staged units — one per file (RICHIN-4). Per-file isolation: a file that
 *  fails to read NEVER blocks or discards the others (RICHIN-4 / ORCH-12 spirit). */
async function addDroppedFiles(container: HTMLElement, files: FileList): Promise<void> {
  const failed: string[] = [];
  for (const file of Array.from(files)) {
    try {
      stagedFiles.push({ name: file.name, data: new Uint8Array(await file.arrayBuffer()) });
    } catch {
      failed.push(file.name || 'a file');
    }
  }
  renderStagedFiles(container);
  if (failed.length) setNote(container, `⚠️ Couldn't read ${failed.join(', ')} — other items still staged.`);
}

/** Stage a single File (e.g. a pasted image, RICHIN-12), synthesizing a name when the clipboard
 *  gives none. One unit per file; shares the gesture's captureBatch with any text at capture. */
async function addStagedFile(container: HTMLElement, file: File): Promise<void> {
  let name = file.name;
  if (!name) {
    const ext = (file.type.split('/')[1] || 'png').replace(/[^a-z0-9]/gi, '');
    name = `pasted-image.${ext || 'png'}`;
  }
  try {
    stagedFiles.push({ name, data: new Uint8Array(await file.arrayBuffer()) });
    renderStagedFiles(container);
  } catch {
    setNote(container, `⚠️ Couldn't read the pasted image.`);
  }
}

/** The first image on the clipboard, if any (screenshot paste), else null (RICHIN-12). */
function imageFromClipboard(cd: DataTransfer): File | null {
  for (const it of cd.items ? Array.from(cd.items) : []) {
    if (it.kind === 'file' && it.type.startsWith('image/')) {
      const f = it.getAsFile();
      if (f) return f;
    }
  }
  for (const f of cd.files ? Array.from(cd.files) : []) {
    if (f.type.startsWith('image/')) return f;
  }
  return null;
}

function setOrInsert(ta: HTMLTextAreaElement, text: string): void {
  const start = ta.selectionStart ?? ta.value.length;
  const end = ta.selectionEnd ?? ta.value.length;
  ta.value = ta.value.slice(0, start) + text + ta.value.slice(end);
}

/** Paste handler (RICHIN-1/2/3/12): rich HTML → Markdown (original kept verbatim), a pasted
 *  image → file unit, and the "Keep formatting" toggle off → plain-text escape hatch. */
function onPaste(container: HTMLElement, ta: HTMLTextAreaElement, e: ClipboardEvent): void {
  const cd = e.clipboardData;
  if (!cd) return; // no clipboard payload — let the default happen
  const html = cd.getData('text/html');
  const plain = cd.getData('text/plain');

  // RICHIN-12: an image with no usable text → capture as a file (shares the batch with text).
  if (!html.trim() && !plain.trim()) {
    const img = imageFromClipboard(cd);
    if (img) {
      e.preventDefault();
      void addStagedFile(container, img);
      return;
    }
  }

  const keep = (container.querySelector('#keepFormatting') as HTMLInputElement | null)?.checked ?? true;
  const res = interpretPaste({ html, plain }, { plainOnly: !keep });
  if (!res.rich) {
    pendingPaste = null; // plain paste → let the browser insert the text; no sidecar
    return;
  }
  // Rich paste: insert the derived Markdown and remember the verbatim original for the sidecar.
  e.preventDefault();
  setOrInsert(ta, res.markdown);
  pendingPaste = { markdown: res.markdown, html: res.html! };
}

/** Soft, non-blocking warning when a capture exceeds a size threshold (RICHIN-11). */
function sizeWarning(text: string, files: { data: Uint8Array }[]): string {
  const big: string[] = [];
  if (new TextEncoder().encode(text).byteLength > LARGE_TEXT_BYTES) big.push('large text');
  if (files.some((f) => f.data.byteLength > LARGE_FILE_BYTES)) big.push('a large file');
  return big.length ? `⚠️ Captured ${big.join(' + ')} (preserved in full).` : '';
}

async function refreshStatus(container: HTMLElement): Promise<void> {
  const el = container.querySelector<HTMLElement>('#pipeline');
  if (!el) return;
  const s = await window.kbApi.pipelineStatus();
  const parts = [`📥 ${s.queueDepth} in queue`];
  if (s.processing) parts.push('archiving…');
  el.textContent = parts.join(' · ');
}

async function onCapture(container: HTMLElement): Promise<void> {
  const textArea = container.querySelector('#captureText') as HTMLTextAreaElement;
  const text = textArea.value;
  const inputs: CaptureInput[] = [];
  if (text.trim().length > 0) {
    // RICHIN-2: attach the original clipboard HTML only when the textarea still holds exactly the
    // pasted Markdown (a clean single rich paste) — so `original.html` is always a faithful source.
    const html = pendingPaste && pendingPaste.markdown.trim() === text.trim() ? pendingPaste.html : undefined;
    inputs.push({ kind: 'text', text, ...(html ? { html } : {}) });
  }
  for (const f of stagedFiles) inputs.push({ kind: 'file', name: f.name, data: f.data });

  const note = container.querySelector('#captureNote') as HTMLElement;
  if (inputs.length === 0) {
    note.textContent = 'Type something, paste, or drop a file first.';
    return;
  }

  const warn = sizeWarning(text, stagedFiles);

  // Fire-and-forget (CAPTURE-2): clear immediately so the next capture can start.
  const res = await window.kbApi.capture({ inputs });
  if (res.ok) {
    textArea.value = '';
    stagedFiles = [];
    pendingPaste = null;
    renderStagedFiles(container);
    note.textContent = warn ? `✓ ${res.message} · ${warn}` : `✓ ${res.message}`;
  } else if (res.blocked && vaultPath) {
    // SPEC-0034 MACOS-7 / #56: the capture write hit a folder-permission denial — route to the Blocked
    // recovery (brass, actionable: Open System Settings + Retry) instead of a raw OS error. On grant +
    // Retry the gate re-mounts the capture view (the loop stays closed; no relaunch).
    mountPermissionGate(container, {
      vaultPath,
      folder: vaultPath,
      start: 'blocked',
      onGranted: () => mountCapture(container, vaultPath, vaultName),
    });
    return;
  } else {
    note.textContent = `⚠️ ${res.message}`;
  }
  void refreshStatus(container);
}

export function mountCapture(container: HTMLElement, vaultPathArg: string, name: string): void {
  vaultPath = vaultPathArg;
  vaultName = name;
  container.innerHTML = `
    <div class="card">
      <h1>📚 ${esc(name)}</h1>
      <p class="muted path">${esc(vaultPath)}</p>
      <textarea id="captureText" class="capture" rows="4"
        placeholder="Capture a thought… (fire and forget) — paste formatting and it's kept"></textarea>
      <label class="muted toggle"><input type="checkbox" id="keepFormatting" checked /> Keep formatting on paste</label>
      <div id="dropzone" class="dropzone">Drop files here to capture them</div>
      <ul id="staged" class="staged"></ul>
      <div class="row">
        <button id="capture" class="primary">Capture</button>
        <span id="captureNote" class="muted"></span>
      </div>
      <p id="pipeline" class="muted status"></p>
    </div>`;

  container.querySelector('#capture')!.addEventListener('click', () => void onCapture(container));

  const ta = container.querySelector('#captureText') as HTMLTextAreaElement;
  ta.addEventListener('paste', (e) => onPaste(container, ta, e as ClipboardEvent));

  const dz = container.querySelector('#dropzone') as HTMLElement;
  const stop = (e: Event) => {
    e.preventDefault();
    e.stopPropagation();
  };
  dz.addEventListener('dragover', (e) => {
    stop(e);
    dz.classList.add('over');
  });
  dz.addEventListener('dragleave', (e) => {
    stop(e);
    dz.classList.remove('over');
  });
  dz.addEventListener('drop', (e) => {
    stop(e);
    dz.classList.remove('over');
    const dt = (e as DragEvent).dataTransfer;
    if (dt?.files?.length) void addDroppedFiles(container, dt.files);
  });

  // Prevent the window from navigating when a file is dropped outside the zone.
  if (!dropGuardInstalled) {
    window.addEventListener('dragover', (e) => e.preventDefault());
    window.addEventListener('drop', (e) => e.preventDefault());
    dropGuardInstalled = true;
  }

  renderStagedFiles(container);
  void refreshStatus(container);
  if (statusTimer == null) statusTimer = setInterval(() => void refreshStatus(container), 1500);
}
