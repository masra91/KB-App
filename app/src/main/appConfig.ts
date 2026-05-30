// App-level config (which vault is active), persisted in Electron's userData.
// Tiny JSON file — no electron-store dependency (PRIN-5 simplicity).
import { app } from 'electron';
import { promises as fs } from 'node:fs';
import path from 'node:path';

export interface AppConfigData {
  activeVaultPath: string | null;
}

const DEFAULT: AppConfigData = { activeVaultPath: null };

function configFilePath(): string {
  return path.join(app.getPath('userData'), 'kb-app.config.json');
}

export async function readAppConfig(): Promise<AppConfigData> {
  try {
    return { ...DEFAULT, ...(JSON.parse(await fs.readFile(configFilePath(), 'utf8')) as AppConfigData) };
  } catch {
    return { ...DEFAULT };
  }
}

export async function writeAppConfig(data: AppConfigData): Promise<void> {
  await fs.writeFile(configFilePath(), JSON.stringify(data, null, 2) + '\n');
}
