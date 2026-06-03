// Capture view (SPEC-0013) relocated into the navigation shell (SPEC-0017 SHELL-3).
// Behavior is unchanged from the original renderer panel; it is now mounted into a
// shell container instead of owning the whole window.
import { esc } from '../html';
import { mountPermissionGate } from '../permissionGate';
import type { CaptureInput } from '../../kb/types';

// View-local state. The shell mounts each view once and toggles visibility, so this
// state (and the in-progress textarea) survives switching away and back (SHELL-8).
let stagedFiles: { name: string; data: Uint8Array }[] = [];
let statusTimer: ReturnType<typeof setInterval> | null = null;
let vaultPath = ''; // the active vault path (for the MACOS-7 Blocked recovery on a denied capture)
let vaultName = '';
// The window-level drop guard must only be installed once across (re)mounts.
let dropGuardInstalled = false;

function renderStagedFiles(container: HTMLElement): void {
  const el = container.querySelector<HTMLElement>('#staged');
  if (!el) return;
  el.innerHTML = stagedFiles
    .map((f, i) => `<li>${esc(f.name)} <button class="link" data-rm="${i}">remove</button></li>`)
    .join('');
  el.querySelectorAll<HTMLButtonElement>('button[data-rm]').forEach((b) =>
    b.addEventListener('click', () => {
      stagedFiles.splice(Number(b.dataset.rm), 1);
      renderStagedFiles(container);
    }),
  );
}

async function addDroppedFiles(container: HTMLElement, files: FileList): Promise<void> {
  for (const file of Array.from(files)) {
    stagedFiles.push({ name: file.name, data: new Uint8Array(await file.arrayBuffer()) });
  }
  renderStagedFiles(container);
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
  const inputs: CaptureInput[] = [];
  if (textArea.value.trim().length > 0) inputs.push({ kind: 'text', text: textArea.value });
  for (const f of stagedFiles) inputs.push({ kind: 'file', name: f.name, data: f.data });

  const note = container.querySelector('#captureNote') as HTMLElement;
  if (inputs.length === 0) {
    note.textContent = 'Type something or drop a file first.';
    return;
  }

  // Fire-and-forget (CAPTURE-2): clear immediately so the next capture can start.
  const res = await window.kbApi.capture({ inputs });
  if (res.ok) {
    textArea.value = '';
    stagedFiles = [];
    renderStagedFiles(container);
    note.textContent = `✓ ${res.message}`;
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
        placeholder="Capture a thought… (fire and forget)"></textarea>
      <div id="dropzone" class="dropzone">Drop files here to capture them</div>
      <ul id="staged" class="staged"></ul>
      <div class="row">
        <button id="capture" class="primary">Capture</button>
        <span id="captureNote" class="muted"></span>
      </div>
      <p id="pipeline" class="muted status"></p>
    </div>`;

  container.querySelector('#capture')!.addEventListener('click', () => void onCapture(container));

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
