// The orient-before-egress phase (SPEC-0028 RESEARCH-22, warm-start Slice 4b). Before any outbound query,
// a researcher runs a BOUNDED, LOCAL (non-egress) orientation: it reads (a) its own field notebook
// (RESEARCH-21, what it's returned + already harvested) and (b) the in-tier KB neighborhood of the
// request's subject (the EXPLORE read path) — producing the GAP/ANGLE to pursue + a DEDUP SET of
// already-known sources to skip, so the pass EXPANDS the frontier instead of re-fetching the same
// first-page hits. The outbound query is STILL built through the constrained buildOutboundQuery path
// (request + the chosen angle, NEVER a verbatim KB dump, D6a/D8).
//
// Two security boundaries (the gate-2 surface, D8):
//   1. The STRUCTURAL FLOOR — neighbor entity NAMES — is graph metadata, tier-agnostic, and bypasses the
//      content gate. CONTENT reads (claim text) are gated by `sensitivityAllowsOrientRead(tier, sensitivity)`
//      — DEV-2's SENSE comparator (SPEC-0043), INJECTED here (consumed, not re-implemented).
//   2. The QUERY-CONSTRUCTION GUARD — `buildOrientedQuery` folds only a length-capped angle into the
//      request's context and routes through buildOutboundQuery, so an angle can never become a raw-KB-dump
//      query (a verbatim exfiltration of KB content).
// Orient reads are LOCAL → they do NOT consume the egress `maxToolCalls`; they are bounded by the
// researcher's separate `orientBudget`.
import type { EgressTier } from './researchers';
import { resolveOrientBudget, type ResearcherConfig, type ResearchRequest } from './researchers';
import { buildOutboundQuery } from './researchRun';
import { areaKey, deriveNotebook, knownSourceUrls } from './researchNotebook';
import { readLedger, coveredAngles, frontierFacets } from './researchLedger';
import { buildNeighborhood } from './explorePanel';
import { makeReadOnlyTools } from './recallTools';

/** Max chars of orient-derived angle that may ride into the outbound query's context (the
 *  query-construction guard, D6a/D8). Well under {@link MAX_OUTBOUND_CONTEXT_CHARS} — a steer, not a dump. */
export const ORIENT_ANGLE_MAX_CHARS = 200;
/** Default conservative sensitivity for an UNLABELED entity-content read (entities carry no own label
 *  until SENSE Slice-3 / SENSE-6) — most-restrictive-safe, matches DEV-2's DEFAULT_SENSITIVITY. */
export const ORIENT_DEFAULT_SENSITIVITY = 'internal';

/** The in-tier KB-neighborhood read of a subject (RESEARCH-22). `neighborNames` = the STRUCTURAL FLOOR
 *  (tier-agnostic graph metadata, no gate). `contentHints` = claim-derived content (CONTENT — gated).
 *  Injected so orient is unit-testable without a live KB; prod = {@link makeNeighborhoodReader}. */
export type NeighborhoodReader = (subject: string) => Promise<{ found: boolean; centerName?: string; neighborNames: string[]; contentHints: string[] }>;

/** DEV-2's `sensitivityAllowsOrientRead` (SPEC-0043), injected — governs CONTENT reads (floor bypasses it). */
export type OrientGate = (tier: EgressTier, sensitivity: string) => boolean;

export interface OrientDeps {
  readNeighborhood: NeighborhoodReader;
  gate: OrientGate;
  now?: () => string;
}

export interface OrientResult {
  /** The gap/angle to pursue — a SHORT, bounded steer for the outbound query (NEVER a KB dump). '' = cold subject. */
  angle: string;
  /** Already-harvested source URLs to skip — the result-level dedup set (RESEARCH-21). */
  dedupSet: Set<string>;
  /** Local (non-egress) orient reads spent this pass — bounded by the researcher's orientBudget. */
  reads: number;
  /** The neighbor entity names that informed the angle (structural floor; observability). */
  floor: string[];
  /** True if a gated CONTENT read was permitted for this tier↔sensitivity (else floor-only). */
  contentRead: boolean;
}

/**
 * Run the bounded orient phase for `r` answering `req`. Reads the notebook (own audit, unconditional) +
 * the subject's KB-neighborhood structural floor (tier-agnostic), and — only when the sensitivity gate
 * permits — content hints, to choose the gap/angle + the dedup set. Pure-ish: all I/O is injected (notebook
 * derive reads `root`'s audit; neighborhood + gate are injected). Bounded by `orientBudget`.
 */
