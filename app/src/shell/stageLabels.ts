// Human display names for pipeline stages / audit actors (dogfood #4). The UI showed raw internal
// identifiers — `claims`, `connect`, `archivist` — as user-facing labels (Activity actor badges,
// Status set-aside stage, lock holder). This maps them to readable names.
//
// ⚠️ DISPLAY-LAYER ONLY (KB-PM guardrail). NEVER persist or compare against these — the canonical
// lowercase ids are what the vault, audit log, wikilinks, and stage routing depend on. This is a
// one-way id → label lookup for rendering; the stored value is untouched.

/** Canonical stage/actor id → human label. Unknown ids fall back to a Title-Cased version of the id
 *  (so a new stage/actor reads acceptably until it's added here). */
const STAGE_LABELS: Record<string, string> = {
  archivist: 'Archiving',
  archive: 'Archiving',
  decompose: 'Decompose',
  connect: 'Connect', // DESIGN-TERMS (#361): canonical stage name is "Connect", never "Linking" — the engine id, DESIGN-VIZ signage, and The Line station all say Connect; this display map was the lone outlier (drift). "link" stays a verb in prose only.
  claims: 'Claim extraction',
  panel: 'Control Panel', // the Control-Panel config actor — NOT "Review" (would collide with the Reviews needs-you queue; QA-2 + DEV-4 flagged)
  output: 'Saved answer',
  reflect: 'Reflect',
  recall: 'Recall',
};

/** The human label for a stage/actor id (display only — see the file header). NULL-SAFE (ENG-15/16):
 *  a legacy/partial audit event can reach the render layer with a null/undefined `actor` (the trust
 *  boundary parses events off disk with unchecked casts); a raw `titleCase(null)` threw and — inside an
 *  unguarded feed `.map` — blanked the whole Activity/Status surface. Coerce a non-string id to '' so it
 *  degrades to an empty badge instead of crashing. */
export function stageDisplayName(stage: string): string {
  if (typeof stage !== 'string' || stage.length === 0) return '';
  return STAGE_LABELS[stage] ?? titleCase(stage);
}

function titleCase(s: string): string {
  if (s.length === 0) return s;
  return s.charAt(0).toUpperCase() + s.slice(1);
}
