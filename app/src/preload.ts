// Preload: expose a typed, minimal KbApi to the renderer via contextBridge.
import { contextBridge, ipcRenderer } from 'electron';
import type { KbApi } from './kb/types';

const kbApi: KbApi = {
  getState: () => ipcRenderer.invoke('kb:getState'),
  pickFolder: () => ipcRenderer.invoke('kb:pickFolder'),
  inspect: (p) => ipcRenderer.invoke('kb:inspect', p),
  create: (opts) => ipcRenderer.invoke('kb:create', opts),
  capture: (req) => ipcRenderer.invoke('kb:capture', req),
  pipelineStatus: () => ipcRenderer.invoke('kb:pipelineStatus'),
  listReviews: () => ipcRenderer.invoke('kb:listReviews'),
  answerReview: (req) => ipcRenderer.invoke('kb:answerReview', req),
  fullReplay: () => ipcRenderer.invoke('kb:fullReplay'),
};

contextBridge.exposeInMainWorld('kbApi', kbApi);