export async function orient(root: string, r: ResearcherConfig, req: ResearchRequest, deps: OrientDeps): Promise<OrientResult> {
  const now = deps.now ?? (() => new Date().toISOString());
  const budget = resolveOrientBudget(r);
  let reads = 0;

  // (1) Own memory — RESEARCH-21/RMEM-2, no egress, no gate (reading its own prior work). The field
  // notebook (audit-derived working set) AND the durable run-ledger (first-class overlay) are one logical
  // "own-memory" read — the ledger is a cheap local file, so it doesn't take a second orient-budget tick.
  const nowMs = Date.parse(now()) || Date.now();
  const notebook = await deriveNotebook(root, r.id, nowMs);
  const ledger = await readLedger(root, r.id);
  reads++;
  const dedupSet = knownSourceUrls(notebook);

  // (2) Structural floor — neighbor entity NAMES (tier-agnostic, bypasses the content gate). 1 read.
  let floor: string[] = [];
  let contentHints: string[] = [];
  let centerName: string | undefined;
  if (reads < budget) {
    const nbh = await deps.readNeighborhood(orientSubject(req));
    reads++;
    if (nbh.found) {
      floor = nbh.neighborNames;
      centerName = nbh.centerName;
      // (3) CONTENT hints — gated by DEV-2's sensitivityAllowsOrientRead. Entities carry no own label
      // until SENSE Slice-3, so treat as ORIENT_DEFAULT_SENSITIVITY (most-restrictive-safe). Only used
      // when the gate permits + the budget allows.
      if (reads < budget && deps.gate(r.egressTier, ORIENT_DEFAULT_SENSITIVITY)) {
        contentHints = nbh.contentHints;
        reads++;
      }
    }
  }
  const contentRead = contentHints.length > 0;

  // The angles this subject was already drilled on (RESEARCH-QUALITY + RMEM-3) — the exclusion set so a
  // re-run ROTATES to a different missing facet instead of re-issuing a covered tuple. The DURABLE LEDGER is
  // authoritative (first-class run-memory, survives restart/replay); the audit-derived notebook is unioned
  // in for back-compat (a vault researched before the ledger existed). Both keyed by normalized `what` + entityId.
  const notebookTargeted = notebook.areas.find((a) => a.key === areaKey(orientSubject(req), req.by.entityId))?.targetedFacets ?? [];
  const ledgerCovered = coveredAngles(ledger, orientSubject(req), req.by.entityId, nowMs);
  const targetedAngles = [...new Set([...ledgerCovered, ...notebookTargeted])];

  // The frontier — leads surfaced but not yet pursued (RMEM-4). The ledger resolves the request's still-
  // missing gap facets against what's been drilled (resume where it stopped), unioned with the audit-derived
  // notebook frontier. Run-metadata only — facet labels, never raw KB content (RMEM-6 / D6a).
  const ledgerFrontier = frontierFacets(ledger, orientSubject(req), req.by.entityId, req.gap?.missing ?? [], nowMs);
  const frontierTerms = [...new Set([...ledgerFrontier, ...notebook.frontier.map((f) => f.term)])];

  // Choose the gap/angle: prefer the entity's still-MISSING gap facet (skipping any already drilled), else
  // an expand-next frontier lead, else a known neighbor the request doesn't already name, else a gated
  // content hint, else cold ('').
  const angle = chooseAngle(req, frontierTerms, floor, contentHints, centerName, targetedAngles);
  return { angle, dedupSet, reads, floor, contentRead };
}

/** The subject a neighborhood read centers on — the request's `what` (request-only, D6a; never KB text). */
export function orientSubject(req: ResearchRequest): string {
  return req.what.trim();
}

