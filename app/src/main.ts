import { app, BrowserWindow } from 'electron';
import path from 'node:path';
import started from 'electron-squirrel-startup';
import { registerIpc, initPipeline } from './main/ipc';
import { stopPipeline, getActiveInstanceSettings } from './main/pipeline';
import { ensurePath } from './main/resolvePath';
import { createAppDevLog } from './kb/devlog';
import { QuickCaptureAgent } from './main/quickCaptureAgent';
import { electronQuickCaptureDeps } from './main/quickCaptureElectron';
import { setQuickCaptureAgent } from './main/quickCaptureService';

// Handle creating/removing shortcuts on Windows when installing/uninstalling.
if (started) {
  app.quit();
}

// The main process is the long-lived manager (SPEC-0010 STACK-2). For now it owns the
// IPC surface and a single window; the headless scheduler/agents grow from here.
const createWindow = () => {
  const mainWindow = new BrowserWindow({
    width: 880,
    height: 660,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
    },
  });

  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
    mainWindow.loadURL(MAIN_WINDOW_VITE_DEV_SERVER_URL);
  } else {
    mainWindow.loadFile(
      path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`),
    );
  }
};

// SPEC-0038 QCAP: the menubar agent owns the global hotkey + capture sheet, headlessly (QCAP-4) — it
// starts even before/without a main window. The hotkey applies the shipped default immediately; the
// per-Instance configured accelerator (QCAP-6) is applied once the pipeline resolves.
let qcapAgent: QuickCaptureAgent | null = null;
function startQuickCapture(): void {
  const deps = electronQuickCaptureDeps({
    onOpen: () => qcapAgent?.open(),
    onClose: () => qcapAgent?.close(),
  });
  qcapAgent = new QuickCaptureAgent(deps); // shipped default ⌥Space; conflict-aware + degrades (QCAP-9)
  setQuickCaptureAgent(qcapAgent);
  qcapAgent.start();
}

app.on('ready', async () => {
  // GUI launches (Finder/Dock/launchd) inherit a stripped PATH; recover the user's real
  // login-shell PATH first so spawned CLIs (Copilot, git) resolve like they do in a
  // terminal — otherwise detection + enrich silently fail in the packaged app (STACK-9).
  try {
    await ensurePath();
  } catch {
    // Best-effort: a PATH-resolution failure must never block startup.
  }
  registerIpc();
  // QCAP-3/4: bring up the menubar agent + global hotkey first, so quick capture is available even
  // headless (and even before a KB resumes — capture then reports "no active KB" honestly).
  startQuickCapture();
  // OBS-2/4: resume a previously-configured KB on launch. The app-level dev-log (userData) captures
  // a boot failure (e.g. worktree provision) that this fire-and-forget would otherwise swallow —
  // the silent-stall cause that motivated SPEC-0030.
  const appLog = createAppDevLog(app.getPath('userData'));
  void initPipeline()
    .then(async () => {
      // QCAP-6: apply the per-Instance configured hotkey once the active KB has loaded (conflict-aware).
      try {
        const s = await getActiveInstanceSettings();
        if (qcapAgent && s.quickCaptureAccelerator) qcapAgent.setAccelerator(s.quickCaptureAccelerator);
      } catch (err) {
        appLog.error('boot.qcap-accel-failed', { err });
      }
    })
    .catch((err) => appLog.error('boot.init-pipeline-failed', { err }));
  createWindow();
});

// Release the global hotkey on quit (Electron best practice — a left-registered accelerator lingers).
app.on('will-quit', () => {
  qcapAgent?.stop();
});

// CAPTURE-12 / ORCH-1: on macOS the app stays alive with no window open, so the
// orchestrator keeps draining the queue headlessly. Other platforms quit as usual.
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    stopPipeline();
    app.quit();
  }
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});
