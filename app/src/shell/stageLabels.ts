// Re-export shim — the stage/actor display map now lives in the neutral `kb` layer so The Line,
// the tray (main), and the Today projection (main) share one source (SPEC-0058). Renderer code that
// imported `stageDisplayName` from here keeps working unchanged.
export { stageDisplayName } from '../kb/stageLabels';
