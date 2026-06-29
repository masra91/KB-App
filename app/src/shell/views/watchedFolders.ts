// Watched folders (WATCH-9) — a self-contained, mountable section: the roster of folders Vellum watches
// + the add-folder dock. SPEC-0060 IA: this lives under SETTINGS now (moved out of Connectors, which
// keeps the outward Feeds). It owns its OWN container-scoped render so a folder change re-paints just
// this section (not the host view) — that's why it's a module, not inlined into Settings' monolith.
//
// Built on the shared `.rdesk-*` manage-view primitives + the `.src-mark`/`.src-arm` tokenized marks
// (now un-scoped so they style here too). All folder ops are non-destructive: the copy into the library
// happens first; a drained original is MOVED (never deleted) to `.kb-processed`. Risky-ish steps (start
// draining, remove) reveal an inline confirm (PANEL-7); local read changes apply directly.
import { esc, emptyState } from '../html';
import { withTimeout, renderLoadError } from '../loadGuard';
import type { WatchFolderView } from '../../kb/types';

/** A tokenized type mark (#184): a hue-carrying glyph, not an emoji; the hue rides the mark, label ink. */
function folderMark(): string {
  return `<span class="src-mark src-mark--folder" aria-hidden="true">▣</span>`;
}

/** The armed-state switch (#184): a hue dot + a sentence-case ink label (sprout=watching, slate=enabled-idle, faint=paused). */
function armSwitch(armed: boolean, active: boolean, label: string): string {
  const tone = armed ? (active ? 'src-arm-dot--active' : 'src-arm-dot--on') : 'src-arm-dot--off';
  return `<button type="button" class="rdesk-arm watch-arm src-arm viz-focusable" role="switch" aria-checked="${armed ? 'true' : 'false'}"><span class="src-arm-dot ${tone}" aria-hidden="true">●</span> ${esc(label)}</button>`;
}

