// Shipped + maintained `.obsidian/` vault config (SPEC-0031 VAULT-2/5/6/10).
//
// Vellum ships a curated core-Obsidian setup so the vault is good the moment it's opened — WITHOUT
// requiring any community plugins (VAULT-1). The centrepiece is the GRAPH: only entities are nodes
// (claims/sources/raw/outputs are filtered out, VAULT-2), colored by their `type/<kind>` tag in the
// Vellum palette (VAULT-5). Written NON-DESTRUCTIVELY (write-if-absent per file) so the Principal's
// own Obsidian edits are never clobbered (VAULT-6); deterministic, so a clean/rebuild regenerates the
// same config (VAULT-10).
//
// Pure builders (buildGraphConfig/buildAppConfig/buildAppearanceConfig) return plain objects so they
// unit-test without a filesystem; `ensureObsidianConfig` does the write-if-absent I/O.
import { promises as fs } from 'node:fs';
import path from 'node:path';

/** `.obsidian/` is the Obsidian config dir at the vault root. */
export const OBSIDIAN_DIR = '.obsidian';

/** Vellum brand hues (brand/BRAND-GUIDELINES.md) for the entity-kind graph color groups. */
const KIND_COLORS: Record<string, string> = {
  person: '#2f6b5b', // viridian
  place: '#1e3557', // deep blue
  organization: '#c9a35a', // gilded gold
  concept: '#bfd7e6', // mist
  work: '#3e9e82', // sprout
  event: '#c8743c', // ember
};

/** Obsidian stores a color group's color as a decimal RGB int + alpha. `#2f6b5b` → 3107163. */
function rgbInt(hex: string): number {
  return parseInt(hex.replace('#', ''), 16);
}

/** A graph color group: nodes whose tag matches `query` are drawn in `color`. */
export interface GraphColorGroup {
  query: string;
  color: { a: number; rgb: number };
}

/** Build the entity-kind color groups (VAULT-2 "tag-colored"): one per known kind, keyed on the
 *  `type/<kind>` tag connectDoc writes. Unknown kinds fall through to Obsidian's default node color. */
export function buildColorGroups(): GraphColorGroup[] {
  return Object.entries(KIND_COLORS).map(([kind, hex]) => ({
    query: `tag:#type/${kind}`,
    color: { a: 1, rgb: rgbInt(hex) },
  }));
}

/**
 * The global graph config (`.obsidian/graph.json`). The `search` filter scopes the graph to
 * `entities/` so ONLY entity notes are nodes — claims, sources, raw text and outputs are excluded
 * (VAULT-2/5) — while entity⇄entity `[[wikilinks]]` still render as edges. Colored by `type/<kind>`.
 */
export function buildGraphConfig(): Record<string, unknown> {
  return {
    'collapse-filter': false,
    // Entities-only: claims/, sources/ (incl. raw), and outputs/ are NOT under entities/, so they drop
    // out of the graph. Entity↔entity links stay (both endpoints are entity notes).
    search: 'path:entities/',
    showTags: false,
    showAttachments: false,
    hideUnresolved: true, // a [[link]] to a not-yet-created entity isn't a phantom node
    showOrphans: true, // a brand-new entity with no links yet should still show
    'collapse-color-groups': false,
    colorGroups: buildColorGroups(),
    'collapse-display': false,
    showArrow: false,
    textFadeMultiplier: 0,
    nodeSizeMultiplier: 1,
    lineSizeMultiplier: 1,
    'collapse-forces': false,
    centerStrength: 0.5,
    repelStrength: 10,
    linkStrength: 1,
    linkDistance: 250,
    scale: 1,
    close: true,
  };
}

/**
 * Core app settings (`.obsidian/app.json`). Aligns Obsidian's link handling with how Vellum writes
 * notes: wiki-style `[[links]]` (not markdown links — VAULT-12 alias form), and auto-update links on
 * rename so a Connect-driven entity rename never breaks the graph.
 */
export function buildAppConfig(): Record<string, unknown> {
  return {
    useMarkdownLinks: false, // keep `[[wikilinks]]` — the form connectDoc/claimDoc emit
    newLinkFormat: 'shortest',
    alwaysUpdateLinks: true, // a rename re-points links → the graph stays whole
    attachmentFolderPath: '.kb/attachments',
    showFrontmatter: true, // the curated Properties (SPEC-0025) are part of the human page
  };
}

/** Appearance (`.obsidian/appearance.json`) — a light Vellum accent; theme left to the user. */
export function buildAppearanceConfig(): Record<string, unknown> {
  return { accentColor: '#2f6b5b' }; // viridian
}

/** The files Vellum ships under `.obsidian/`, each `vault-relative path → JSON content`. */
export function obsidianFiles(): Record<string, unknown> {
  return {
    [path.join(OBSIDIAN_DIR, 'graph.json')]: buildGraphConfig(),
    [path.join(OBSIDIAN_DIR, 'app.json')]: buildAppConfig(),
    [path.join(OBSIDIAN_DIR, 'appearance.json')]: buildAppearanceConfig(),
  };
}

/**
 * Ship/maintain the `.obsidian/` config at `root` (VAULT-5). NON-DESTRUCTIVE (VAULT-6): each file is
 * written only if ABSENT, so a Principal who has tweaked their graph/app settings is never clobbered.
 * Idempotent + deterministic (VAULT-10): a second call (or a rebuilt vault) is a no-op / identical.
 * Returns the vault-relative paths it actually created (empty when everything already existed).
 */
export async function ensureObsidianConfig(root: string): Promise<string[]> {
  const dir = path.join(path.resolve(root), OBSIDIAN_DIR);
  await fs.mkdir(dir, { recursive: true });
  const created: string[] = [];
  for (const [rel, content] of Object.entries(obsidianFiles())) {
    const abs = path.join(path.resolve(root), rel);
    try {
      await fs.access(abs); // exists → respect the user's version, leave it
    } catch {
      await fs.writeFile(abs, JSON.stringify(content, null, 2) + '\n', 'utf8');
      created.push(rel);
    }
  }
  return created;
}
