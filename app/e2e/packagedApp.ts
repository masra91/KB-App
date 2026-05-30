// Locate the packaged Electron executable produced by `electron-forge package` (out/).
// Platform-specific layout; returns null if no build is present yet.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const APP_NAME = 'KB-App';

export function packagedExecutable(): string | null {
  const outDir = path.resolve(__dirname, '..', 'out');
  if (!fs.existsSync(outDir)) return null;
  const arch = os.arch();

  if (process.platform === 'darwin') {
    const p = path.join(outDir, `${APP_NAME}-darwin-${arch}`, `${APP_NAME}.app`, 'Contents', 'MacOS', APP_NAME);
    return fs.existsSync(p) ? p : null;
  }
  if (process.platform === 'win32') {
    const p = path.join(outDir, `${APP_NAME}-win32-${arch}`, `${APP_NAME}.exe`);
    return fs.existsSync(p) ? p : null;
  }
  const p = path.join(outDir, `${APP_NAME}-linux-${arch}`, APP_NAME);
  return fs.existsSync(p) ? p : null;
}
