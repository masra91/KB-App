import { app, BrowserWindow } from 'electron';
import path from 'node:path';
import started from 'electron-squirrel-startup';
import { registerIpc, initPipeline } from './main/ipc';
import { stopPipeline } from './main/pipeline';
import { ensurePath } from './main/resolvePath';

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
  void initPipeline(); // resume archiving a previously-configured KB on launch
  createWindow();
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
