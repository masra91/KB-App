// Renderer: Setup flow (SPEC-0009) + Simple Capture panel (SPEC-0013). Plain DOM — minimal
// UI, no framework. On launch it asks main for state and shows either the capture panel
// (KB loaded) or the Setup wizard.
import './index.css';
import type { PathInspection, CaptureInput } from './kb/types';

const root = document.getElementById('app')!;

let chosenPath: string | null = null;
let inspection: PathInspection | null = null;

// Capture-panel state.
let stagedFiles: { name: string; data: Uint8Array }[] = [];
let statusTimer: ReturnType<typeof setInterval> | null = null;

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

function baseName(p: string): string {
  return p.split(/[\\/]/).filter(Boolean).pop() ?? 'My KB';
}

function mark(ok: boolean, warnIfFalse = false): string {
  return ok ? '✅' : warnIfFalse ? '⚠️' : '❌';
}

// --- Simple Capture panel (SPEC-0013) ---------------------------------------------------

function renderStagedFiles(): void {
  const el = document.getElementById('staged');
  if (!el) return;
  el.innerHTML = stagedFiles
    .map((f, i) => `<li>${esc(f.name)} <button class="link" data-rm="${i}">remove</button></li>`)
    .join('');
  el.querySelectorAll<HTMLButtonElement>('button[data-rm]').forEach((b) =>
    b.addEventListener('click', () => {
      stagedFiles.splice(Number(b.dataset.rm), 1);
      renderStagedFiles();
    }),
  );
}

async function addDroppedFiles(files: FileList): Promise<void> {
  for (const file of Array.from(files)) {
    stagedFiles.push({ name: file.name, data: new Uint8Array(await file.arrayBuffer()) });
  }
  renderStagedFiles();
}

async function refreshStatus(): Promise<void> {
  const el = document.getElementById('pipeline');
  if (!el) return;
  const s = await window.kbApi.pipelineStatus();
  const parts = [`📥 ${s.queueDepth} in queue`];
  if (s.processing) parts.push('archiving…');
  el.textContent = parts.join(' · ');
}

async function onCapture(): Promise<void> {
  const textArea = document.getElementById('captureText') as HTMLTextAreaElement;
  const inputs: CaptureInput[] = [];
  if (textArea.value.trim().length > 0) inputs.push({ kind: 'text', text: textArea.value });
  for (const f of stagedFiles) inputs.push({ kind: 'file', name: f.name, data: f.data });

  const note = document.getElementById('captureNote')!;
  if (inputs.length === 0) {
    note.textContent = 'Type something or drop a file first.';
    return;
  }

  // Fire-and-forget (CAPTURE-2): clear immediately so the next capture can start.
  const res = await window.kbApi.capture({ inputs });
  if (res.ok) {
    textArea.value = '';
    stagedFiles = [];
    renderStagedFiles();
    note.textContent = `✓ ${res.message}`;
  } else {
    note.textContent = `⚠️ ${res.message}`;
  }
  void refreshStatus();
}

function renderLoaded(vaultPath: string, name: string): void {
  root.innerHTML = `
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

  document.getElementById('capture')!.addEventListener('click', () => void onCapture());

  const dz = document.getElementById('dropzone')!;
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
    if (dt?.files?.length) void addDroppedFiles(dt.files);
  });
  // Prevent the window from navigating when a file is dropped outside the zone.
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => e.preventDefault());

  stagedFiles = [];
  renderStagedFiles();
  void refreshStatus();
  if (statusTimer == null) statusTimer = setInterval(() => void refreshStatus(), 1500);
}

function renderSetup(): void {
  root.innerHTML = `
    <div class="card">
      <h1>Set up your Knowledge Base</h1>
      <p class="muted">
        Choose a folder to hold your KB. It becomes a git-versioned vault you can also
        open directly in Obsidian.
      </p>
      <button id="choose" class="primary">Choose folder…</button>
      <div id="details"></div>
    </div>`;
  document.getElementById('choose')!.addEventListener('click', onChoose);
}

async function onChoose(): Promise<void> {
  const p = await window.kbApi.pickFolder();
  if (!p) return;
  chosenPath = p;
  inspection = await window.kbApi.inspect(p);
  renderDetails();
}

function renderDetails(): void {
  if (!inspection) return;
  const ins = inspection;
  document.getElementById('details')!.innerHTML = `
    <p class="path">${esc(ins.path)}</p>
    <ul class="checks">
      <li>${mark(ins.gitInstalled)} git installed</li>
      <li>${mark(ins.isGitRepo)} git repository ${ins.isGitRepo ? '' : '<span class="muted">(will initialize)</span>'}</li>
      <li>${mark(ins.copilot.available, true)} Copilot &mdash; <span class="muted">${esc(ins.copilot.detail)}</span></li>
      ${ins.alreadyKb ? '<li>⚠️ This folder already contains a KB-App config (will be reused).</li>' : ''}
    </ul>
    <label class="field">Name<input id="name" value="${esc(baseName(ins.path))}" /></label>
    <label class="checkbox"><input type="checkbox" id="initGit" checked /> Initialize git repo if needed</label>
    ${ins.gitInstalled ? '' : '<p class="error">git is required. Install git, then choose the folder again.</p>'}
    <button id="create" class="primary" ${ins.gitInstalled ? '' : 'disabled'}>Create KB</button>
    <div id="result"></div>`;
  document.getElementById('create')?.addEventListener('click', onCreate);
}

async function onCreate(): Promise<void> {
  if (!chosenPath) return;
  const name = (document.getElementById('name') as HTMLInputElement | null)?.value;
  const initGit = (document.getElementById('initGit') as HTMLInputElement | null)?.checked ?? true;
  const btn = document.getElementById('create') as HTMLButtonElement;
  btn.disabled = true;
  btn.textContent = 'Creating…';

  const res = await window.kbApi.create({ path: chosenPath, name, initGitIfNeeded: initGit });

  if (res.ok && res.vaultConfig) {
    renderLoaded(chosenPath, res.vaultConfig.name);
    return;
  }
  document.getElementById('result')!.innerHTML = `<p class="error">${esc(res.message)}</p>`;
  btn.disabled = false;
  btn.textContent = 'Create KB';
}

async function init(): Promise<void> {
  const state = await window.kbApi.getState();
  if (state.activeVaultPath && state.vaultConfig) {
    renderLoaded(state.activeVaultPath, state.vaultConfig.name);
  } else {
    renderSetup();
  }
}

void init();
