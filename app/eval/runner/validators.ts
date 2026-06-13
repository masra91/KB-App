// SPEC-0042 EVAL Slice-1 — the deterministic validator library (EVAL-3). Named, parameterized checks
// that assert EXACTLY over a VaultSnapshot (entities/claims/sources/recall/audit). This is the DURABLE
// HOME (KB-Lead affirmation) for the quality asserts enrichE2eDogfood hand-wired — consolidated here so
// scenarios reference them by name (EVAL-1/12) and the runner scores pass/fail. Pure + fork-independent.
import type { VaultSnapshot, VaultFile } from './snapshot';
import type { DeterministicCheck } from './scenario';

/** One check's outcome — exact pass/fail + a human-readable detail for the scorecard. */
export interface CheckResult {
  check: string;
  pass: boolean;
  detail: string;
}

type Validator = (snap: VaultSnapshot, args: unknown) => CheckResult;

/** Normalize a name/title for tolerant comparison: lowercase, non-alphanumerics → spaces, collapsed. */
function norm(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

/** An entity's identity title: its first `# Heading`, else the filename slug (dashes → spaces). */
function entityTitle(f: VaultFile): string {
  const h = f.body.match(/^#\s+(.+?)\s*$/m);
  if (h) return h[1];
  const base = f.path.split('/').pop() ?? f.path;
  return base.replace(/\.md$/, '').replace(/-/g, ' ');
}

/** Does any entity's identity title tolerantly match `name`? (descriptor-as-node check, DECOMP-17). */
function entityMatches(snap: VaultSnapshot, name: string): boolean {
  const n = norm(name);
  return snap.entities.some((e) => {
    const t = norm(entityTitle(e));
    return t === n || t.includes(n);
  });
}

function asStrings(args: unknown): string[] {
  return Array.isArray(args) ? args.filter((x): x is string => typeof x === 'string') : [];
}

const fail = (check: string, detail: string): CheckResult => ({ check, pass: false, detail });
const pass = (check: string, detail: string): CheckResult => ({ check, pass: true, detail });

/** The registry. Add a check here (+ document its args) to make it available to every scenario. */
export const VALIDATORS: Record<string, Validator> = {
  // Genuine entities are nodes (DECOMP-17): every named entity exists as an entity node.
  entitiesInclude(snap, args) {
    const names = asStrings(args);
    const missing = names.filter((n) => !entityMatches(snap, n));
    return missing.length ? fail('entitiesInclude', `missing entities: ${missing.join(', ')}`) : pass('entitiesInclude', `all ${names.length} present`);
  },
  // Descriptors/roles are NOT nodes (DECOMP-17): none of the named descriptors became an entity.
  entitiesExclude(snap, args) {
    const names = asStrings(args);
    const leaked = names.filter((n) => entityMatches(snap, n));
    return leaked.length ? fail('entitiesExclude', `descriptors leaked as entities: ${leaked.join(', ')}`) : pass('entitiesExclude', `none of ${names.length} leaked`);
  },
  // Every claim carries a source citation (CLAIMS / DATA-10 / VAULT-13): a `[[…source.md…]]` body link
  // and/or `derivedFrom:` provenance. `{ required: true }` (default) asserts ALL claims are cited.
  claimCitations(snap, args) {
    const required = !args || (args as { required?: unknown }).required !== false;
    if (!required) return pass('claimCitations', 'not required');
    if (snap.claims.length === 0) return fail('claimCitations', 'no claims produced');
    const uncited = snap.claims.filter((c) => !/\[\[[^\]]*source\.md/.test(c.body) && !/derivedFrom:/.test(c.body));
    return uncited.length ? fail('claimCitations', `${uncited.length}/${snap.claims.length} claim(s) lack a citation: ${uncited.map((c) => c.path).join(', ')}`) : pass('claimCitations', `all ${snap.claims.length} cited`);
  },
  // A relatesTo hint became a real [[wikilink]] (CONNECT-12): the `from` entity links to `to`.
  wikilinkRendered(snap, args) {
    const a = (args ?? {}) as { from?: unknown; to?: unknown };
    if (typeof a.from !== 'string' || typeof a.to !== 'string') return fail('wikilinkRendered', 'args need { from, to }');
    const fromEntity = snap.entities.find((e) => norm(entityTitle(e)).includes(norm(a.from as string)));
    if (!fromEntity) return fail('wikilinkRendered', `source entity not found: ${a.from}`);
    const to = norm(a.to);
    const links = [...fromEntity.body.matchAll(/\[\[([^\]]+)\]\]/g)].map((m) => norm(m[1]));
    return links.some((l) => l.includes(to)) ? pass('wikilinkRendered', `${a.from} → [[${a.to}]]`) : fail('wikilinkRendered', `${a.from} has no [[${a.to}]] wikilink`);
  },
  // Recall grounded its answer in ≥ `min` verified citations (ASK-7).
  recallCites(snap, args) {
    const min = Number((args as { min?: unknown } | undefined)?.min ?? 1);
    if (!snap.recall) return fail('recallCites', 'no recall result (scenario had no `ask`)');
    const n = snap.recall.citations.length;
    return n >= min ? pass('recallCites', `${n} citation(s) (≥${min})`) : fail('recallCites', `${n} citation(s) (<${min})`);
  },
  // The recall answer contains a required substring (case-insensitive) — a correctness floor.
  recallContains(snap, args) {
    const text = String((args as { text?: unknown } | undefined)?.text ?? '');
    if (!snap.recall) return fail('recallContains', 'no recall result');
    return snap.recall.answer.toLowerCase().includes(text.toLowerCase()) ? pass('recallContains', `answer contains "${text}"`) : fail('recallContains', `answer missing "${text}"`);
  },
  // File-count bound for a vault dir (over-/under-extraction guard): { dir, min?, max? }.
  countBounds(snap, args) {
    const a = (args ?? {}) as { dir?: unknown; min?: unknown; max?: unknown };
    const dir = a.dir;
    if (dir !== 'entities' && dir !== 'claims' && dir !== 'sources') return fail('countBounds', "args.dir must be 'entities'|'claims'|'sources'");
    const count = snap[dir].length;
    const min = typeof a.min === 'number' ? a.min : 0;
    const max = typeof a.max === 'number' ? a.max : Infinity;
    return count >= min && count <= max ? pass('countBounds', `${dir}=${count} in [${min}, ${max === Infinity ? '∞' : max}]`) : fail('countBounds', `${dir}=${count} outside [${min}, ${max === Infinity ? '∞' : max}]`);
  },
  // A vault file at a path (suffix-matched across entities/claims/sources/outputs) exists: { path }.
  // For evergreen job artifacts (e.g. the example job's census note) + research findings.
  fileExists(snap, args) {
    const rel = String((args as { path?: unknown } | undefined)?.path ?? '');
    if (!rel) return fail('fileExists', 'args need { path }');
    const all = [...snap.entities, ...snap.claims, ...snap.sources, ...snap.outputs];
    return all.some((f) => f.path === rel || f.path.endsWith(rel)) ? pass('fileExists', `${rel} present`) : fail('fileExists', `no file matching ${rel}`);
  },
  // A vault file at `path` contains `text` (case-insensitive): { path, text }. Asserts a job/research
  // artifact's content (e.g. the census note's count, or a finding citing its source).
  fileContains(snap, args) {
    const a = (args ?? {}) as { path?: unknown; text?: unknown };
    if (typeof a.path !== 'string' || typeof a.text !== 'string') return fail('fileContains', 'args need { path, text }');
    const all = [...snap.entities, ...snap.claims, ...snap.sources, ...snap.outputs];
    const file = all.find((f) => f.path === a.path || f.path.endsWith(a.path as string));
    if (!file) return fail('fileContains', `no file matching ${a.path}`);
    return file.body.toLowerCase().includes((a.text as string).toLowerCase()) ? pass('fileContains', `${a.path} contains "${a.text}"`) : fail('fileContains', `${a.path} missing "${a.text}"`);
  },
  // At least one source body contains `text` (case-insensitive) — for a research finding citing its
  // external origin / carrying the expected fact (RESEARCH-6): { text }.
  sourcesContain(snap, args) {
    const text = String((args as { text?: unknown } | undefined)?.text ?? '');
    if (!text) return fail('sourcesContain', 'args need { text }');
    const n = snap.sources.filter((s) => s.body.toLowerCase().includes(text.toLowerCase())).length;
    return n > 0 ? pass('sourcesContain', `${n} source(s) contain "${text}"`) : fail('sourcesContain', `no source contains "${text}"`);
  },
  // At least `min` audit events of `eventType` were emitted (AUDIT assertions).
  auditEvents(snap, args) {
    const a = (args ?? {}) as { eventType?: unknown; min?: unknown };
    const eventType = String(a.eventType ?? '');
    const min = typeof a.min === 'number' ? a.min : 1;
    const n = snap.audit.filter((e) => e.eventType === eventType).length;
    return n >= min ? pass('auditEvents', `${n} '${eventType}' event(s) (≥${min})`) : fail('auditEvents', `${n} '${eventType}' event(s) (<${min})`);
  },
  // SPEC-0042 robustness (corrupted-vault eval): ≥`min` operational spans ended with `outcome` —
  // `setaside` proves a corrupted item was GRACEFULLY set aside (not a fatal drain crash); `ok`
  // proves the good items still completed (the drain finished the rest). Optional `stage` scopes it.
  spanOutcome(snap, args) {
    const a = (args ?? {}) as { outcome?: unknown; stage?: unknown; min?: unknown };
    const outcome = String(a.outcome ?? '');
    const stage = a.stage === undefined ? undefined : String(a.stage);
    const min = typeof a.min === 'number' ? a.min : 1;
    const n = snap.spans.filter((s) => s.outcome === outcome && (stage === undefined || s.stage === stage)).length;
    const where = stage ? ` (stage '${stage}')` : '';
    return n >= min
      ? pass('spanOutcome', `${n} span(s) outcome '${outcome}'${where} (≥${min})`)
      : fail('spanOutcome', `${n} span(s) outcome '${outcome}'${where} (<${min}) — telemetry didn't record it`);
  },
  // SPEC-0042 robustness: a failure was SURFACED in telemetry with a MESSAGE — ≥`min` (default 1)
  // dev-log `error` entries, optionally `contains` a substring (the error text / event / item id).
  // Guards the "errors logged nowhere" gap: a swallowed/silent failure → zero error entries → FAIL.
  telemetryError(snap, args) {
    const a = (args ?? {}) as { contains?: unknown; min?: unknown };
    const contains = a.contains === undefined ? undefined : String(a.contains).toLowerCase();
    const min = typeof a.min === 'number' ? a.min : 1;
    const errors = snap.devLog.filter((e) => e.level === 'error');
    const matched = contains === undefined ? errors : errors.filter((e) => JSON.stringify(e).toLowerCase().includes(contains));
    const tail = contains ? ` containing "${contains}"` : '';
    return matched.length >= min
      ? pass('telemetryError', `${matched.length} dev-log error(s)${tail} (≥${min}) — failure surfaced with a message`)
      : fail('telemetryError', `${matched.length} dev-log error(s)${tail} (<${min}) — failure not surfaced in telemetry`);
  },
};

/** Run a scenario's deterministic checks against the snapshot (EVAL-3). An unknown check name FAILS
 *  loudly (never silently skipped — a typo'd check must not read as a pass). */
export function runDeterministicChecks(snap: VaultSnapshot, checks: DeterministicCheck[]): CheckResult[] {
  return checks.map((c) => {
    const fn = VALIDATORS[c.check];
    if (!fn) return fail(c.check, `unknown deterministic check '${c.check}'`);
    return fn(snap, c.args);
  });
}
