// Renderer: Setup flow (SPEC-0009) → App Navigation Shell (SPEC-0017). Plain DOM —
// minimal UI, no framework. On launch it asks main for state and shows either the
// Setup wizard (no KB yet — a full-screen pre-shell gate, SHELL-9) or the navigation
// shell (KB loaded; Capture is the default view, SHELL-4).
// Bundled design-system fonts (SPEC-0033 DESIGN-7) — self-hosted @fontsource faces (pinned, OFL, no
// CDN) backing the `--viz-font-*` roles. Saira Condensed SemiBold (signage) + IBM Plex Mono 400/500
// (tabular numerics) + IBM Plex Sans 400 (body). Imported before the design system so @font-face is live.
import '@fontsource/saira-condensed/600.css';
import '@fontsource/ibm-plex-mono/400.css';
import '@fontsource/ibm-plex-mono/500.css';
import '@fontsource/ibm-plex-sans/400.css';
import './shell/design-system.css'; // shared visual foundation — tokens/type-roles/primitives/motion
import './shell/views/theLine.css'; // SPEC-0032 "The Line" surface — pipeline-visualization Status view
import './shell/permissionGate.css'; // SPEC-0034 MACOS-7 "Asking for the keys" — folder-permission UX
import './shell/views/showcase.css'; // DESIGN-SHOWCASE — dev-only primitive gallery layout (?showcase)
import './qcap/qcap.css'; // SPEC-0038 QCAP — the frictionless quick-capture sheet (#qcap route)
import './index.css';
import type { PathInspection, RendererErrorReport } from './kb/types';
import { esc, baseName } from './shell/html';
import { mountShell } from './shell/shell';
import { mountShowcase } from './shell/views/showcaseView';
import { mountQuickCaptureSheet } from './qcap/qcapSheet';
import { mountPermissionGate, icloudNoteHtml } from './shell/permissionGate';
import { isLocalTccProtected, isICloudVault } from './kb/permissions';

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
    ${
      isICloudVault(ins.tccProtectedDir)
        ? // iCloud is detect-warn-only (v1, MACOS-2): a calm, non-blocking note — not a steer-away.
          icloudNoteHtml()
        : ins.tccProtectedDir
          ? `<p class="warning">⚠️ This folder is inside your <strong>${esc(ins.tccProtectedDir)}</strong>, a macOS-protected location. KB-App's background tasks (git, Copilot) can be silently blocked there — captures may never finish processing. <strong>Pick a folder outside ${esc(ins.tccProtectedDir)}</strong> (e.g. one directly in your home directory) to be safe.</p>`
          : ''
    }
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
    const path = chosenPath;
    const vaultName = res.vaultConfig.name;
    // SPEC-0034 MACOS-7: for a vault in a LOCAL TCC-gated folder (Documents/Desktop/Downloads), gate the
    // first run behind the pre-prompt — Continue performs a probe write so the macOS grant dialog fires
    // coupled to our explanation (MACOS-5), and a denial drops to the Blocked recovery. Other locations
    // (incl. iCloud, which is detect-warn-only) proceed straight to the shell.
    if (isLocalTccProtected(inspection?.tccProtectedDir ?? null)) {
      mountPermissionGate(root, { vaultPath: path, folder: path, onGranted: () => mountShell(root, path, vaultName) });
      return;
    }
    mountShell(root, path, vaultName);
    return;
  }
  document.getElementById('result')!.innerHTML = `<p class="error">${esc(res.message)}</p>`;
  btn.disabled = false;
  btn.textContent = 'Create KB';
}

/** Dev-only design-system showcase gate (design-system-showcase.md): reachable ONLY via `?showcase`
 *  or `#showcase` — never in the user nav. Static, no IPC/pipeline/`active` dependency, so it renders
 *  on any (or no) vault — that's what lets the HYBRID visual snapshot pin the primitives directly
 *  (the parked #233 needed a git+pipeline harness). The e2e drives it by setting the hash post-boot. */
function showcaseRequested(): boolean {
  return new URLSearchParams(location.search).has('showcase') || location.hash.toLowerCase().includes('showcase');
}

/** SPEC-0038 QCAP: the menubar agent loads this same renderer with `#qcap` for the capture sheet. */
function qcapRequested(): boolean {
  return location.hash.toLowerCase() === '#qcap';
}

// SPEC-0030 OBS-18 (renderer): forward uncaught renderer errors / unhandled rejections to the main
// app-log (the isolated renderer can't write it itself). Fire-and-forget; its own failures swallowed.
function installRendererErrorForwarding(): void {
  const report = (r: RendererErrorReport): void => {
    void window.kbApi?.reportRendererError?.(r).catch(() => {});
  };
  window.addEventListener('error', (e: ErrorEvent) => {
    report({
      kind: 'error',
      message: e.message || String((e.error as Error | undefined)?.message ?? 'renderer error'),
      ...(e.filename ? { source: e.filename } : {}),
      ...(typeof e.lineno === 'number' ? { line: e.lineno } : {}),
      ...(typeof e.colno === 'number' ? { col: e.colno } : {}),
      ...((e.error as Error | undefined)?.stack ? { stack: String((e.error as Error).stack) } : {}),
    });
  });
  window.addEventListener('unhandledrejection', (e: PromiseRejectionEvent) => {
    const reason: unknown = e.reason;
    report({
      kind: 'unhandledrejection',
      message: reason instanceof Error ? reason.message : String(reason),
      ...(reason instanceof Error && reason.stack ? { stack: reason.stack } : {}),
    });
  });
}

async function init(): Promise<void> {
  installRendererErrorForwarding(); // OBS-18: always on, before any route (showcase/qcap/shell)
  if (qcapRequested()) {
    mountQuickCaptureSheet(root);
    return;
  }
  if (showcaseRequested()) {
    mountShowcase(root);
    return;
  }
  const state = await window.kbApi.getState();
  if (state.activeVaultPath && state.vaultConfig) {
    mountShell(root, state.activeVaultPath, state.vaultConfig.name);
  } else {
    renderSetup();
  }
}

// Let the showcase be reached after boot (the e2e sets `location.hash = 'showcase'` — no reload, no IPC).
window.addEventListener('hashchange', () => {
  if (showcaseRequested()) mountShowcase(root);
});

void init();
