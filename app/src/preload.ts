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
  ask: (req) => ipcRenderer.invoke('kb:ask', req),
  listJobs: () => ipcRenderer.invoke('kb:listJobs'),
  setJobConfig: (patch) => ipcRenderer.invoke('kb:setJobConfig', patch),
  runJobNow: (id) => ipcRenderer.invoke('kb:runJobNow', id),
  activityFeed: (filter) => ipcRenderer.invoke('kb:activityFeed', filter),
  activityEvents: (filter) => ipcRenderer.invoke('kb:activityEvents', filter),
  activityLineage: (id) => ipcRenderer.invoke('kb:activityLineage', id),
  getInstanceSettings: () => ipcRenderer.invoke('kb:getInstanceSettings'),
  setInstanceSettings: (settings) => ipcRenderer.invoke('kb:setInstanceSettings', settings),
  listAgents: () => ipcRenderer.invoke('kb:listAgents'),
  listResearchers: () => ipcRenderer.invoke('kb:listResearchers'),
  setResearcherConfig: (patch) => ipcRenderer.invoke('kb:setResearcherConfig', patch),
  runResearcherNow: (id) => ipcRenderer.invoke('kb:runResearcherNow', id),
  listResearcherRuns: (id) => ipcRenderer.invoke('kb:listResearcherRuns', id),
};

contextBridge.exposeInMainWorld('kbApi', kbApi);