function slugifyId(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

/** Principal-facing labels for a watched-folder's last event (never the raw audit slug). */
const WATCH_OUTCOME_LABELS: Record<string, string> = {
  'watch-ingested': 'brought in a file',
  'watch-no-new': 'no new files',
  'watch-refused': 'a file was skipped',
  'watch-failed': 'a file could not be read',
};
function watchOutcomeLabel(kind: string): string {
  return WATCH_OUTCOME_LABELS[kind] ?? kind.replace(/-/g, ' ');
}

/** A watched folder's last-event report line — typed, jargon-free (never the raw audit slug). */
function watchReportLine(w: WatchFolderView): string {
  if (w.enabled && !w.watching) return `<span class="rdesk-report" data-state="paused"><span class="rdesk-report-flag" aria-hidden="true">◑</span> enabled, but not watching — the folder may be unavailable</span>`;
  if (!w.lastEvent) return `<span class="rdesk-report" data-state="never"><span class="rdesk-report-flag" aria-hidden="true">·</span> ${w.watching ? 'watching — nothing seen yet' : 'paused'}</span>`;
  const le = w.lastEvent;
  const when = new Date(le.ts).toLocaleString();
  const detail = le.path ? ` — ${esc(le.path)}` : '';
  return `<span class="rdesk-report" data-state="${le.kind === 'watch-failed' ? 'failed' : 'ok'}"><span class="rdesk-report-flag" aria-hidden="true">${le.kind === 'watch-failed' ? '✕' : '✓'}</span> last ${esc(when)} · ${esc(watchOutcomeLabel(le.kind))}${detail}</span>`;
}

function watchStrip(w: WatchFolderView): string {
  const armed = w.enabled;
  const armLabel = armed ? (w.watching ? 'Watching' : 'Enabled') : 'Paused';
  const ignore = w.ignoreGlobs.length ? ` · ignoring ${esc(w.ignoreGlobs.join(', '))}` : '';
  return `
    <li class="rdesk-strip ag-card" data-watch-id="${esc(w.id)}" data-armed="${armed ? 'true' : 'false'}">
      <div class="rdesk-strip-head">
        <span class="rdesk-id viz-numeric">${esc(w.label)}</span>
        ${armSwitch(armed, w.watching, armLabel)}
      </div>
      <div class="rdesk-identity">
        <span class="rdesk-kind src-kind">${folderMark()} <span class="path">${esc(w.folderPath)}</span></span>
      </div>
      <div class="rdesk-config">
        <span class="rdesk-reach-ro viz-body">scope ${esc(w.scope)} · ${esc(w.sensitivity)}${ignore}</span>
        <div class="watch-rules rdesk-reach" role="group" aria-label="Folder rules">
          <button type="button" class="viz-btn watch-recursive" role="switch" aria-checked="${w.recursive ? 'true' : 'false'}">Include subfolders: ${w.recursive ? 'on' : 'off'}</button>
          <label class="rdesk-field viz-field watch-depth-wrap"${w.recursive ? '' : ' hidden'}><span class="rdesk-field-label viz-field__label viz-signage">depth</span><input type="number" class="watch-depth viz-field__input viz-field__input--numeric viz-focusable" min="0" max="32" step="1" inputmode="numeric" value="${esc(String(w.maxDepth))}" aria-label="Subfolder depth limit" /></label>
          <button type="button" class="viz-btn watch-consume" role="switch" aria-checked="${w.leaveOriginals ? 'true' : 'false'}">Leave originals in place: ${w.leaveOriginals ? 'on' : 'off'}</button>
        </div>
      </div>
      <div class="rdesk-footer viz-ruled">
        ${watchReportLine(w)}
        <button type="button" class="viz-btn watch-remove">Remove</button>
      </div>
      <div class="rdesk-confirm viz-confirm watch-confirm" hidden>
        <p class="rdesk-confirm-msg viz-confirm__msg watch-confirm-msg viz-body"></p>
        <button type="button" class="viz-btn watch-confirm-cancel">Cancel</button>
        <button type="button" class="viz-btn viz-btn--danger watch-confirm-go">Remove</button>
      </div>
      <div class="rdesk-confirm viz-confirm watch-consume-confirm" hidden>
        <p class="rdesk-confirm-msg viz-confirm__msg watch-consume-confirm-msg viz-body"></p>
        <button type="button" class="viz-btn watch-consume-confirm-cancel">Cancel</button>
        <button type="button" class="viz-btn watch-consume-confirm-go">Start draining</button>
      </div>
      <p class="rdesk-status watch-status viz-body" role="status" aria-live="polite"></p>
    </li>`;
}

/** The add-folder dock — a folder picker (the OS dialog), not a free-text path. The backend loop-guard
 *  validates the picked path; a refusal surfaces here cleanly (no client-side bypass, WATCH-6/10). */
function watchAddDock(): string {
  return `
    <div class="rdesk-add">
      <span class="rdesk-add-head viz-voice">Watch a folder</span>
      <div class="rdesk-tiles" role="group" aria-label="Add a watched folder">
        <button type="button" class="rdesk-tile watch-add-pick viz-no-chrome viz-focusable"><span class="rdesk-tile-glyph">${folderMark()}</span><span class="rdesk-tile-label">Choose a folder…</span></button>
      </div>
      <p class="watch-add-hint rdesk-add-hint viz-body">A watched folder <strong>drains like an inbox</strong> — after each file is brought in, the original moves to “.kb-processed/” inside the folder (a copy is kept in your library first; files are never deleted), so the folder empties. Switch any folder to <em>leave originals in place</em> to keep the source untouched.</p>
      <p class="watch-add-status rdesk-add-status viz-body" role="status" aria-live="polite"></p>
    </div>`;
}

/** Mount the Watched-folders section into `container` (Settings hosts it). Owns its own re-render: a
 *  folder change re-fetches + re-paints just this container, leaving the rest of the host view intact. */
export async function mountWatchedFolders(container: HTMLElement): Promise<void> {
  await render(container);
}

async function render(container: HTMLElement): Promise<void> {
  // ENG-15/16: if the watch capability isn't present on this host/client, degrade calm (empty) rather
  // than a scary retry-error. A capability that IS present but fails still surfaces the retry (below).
  if (typeof window.kbApi?.listWatchFolders !== 'function') {
    container.innerHTML = '';
    return;
  }
  let folders: WatchFolderView[];
  try {
    // #145: bound the read so a hung IPC can't strand a spinner.
    folders = await withTimeout(window.kbApi.listWatchFolders());
  } catch {
    renderLoadError(container, '', () => void render(container));
    return;
  }
  const roster = folders.length
    ? `<ul class="rdesk-roster">${folders.map(watchStrip).join('')}</ul>`
    : emptyState({ compact: true, title: 'No watched folders yet.', body: 'Add one below — files dropped in are kept verbatim as sources.' });
  container.innerHTML = `${roster}${watchAddDock()}`;
  wire(container, folders);
}

function wire(container: HTMLElement, folders: WatchFolderView[]): void {
  const byId = new Map(folders.map((w) => [w.id, w]));

  // Add a folder — OS picker → setWatchFolder. The backend loop-guard refuses an unsafe path by NOT
  // persisting it (returns the unchanged list); we detect refusal by the folder's absence and surface a
  // clean reason — the client can never bypass the guard (WATCH-6/10).
  const pickBtn = container.querySelector<HTMLButtonElement>('.watch-add-pick');
  const addStatus = container.querySelector<HTMLElement>('.watch-add-status');
  pickBtn?.addEventListener('click', async () => {
    if (!addStatus) return;
    addStatus.textContent = 'Choosing…';
    let folderPath: string | null;
    try {
      folderPath = await window.kbApi.pickFolder();
    } catch {
      addStatus.textContent = 'Could not open the folder chooser.';
      return;
    }
    if (!folderPath) {
      addStatus.textContent = '';
      return;
    }
    const id = slugifyId(folderPath.split(/[\\/]/).filter(Boolean).pop() ?? 'folder');
    addStatus.textContent = 'Adding…';
    try {
      const result = await window.kbApi.setWatchFolder({ id, folderPath, enabled: false });
      if (!result.some((w) => w.id === id)) {
        addStatus.textContent = `Couldn’t watch that folder — it can’t be inside your library (it would re-ingest itself).`;
        return;
      }
      await render(container);
    } catch {
      addStatus.textContent = 'Could not add that folder.';
    }
  });

  for (const li of Array.from(container.querySelectorAll<HTMLElement>('.rdesk-strip[data-watch-id]'))) {
    const id = li.dataset.watchId!;
    const current = byId.get(id)!;
    const armEl = li.querySelector<HTMLButtonElement>('.watch-arm')!;
    const removeBtn = li.querySelector<HTMLButtonElement>('.watch-remove')!;
    const confirm = li.querySelector<HTMLElement>('.watch-confirm')!;
    const confirmMsg = li.querySelector<HTMLElement>('.watch-confirm-msg')!;
    const confirmGo = li.querySelector<HTMLButtonElement>('.watch-confirm-go')!;
    const confirmCancel = li.querySelector<HTMLButtonElement>('.watch-confirm-cancel')!;
    const status = li.querySelector<HTMLElement>('.watch-status')!;

    // Enable/disable — watching a folder is a LOCAL, non-destructive read (no egress) → applies directly.
    armEl.addEventListener('click', async () => {
      status.textContent = 'Saving…';
      try {
        await window.kbApi.setWatchFolder({ id, enabled: !current.enabled });
        await render(container);
      } catch {
        status.textContent = 'Could not save the change.';
      }
    });

    // Include-subfolders (WATCH-12) — widening a local read (no egress, no mutation) → applies directly.
    const recursiveEl = li.querySelector<HTMLButtonElement>('.watch-recursive');
    recursiveEl?.addEventListener('click', async () => {
      status.textContent = 'Saving…';
      try {
        await window.kbApi.setWatchFolder({ id, recursive: !current.recursive });
        await render(container);
      } catch {
        status.textContent = 'Could not save the change.';
      }
    });

    // Depth cap (WATCH-12) — steering a local read; clamp to [0,32] and apply on change.
    const depthEl = li.querySelector<HTMLInputElement>('.watch-depth');
    depthEl?.addEventListener('change', async () => {
      const n = Math.min(Math.max(0, Math.floor(Number(depthEl.value))), 32);
      if (!Number.isFinite(n)) {
        depthEl.value = String(current.maxDepth);
        return;
      }
      status.textContent = 'Saving…';
      try {
        await window.kbApi.setWatchFolder({ id, maxDepth: n });
        await render(container);
      } catch {
        status.textContent = 'Could not save the change.';
      }
    });

    // Drain / leave-originals (WATCH-16) — a watched folder DRAINS by default. Turning "leave originals"
    // OFF starts draining → MOVES future originals out (hard-to-undo) → confirmed. Turning it ON (keep the
    // source untouched) is safe → direct. Non-destructive either way (copy into the library happens first).
    const consumeEl = li.querySelector<HTMLButtonElement>('.watch-consume');
    const consumeConfirm = li.querySelector<HTMLElement>('.watch-consume-confirm')!;
    const consumeConfirmMsg = li.querySelector<HTMLElement>('.watch-consume-confirm-msg')!;
    const consumeConfirmGo = li.querySelector<HTMLButtonElement>('.watch-consume-confirm-go')!;
    const consumeConfirmCancel = li.querySelector<HTMLButtonElement>('.watch-consume-confirm-cancel')!;
    const applyDrain = async (drain: boolean): Promise<void> => {
      status.textContent = 'Saving…';
      try {
        await window.kbApi.setWatchFolder({ id, consume: drain });
        await render(container);
      } catch {
        status.textContent = 'Could not save the change.';
      }
    };
    consumeEl?.addEventListener('click', () => {
      if (current.leaveOriginals) {
        consumeConfirmMsg.textContent = `Start draining “${current.folderPath}”? After each file is imported its original moves into “.kb-processed” inside the folder (a copy is kept in your library first — files are never deleted), so the folder empties like an inbox.`;
        consumeConfirm.hidden = false;
      } else {
        void applyDrain(false);
      }
    });
    consumeConfirmGo.addEventListener('click', () => {
      consumeConfirm.hidden = true;
      void applyDrain(true);
    });
    consumeConfirmCancel.addEventListener('click', () => {
      consumeConfirm.hidden = true;
    });

    // Remove — confirm (it stops watching + forgets the folder; already-ingested sources stay).
    removeBtn.addEventListener('click', () => {
      confirmMsg.textContent = `Stop watching “${current.folderPath}”? Files already brought in stay in your library.`;
      confirm.hidden = false;
    });
    confirmGo.addEventListener('click', async () => {
      confirm.hidden = true;
      status.textContent = 'Removing…';
      try {
        await window.kbApi.removeWatchFolder(id);
        await render(container);
      } catch {
        status.textContent = 'Could not remove.';
      }
    });
    confirmCancel.addEventListener('click', () => {
      confirm.hidden = true;
    });
  }
}
