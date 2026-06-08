// Holds the process-wide Quick Capture agent (SPEC-0038) so the Settings write-path can live-apply
// a hotkey change (QCAP-6) without restart. Module singleton, mirroring the `active` pipeline ref —
// no Electron import here, so it stays test-friendly.
import type { QuickCaptureAgent } from './quickCaptureAgent';

let agent: QuickCaptureAgent | null = null;

export function setQuickCaptureAgent(a: QuickCaptureAgent | null): void {
  agent = a;
}

export function getQuickCaptureAgent(): QuickCaptureAgent | null {
  return agent;
}
