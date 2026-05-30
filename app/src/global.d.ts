// Makes `window.kbApi` (exposed by preload via contextBridge) typed in the renderer.
import type { KbApi } from './kb/types';

declare global {
  interface Window {
    kbApi: KbApi;
  }
}

export {};
