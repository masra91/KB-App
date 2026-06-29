// Content-stable Health finding key (SPEC-0060 VUX-16) — PURE + renderer-safe: NO node / connect /
// directives import, so the Health VIEW (renderer) can read each finding's dismiss key off the projection
// without dragging a node-side module into the browser bundle. (This split fixes the #500 build-check
// break: `healthProjection.ts` is renderer-reachable, and value-importing the key from `healthPanel.ts`
// transitively pulled `directives.ts` → `node:fs` into the renderer.) `blockKey`/`normalizeName` are
// INLINED here (mirroring connect.ts) so this module imports nothing runtime; `healthFindingKey.test.ts`
// asserts parity with the real `connect.blockKey`, so the two can never drift — a drift would make a
// renderer-computed key miss the backend's stored dismissal.
import type { HealthFinding, DanglingLink } from './healthPanel';

/** The three structural finding classes (HEALTH §3) — the dismiss key + the remediation actions key off these. */
export type HealthFindingClass = 'orphan' | 'thin' | 'dangling';

/** Inlined mirror of `connect.normalizeName` (punctuation → space, collapse, trim, lowercase). */
function normalizeName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Inlined mirror of `connect.blockKey` (`<kind>|<normalizedName>`). */
function blockKey(kind: string, name: string): string {
  return `${kind.trim().toLowerCase()}|${normalizeName(name)}`;
}

/**
 * A content-STABLE key for a finding (NOT a ULID): `<class>:<kind>|<normalizedName>` for an entity finding,
 * `dangling:<fromName>→<target>` for a dead link. Stable across re-derive/replay so a dismissal (and a
 * future remediation record) re-matches the same finding after the entity's ULID is reborn (SPEC-0050 lesson).
 */
export function healthFindingKey(cls: HealthFindingClass, f: HealthFinding | DanglingLink): string {
  if (cls === 'dangling') {
    const d = f as DanglingLink;
    const norm = (s: string): string => s.trim().toLowerCase().replace(/\s+/g, ' ');
    return `dangling:${norm(d.fromName)}→${norm(d.target)}`;
  }
  const e = f as HealthFinding;
  return `${cls}:${blockKey(e.kind, e.name)}`;
}
