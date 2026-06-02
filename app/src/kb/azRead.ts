// Read-only Azure DevOps (`az repos`) executor for the Code researcher's remote PR reads (SPEC-0028
// RESEARCH-9/10, Slice 2b). The Azure DevOps sibling of ghRead — same deny-by-default rigor, plus a
// HOST-ALLOWLISTED org URL (the remote-egress scoping KB-QD flagged for 2b).
//
// SECURITY (mirrors ghRead/codeGit):
//   - BYOA (RESEARCH-9): `az` owns its own auth (`az login` / `az devops login` with a PAT). KB-App
//     stores NO secrets + injects none; az absent/unauthed → typed `az-unavailable` graceful-degrade
//     (the cognition turns it into a no-finding + "configure az" hint), never a crash.
//   - STRUCTURED OPERATIONS, not arbitrary az — a fixed GET-only set (pr list / show). No raw
//     subcommand path, so mutating verbs (pr create/update/complete/abandon, vote, policy) don't exist.
//   - VALUE GUARD + ORG-HOST ALLOWLIST — the org is an HTTPS URL pinned to an Azure DevOps host
//     (`dev.azure.com` / `*.visualstudio.com`); project/repository are name-guarded (never a flag, no
//     control bytes); the PR `id` is a positive int. Every value is a separate execFile argv element
//     (NO shell), `--output json` structures output. buildAzReadArgs throws → azRead rejects pre-spawn.
import { execFile } from 'node:child_process';

/** The Azure DevOps PR target: the org URL + project + repository the researcher is CONFIG-pinned to. */
export interface AzdoTarget {
  org: string; // https://dev.azure.com/<org> or https://<org>.visualstudio.com
  project: string;
  repository: string;
}

/** Is `v` an allowlisted Azure DevOps org URL? HTTPS only, host `dev.azure.com` or `*.visualstudio.com`
 *  — the remote-egress host scoping (KB-QD 2b). No control bytes; bounded length. */
export function isAzdoOrgUrl(v: unknown): v is string {
  if (typeof v !== 'string' || v.length === 0 || v.length > 512 || /[\0\n\r]/.test(v)) return false;
  let u: URL;
  try {
    u = new URL(v);
  } catch {
    return false;
  }
  if (u.protocol !== 'https:') return false;
  const host = u.hostname.toLowerCase();
  return host === 'dev.azure.com' || host === 'visualstudio.com' || host.endsWith('.visualstudio.com');
}

/** An Azure DevOps project/repository NAME. Azure names may contain spaces + punctuation, and each is
 *  passed as a single execFile argv element (no shell), so the guard only has to stop it being a FLAG
 *  or carrying control bytes — never a leading `-`, no NUL/CR/LF, bounded length. */
export function isSafeAzName(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0 && v.length <= 256 && !v.startsWith('-') && !/[\0\n\r]/.test(v);
}

/** A complete, validated target (all three parts safe). */
export function isSafeAzTarget(t: unknown): t is AzdoTarget {
  if (!t || typeof t !== 'object') return false;
  const o = t as Record<string, unknown>;
  return isAzdoOrgUrl(o.org) && isSafeAzName(o.project) && isSafeAzName(o.repository);
}

const PR_STATUSES = ['active', 'completed', 'abandoned', 'all'] as const;
export type AzPrStatus = (typeof PR_STATUSES)[number];

/** One read-only `az repos` operation (RESEARCH-10). The set IS the allowlist — no raw-subcommand escape. */
export type AzReadOp =
  | { kind: 'prList'; status?: AzPrStatus; top?: number }
  | { kind: 'prShow'; id: number };

/** A PR id — positive integer. */
export function isSafeAzPrId(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v > 0 && v <= 100_000_000;
}

function safeTop(n: number | undefined, dflt: number, max: number): number {
  if (n === undefined || !Number.isInteger(n) || n <= 0) return dflt;
  return Math.min(n, max);
}

/**
 * Build the FIXED, safe argv for a read-only `az repos` op against the validated `target`. The org URL
 * + project + repository pin every call to the CONFIG-allowlisted target; `--output json` structures
 * output. Throws on any unsafe target/value rather than emitting it.
 */
export function buildAzReadArgs(target: AzdoTarget, op: AzReadOp): string[] {
  if (!isSafeAzTarget(target)) throw new Error('azRead: unsafe Azure DevOps target (org must be an allowlisted https URL; project/repository name-guarded)');
  const base = ['--organization', target.org, '--output', 'json'];
  switch (op.kind) {
    case 'prList': {
      const status: AzPrStatus = op.status && PR_STATUSES.includes(op.status) ? op.status : 'active';
      return ['repos', 'pr', 'list', '--project', target.project, '--repository', target.repository, '--status', status, '--top', String(safeTop(op.top, 20, 100)), ...base];
    }
    case 'prShow': {
      if (!isSafeAzPrId(op.id)) throw new Error('azRead: unsafe PR id');
      return ['repos', 'pr', 'show', '--id', String(op.id), ...base];
    }
  }
}

/** Hardened env for an az invocation: no interactive prompt. Auth is az's own (BYOA) — we neither set
 *  nor strip its credentials/PAT config (the user's `az` owns it). */
function azEnv(): NodeJS.ProcessEnv {
  return { ...process.env, AZURE_CORE_NO_COLOR: 'true', AZURE_CORE_ONLY_SHOW_ERRORS: 'true' };
}

export interface AzReadOptions {
  timeoutMs?: number;
  maxBuffer?: number;
}

/** An az read result, or a typed graceful-degrade signal when az is unavailable/unauthed (BYOA). */
export type AzReadResult = { ok: true; stdout: string } | { ok: false; reason: 'az-unavailable'; detail: string };

/**
 * Run one read-only `az repos` op (RESEARCH-9/10) against the allowlisted `target` via execFile (NO
 * shell), hardened env. BYOA: relies on the user's `az` auth. Returns `{ok:false, reason:'az-unavailable'}`
 * when az is missing (ENOENT) or fails (e.g. unauthed) — the cognition degrades to a no-finding + a
 * "configure az" hint, never crashing the dispatch.
 */
export async function azRead(target: AzdoTarget, op: AzReadOp, opts: AzReadOptions = {}): Promise<AzReadResult> {
  const args = buildAzReadArgs(target, op); // throws (→ rejects) on unsafe input BEFORE any spawn
  return new Promise<AzReadResult>((resolve) => {
    execFile('az', args, { env: azEnv(), timeout: opts.timeoutMs ?? 60_000, maxBuffer: opts.maxBuffer ?? 16 * 1024 * 1024, windowsHide: true }, (err, stdout) => {
      if (!err) {
        resolve({ ok: true, stdout: stdout.toString() });
        return;
      }
      const detail = (err as NodeJS.ErrnoException).code === 'ENOENT' ? 'az CLI not installed (BYOA — install + `az login`)' : `az read failed (az may be unauthed / devops extension missing): ${err.message}`;
      resolve({ ok: false, reason: 'az-unavailable', detail });
    });
  });
}
