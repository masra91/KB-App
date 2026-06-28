// Re-export shim — "The Line" pure presentation model now lives in the neutral `kb` layer
// (`kb/lineStations.ts`) so the Today projection (main) can reuse `buildStations` for byte-identical
// pipeline stations ("one Line, one truth", SPEC-0058). The Status renderer imported its station /
// carriage / funnel model from here; those imports keep working unchanged.
export * from '../../kb/lineStations';
