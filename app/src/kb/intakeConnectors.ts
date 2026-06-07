// Proactive Intake — shared types, classification, and source rendering (SPEC-0041 INTAKE).
//
// INTAKE pulls the Principal's external feeds (RSS/Atom now; M365-mail next) into the vault as
// immutable PRIMARY sources on a cadence. It is the *automated arrival surface*: a standing
// subscription + a schedule, not a manual capture and not a research question. The boundary vs
// RESEARCH (SPEC-0028) is the spec's load-bearing decision: INTAKE produces PRIMARY sources
// (origin:'external', the item itself), RESEARCH produces SECONDARY cited sources (corroboration).
//
// Architecture note (mirrors researcherScheduler's seam ruling): a connector reuses the JOBS
// scheduler's *machinery shape* (named-preset cadence, restart-safe "due", single-flight) but its
// EXECUTION BODY is `runIntakeConnector` (a pass → primary source via the ingest path), NOT the
// JobBehavior→JobFinding→write-sink flow — that sink is confined to entities/claims/outputs, whereas
// INTAKE writes a `sources/` primary via `captureToInbox`. A JobBehavior and an intake connector are
// distinct behavior shapes that share only scheduling (keeps JOBS-10 intact).
//
// RENDERER-SAFE (STACK-6): types + constants + pure string helpers only — NO node builtins, so the
// Sources view (renderer) can import the connector types/catalog. The node-`crypto` dedup-key lives
// in `intakeRun.ts` (backend).

/** The built-in connector templates. v1 Slice 1 ships RSS; M365-mail lands next (SPEC-0041 F2). */
export const INTAKE_CONNECTOR_TYPES = ['rss', 'm365-mail'] as const;
export type IntakeConnectorType = (typeof INTAKE_CONNECTOR_TYPES)[number];

/** Connector-default classification (SCOPE-8/14): conservative defaults applied to ingested items. */
export const DEFAULT_INTAKE_SCOPE = 'global';
export const DEFAULT_INTAKE_SENSITIVITY = 'internal'; // SCOPE-8 conservative default until classified

/** A bounded pass never drains an entire feed in one tick (INTAKE-11) — cap items per run. */
export const DEFAULT_MAX_ITEMS_PER_PASS = 25;

/**
 * One registered intake connector (INTAKE-4) — a per-vault subscription the Principal owns, the
 * parallel sibling of the researcher registry. `type` selects the fetch behavior; `config` is
 * type-specific (rss: `{ feedUrl, allowedDomains? }`; m365-mail: `{ tenantId, folder? }`). `scope` +
 * `sensitivity` are the connector defaults applied to every item it ingests (SCOPE-14).
 */
export interface IntakeConnectorConfig {
  id: string;
  type: IntakeConnectorType;
  schedule: import('./jobs').SchedulePreset;
  enabled: boolean;
  /** Connector-default scope applied to ingested items (SCOPE-14). Defaults to `global`. */
  scope: string;
  /** Connector-default sensitivity applied to ingested items (SCOPE-8/14). Defaults to `internal`. */
  sensitivity: string;
  /** Principal-facing label shown in the Sources view (optional). */
  label?: string;
  /** Max items pulled in one bounded pass (INTAKE-11). Defaults to {@link DEFAULT_MAX_ITEMS_PER_PASS}. */
  maxItemsPerPass?: number;
  /** Type-specific config (feed URL, tenant, folder, …). */
  config?: Record<string, unknown>;
}

/**
 * A connector `id` MUST be a bare slug — it is consumed directly into filesystem paths (the per-
 * connector dedup ledger `.kb/intake/<id>/seen.json`). A traversal id (`../x`) in a hand-/foreign-
 * edited `registry.json` would escape `.kb/intake` and become an arbitrary-write vector — the same
 * class as JOBS-10's id guard. Validate at every boundary an id enters (SPEC-0023 JOBS-10 / #29).
 */
export function isSafeConnectorId(v: unknown): v is string {
  return typeof v === 'string' && /^[a-z0-9][a-z0-9-]*$/i.test(v);
}

/** One external item pulled from a feed (the connector's normalized output, before ingest). */
export interface IntakeItem {
  /** Stable feed identity — RSS `<guid>` / Atom `<id>` / RFC-5322 Message-ID — the primary dedup key
   *  (INTAKE-8). Empty/absent → the content-hash fallback ({@link intakeDedupKey}) is used. */
  externalId: string;
  title: string;
  /** Canonical URL / permalink, when the feed provides one (recorded as provenance, INTAKE-10). */
  link?: string;
  /** ISO publication timestamp, when known. */
  publishedAt?: string;
  author?: string;
  /** The item body as markdown / plain text — becomes the primary source body. */
  contentMd: string;
}

/** Bounds the connector's fetch (INTAKE-11): never pull more than `maxItems` in one pass. */
export interface IntakeFetchContext {
  maxItems: number;
}

/**
 * The IO/cognition seam: fetch the connector's currently-available items (READ-ONLY w.r.t. the world,
 * INTAKE-7 — a fetch MUST NOT mutate the remote, e.g. never mark mail read). Injected so the run
 * orchestration is unit-testable without a network (mirrors RESEARCH's `ResearchFn`). The connector
 * returns what the feed currently serves; `runIntakeConnector` does the dedup against the ledger, so
 * a fetch implementation need not track state itself. Throws on fetch/auth failure (→ `intake-failed`,
 * never a silent empty — the failed≠empty principle, INTAKE-12).
 */
export type IntakeFetchFn = (c: IntakeConnectorConfig, ctx: IntakeFetchContext) => Promise<IntakeItem[]>;

/** The dedup key for an item (INTAKE-8): the stable external id, or a content-hash fallback when the
 *  feed gives no id. The fallback hashes the item's stable fields so a re-served identical item maps
 *  to the same key. Slice-1 keys on the id ALONE (no `last-modified`): a re-served item is skipped —
 *  the never-re-archive guarantee. Revision-snapshot semantics (re-ingesting an edited item under the
 *  same id) are deferred — see the dedup note in `intakeRun.ts` (feeds re-stamp timestamps, flood risk).
 *  Implemented in `intakeRun.ts` (backend) — it uses node `crypto`, which must NOT enter the renderer
 *  bundle (STACK-6): this module stays renderer-safe (types + constants only) so the Sources view can
 *  import its connector types/catalog without dragging node builtins in. */

/**
 * Render an item into the immutable primary-source body (INTAKE-10): a small provenance header
 * (connector, source link, published/fetched timestamps) followed by the item content. The header
 * preserves the external origin in the source itself; the link doubles as a citation. The body is
 * treated as DATA downstream (Decompose), never instructions — open-feed content is untrusted even
 * though it enters as a primary source (INTAKE-13), same posture as any captured web page.
 */
export function renderIntakeSourceBody(c: IntakeConnectorConfig, item: IntakeItem, fetchedAt: string): string {
  const lines: string[] = [];
  lines.push(`# ${item.title || '(untitled)'}`);
  lines.push('');
  const prov: string[] = [`Proactively pulled by intake connector \`${c.id}\` (${c.type}) on ${fetchedAt}.`];
  if (item.link) prov.push(`Source: ${item.link}`);
  if (item.publishedAt) prov.push(`Published: ${item.publishedAt}`);
  if (item.author) prov.push(`Author: ${item.author}`);
  // A blockquote provenance header — human-readable, and the link is an inline citation.
  lines.push(prov.map((l) => `> ${l}`).join('\n'));
  lines.push('');
  lines.push(item.contentMd.trim());
  lines.push('');
  return lines.join('\n');
}
