// IPC handlers — the main-process side of the KbApi contract (preload mirrors it).
import { ipcMain, dialog, BrowserWindow, type OpenDialogOptions } from 'electron';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { inspectPath, createKb } from '../kb/vault';
import { readAppConfig, writeAppConfig } from './appConfig';
import type { AppState, VaultConfig, CreateKbOptions } from '../kb/types';

async function loadVaultConfig(vaultPath: string): Promise<VaultConfig | null> {
  try {
    return JSON.parse(await fs.readFile(path.join(vaultPath, '.kb', 'config.json'), 'utf8')) as VaultConfig;
  } catch {
    return null; // vault moved/deleted/invalid
  }
}

export function registerIpc(): void {
  ipcMain.handle('kb:getState', async (): Promise<AppState> => {
    const cfg = await readAppConfig();
    const vaultConfig = cfg.activeVaultPath ? await loadVaultConfig(cfg.activeVaultPath) : null;
    return { activeVaultPath: cfg.activeVaultPath, vaultConfig };
  });

  ipcMain.handle('kb:pickFolder', async (e): Promise<string | null> => {
    const win = BrowserWindow.fromWebContents(e.sender);
    const opts: OpenDialogOptions = {
      title: 'Choose a folder for your Knowledge Base',
      properties: ['openDirectory', 'createDirectory'],
    };
    const res = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts);
    return res.canceled || res.filePaths.length === 0 ? null : res.filePaths[0];
  });

  ipcMain.handle('kb:inspect', async (_e, p: string) => inspectPath(p));

  ipcMain.handle('kb:create', async (_e, opts: CreateKbOptions) => {
    const result = await createKb(opts);
    if (result.ok) {
      await writeAppConfig({ activeVaultPath: path.resolve(opts.path) });
    }
    return result;
  });
}
