// Activity row glyph-tile typing (Vellum UX v2, DL-2's Activity render contract; #184 hue-on-tile).
//
// Each feed row leads with a small glyph-TILE whose HUE is typed by the event KIND — the categorical
// cue that lets the eye scan a dense log. Color discipline (UX v2 move #4): the hue rides the TILE,
// the row text stays ink (AA); gold is rationed; OXIDE is reserved for a FAILED event (honest
// failure); and there is **NO EMBER anywhere** — Activity is a record of PAST events, nothing here
// needs a decision. Pure (string → descriptor) so it unit-tests without a DOM.
//
// NB: the GLYPH characters are restrained placeholders pending DL-2's authored actor→glyph table; the
// KIND→HUE map below is per her contract and is the gateable color discipline. Swapping the glyph
// chars in is a visual-only change behind this one function.

/** The categorical kinds DL-2's contract colors (plus neutral families for the remaining actors). */
export type ActivityKind =
  | 'capture'
  | 'connect'
  | 'claim'
  | 'enrich'
  | 'compose'
  | 'promote'
  | 'research'
  | 'reflect'
  | 'recall'
  | 'config'
  | 'replay'
  | 'failed'
  | 'event';

interface GlyphDescriptor {
  kind: ActivityKind;
  /** Restrained placeholder glyph (DL-2's table swaps in here). */
  glyph: string;
  /** CSS modifier class (`.gl--<kind>`) carrying the hue token in index.css. */
  cls: string;
}

/** actor id → categorical kind. Unknown actors fall to the neutral `event` kind. */
const ACTOR_KIND: Record<string, ActivityKind> = {
  archivist: 'capture',
  archive: 'capture',
  intake: 'capture',
  watch: 'capture',
  decompose: 'capture', // pre-Connect extraction — same "material entering" family (accent/slate)
  connect: 'connect',
  claims: 'claim',
  enrich: 'enrich',
  compose: 'compose',
  output: 'promote', // a saved answer promoted into the KB
  researcher: 'research',
  job: 'reflect',
  reflect: 'reflect',
  recall: 'recall',
  panel: 'config',
  maintenance: 'config',
  replay: 'replay',
};

const GLYPH: Record<ActivityKind, string> = {
  capture: '⤓',
  connect: '◇',
  claim: '·',
  enrich: '✦',
  compose: '¶',
  promote: '↑',
  research: '⌕',
  reflect: '↻',
  recall: '?',
  config: '≡',
  replay: '↺',
  failed: '!',
  event: '•',
};

/** Does this event-type read as a FAILURE? (→ oxide tile, overriding the kind hue.) */
export function isFailedEvent(eventType: string | undefined): boolean {
  if (!eventType) return false;
  return /(?:^|[-_:])(?:fail|failed|error|errored|setaside|set-aside|refused|blocked|crash)/i.test(eventType);
}

/**
 * Resolve a feed row's glyph-tile from its actor + (optional) event-type. A failed event-type wins
 * (oxide, honest failure); otherwise the actor's kind drives the hue. NULL-SAFE (ENG-15/16): a
 * missing/unknown actor degrades to the neutral `event` tile rather than throwing.
 */
export function glyphFor(actor: string | undefined, eventType?: string): GlyphDescriptor {
  if (isFailedEvent(eventType)) return { kind: 'failed', glyph: GLYPH.failed, cls: 'gl--failed' };
  const kind = (actor && ACTOR_KIND[actor]) || 'event';
  return { kind, glyph: GLYPH[kind], cls: `gl--${kind}` };
}
