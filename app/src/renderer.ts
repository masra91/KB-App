// Renderer: Setup flow (SPEC-0009) → App Navigation Shell (SPEC-0017). Plain DOM —
// minimal UI, no framework. On launch it asks main for state and shows either the
// Setup wizard (no KB yet — a full-screen pre-shell gate, SHELL-9) or the navigation
// shell (KB loaded; Capture is the default view, SHELL-4).
import './index.css';
import type { PathInspection } from './kb/types';
import { esc, baseName } from './shell/html';
import { mountShell } from './shell/shell';

const root = document.getElementById('app')!;

let chosenPath: string | null = null;
let inspection: PathInspection | null = null;

function mark(ok: boolean, warnIfFalse = false): string {
  return ok ? '✅' : warnIfFalse ? '⚠️' : '❌';
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
    mountShell(root, chosenPath, res.vaultConfig.name);
    return;
  }
  document.getElementById('result')!.innerHTML = `<p class="error">${esc(res.message)}</p>`;
  btn.disabled = false;
  btn.textContent = 'Create KB';
}

async function init(): Promise<void> {
  const state = await window.kbApi.getState();
  if (state.activeVaultPath && state.vaultConfig) {
    mountShell(root, state.activeVaultPath, state.vaultConfig.name);
  } else {
    renderSetup();
  }
}

void init();
