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
  connect: 'Linking',
  claims: 'Claim extraction',
  panel: 'Review', // per KB-PM ruling (the Control-Panel config actor)
  output: 'Saved answer',
  reflect: 'Reflect',
  recall: 'Recall',
};

/** The human label for a stage/actor id (display only — see the file header). */
export function stageDisplayName(stage: string): string {
  return STAGE_LABELS[stage] ?? titleCase(stage);
}

function titleCase(s: string): string {
  if (s.length === 0) return s;
  return s.charAt(0).toUpperCase() + s.slice(1);
}