/** Derive a short steer from the gap signals, capped — never a verbatim dump. Picks the first signal not
 *  already named in the request (so the pass EXPANDS rather than re-establishes) AND not already drilled on
 *  a prior pass (so re-runs ROTATE), bounded to the cap.
 *
 *  GAP-DRIVEN priority (RESEARCH-24): a MISSING enrichment facet the request carries (`req.gap.missing` —
 *  what the entity's claims don't yet cover) wins over the generic "first fresh neighbor" steer, so the
 *  pass fills the KB's actual gap instead of re-chasing a facet we already know. Order: gap-missing facet
 *  → frontier lead (a prior finding raised but didn't cover) → fresh neighbor name → gated content hint.
 *
 *  CROSS-RUN ROTATION (RESEARCH-QUALITY): `targetedAngles` are the steers prior passes already drilled for
 *  this subject (from the field notebook). A candidate is skipped when ANY recorded angle already contains
 *  it — so two runs on the same entity steer at DIFFERENT missing facets, yielding materially different
 *  queries instead of the same generic one. When every gap facet is exhausted the steer falls through to
 *  neighbors/content and finally cold (''), which is the honest "nothing left to target" signal. */
export function chooseAngle(req: ResearchRequest, frontierTerms: string[], floor: string[], contentHints: string[], centerName?: string, targetedAngles: readonly string[] = []): string {
  const already = (req.what + ' ' + req.context).toLowerCase();
  const drilled = targetedAngles.map((a) => a.toLowerCase());
  const fresh = (s: string): boolean => s.trim().length > 0 && !already.includes(s.toLowerCase());
  const notDrilled = (s: string): boolean => !drilled.some((a) => a.includes(s.trim().toLowerCase()));
  const usable = (s: string): boolean => fresh(s) && notDrilled(s);
  const gapMissing = req.gap?.missing ?? [];
  const lead = gapMissing.find(usable) ?? frontierTerms.find(usable) ?? floor.find(usable) ?? contentHints.find(usable);
  if (!lead) return '';
  const prefix = centerName && fresh(centerName) ? `re ${centerName}: ` : '';
  return clampAngle(`${prefix}${lead}`);
}

/** The production neighborhood reader (RESEARCH-22): the EXPLORE 1-hop read of `subject` via the read-only
 *  recall tools. Returns the structural floor (neighbor + center names) and content hints (claim
 *  statements) — the caller's gate decides whether the content hints are used. */
export function makeNeighborhoodReader(root: string): NeighborhoodReader {
  const tools = makeReadOnlyTools(root);
  return async (subject) => {
    const n = await buildNeighborhood(tools, subject);
    return {
      found: n.found,
      ...(n.center?.name ? { centerName: n.center.name } : {}),
      neighborNames: n.neighbors.map((x) => x.name).filter((s) => s.length > 0),
      contentHints: n.claims.map((c) => c.statement).filter((s) => s.length > 0),
    };
  };
}

/** The query-construction guard (D6a/D8): a bounded steer, never a KB dump. Caps to ORIENT_ANGLE_MAX_CHARS. */
export function clampAngle(angle: string): string {
  const a = angle.trim().replace(/\s+/g, ' ');
  return a.length > ORIENT_ANGLE_MAX_CHARS ? a.slice(0, ORIENT_ANGLE_MAX_CHARS) : a;
}

/**
 * Build the outbound query from the request + the orient angle — THE QUERY-CONSTRUCTION GUARD. The angle
 * is clamped (≤ ORIENT_ANGLE_MAX_CHARS) and folded into the request's `context`, then routed through the
 * constrained {@link buildOutboundQuery} (which itself caps context to {@link MAX_OUTBOUND_CONTEXT_CHARS}).
 * So even an adversarial, KB-dump-sized angle can never produce a verbatim-KB-dump query — the output is
 * bounded by request `what` + ≤500 chars of (clamped) context. No angle → the plain request query.
 */
export function buildOrientedQuery(req: ResearchRequest, angle: string): string {
  return buildOutboundQuery(orientedRequest(req, angle));
}

/** Fold the clamped angle into the request's `context` (bounded — the query-construction guard), returning
 *  the oriented request the egress pass runs on. `buildOutboundQuery` further caps context to ≤500, so the
 *  result can never carry a verbatim KB dump. No angle → the request unchanged. The egress adapter calls
 *  buildOutboundQuery on this, so the oriented steer reaches the live query through the constrained path. */
export function orientedRequest(req: ResearchRequest, angle: string): ResearchRequest {
  const steer = clampAngle(angle);
  if (!steer) return req;
  const context = [req.context.trim(), steer].filter((s) => s.length > 0).join(' · ');
  return { ...req, context };
}
