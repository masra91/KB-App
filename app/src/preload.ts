// Preload: expose a typed, minimal KbApi to the renderer via contextBridge.
import { contextBridge, ipcRenderer } from 'electron';
import type { KbApi } from './kb/types';

const kbApi: KbApi = {
  getState: () => ipcRenderer.invoke('kb:getState'),
  pickFolder: () => ipcRenderer.invoke('kb:pickFolder'),
  inspect: (p) => ipcRenderer.invoke('kb:inspect', p),
  create: (opts) => ipcRenderer.invoke('kb:create', opts),
};

contextBridge.exposeInMainWorld('kbApi', kbApi);
