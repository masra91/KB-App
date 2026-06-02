// Read-only GitHub (`gh`) executor for the Code researcher's remote PR reads (SPEC-0028 RESEARCH-9/10,
// Slice 2b). This is the REMOTE egress Slice 2a deliberately excluded — so it carries the same
// deny-by-default rigor as the local git layer (codeGit), plus a repo/host allowlist and BYOA auth.
//
// SECURITY (mirrors codeGit; KB-QD's 2b gate):
//   - BYOA (RESEARCH-9): `gh` owns its own auth (`gh auth login` / `GH_TOKEN`). KB-App stores NO
//     secrets and never injects credentials; if `gh` is absent or unauthed we GRACEFULLY DEGRADE
//     (a typed `gh-unavailable` outcome the cognition turns into a no-finding + a "configure gh" hint),
//     never a crash.
//   - STRUCTURED OPERATIONS, not arbitrary gh — a fixed GET-only set (pr list / view / diff). No raw
//     subcommand path, so write/mutating verbs (pr create/merge/close/comment, `api` with a method,
//     `repo`/`auth` mutations) simply don't exist here.
//   - VALUE GUARD + HOST/REPO ALLOWLIST — the only caller-supplied values are the target `repo`
//     (`owner/name`, charset-validated, never a flag) and a PR `number` (positive int). The repo must
//     match the researcher's configured allowlisted repo; `--repo <owner/name>` pins every call to it.
//     execFile (NO shell); env hardened (no pager/prompt; auth left to gh).
import { execFile } from 'node:child_process';

/** A configured GitHub repo target `owner/name` (e.g. `octocat/hello-world`). Charset-guarded so it
 *  can never be a flag or carry shell/control bytes; exactly one `/` separating two slug segments. */
export function isSafeGhRepo(v: unknown): v is string {
  return typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/.test(v) && v.length <= 256;
}

/** A PR number — a positive integer (never a flag/string that could smuggle options). */
export function isSafePrNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v > 0 && v <= 10_000_000;
}

const PR_STATES = ['open', 'closed', 'merged', 'all'] as const;
export type PrState = (typeof PR_STATES)[number];

/** One read-only `gh` operation (RESEARCH-10). The set IS the allowlist — no raw-subcommand escape. */
export type GhReadOp =
  | { kind: 'prList'; state?: PrState; limit?: number }
  | { kind: 'prView'; number: number }
  | { kind: 'prDiff'; number: number };

function safeLimit(n: number | undefined, dflt: number, max: number): number {
  if (n === undefined || !Number.isInteger(n) || n <= 0) return dflt;
  return Math.min(n, max);
}

/**
 * Build the FIXED, safe argv for a read-only gh op against `repo`. `--repo <owner/name>` pins every
 * call to the validated, allowlisted repo; `--json <fixed fields>` keeps output structured (and
 * sidesteps the pager). Throws on any unsafe value rather than emitting it.
 */
export function buildGhReadArgs(repo: string, op: GhReadOp): string[] {
  if (!isSafeGhRepo(repo)) throw new Error('ghRead: unsafe repo (expected owner/name)');
  switch (op.kind) {
    case 'prList': {
      const state: PrState = op.state && PR_STATES.includes(op.state) ? op.state : 'open';
      return ['pr', 'list', '--repo', repo, '--state', state, '--limit', String(safeLimit(op.limit, 20, 100)), '--json', 'number,title,author,state,updatedAt,url'];
    }
    case 'prView': {
      if (!isSafePrNumber(op.number)) throw new Error('ghRead: unsafe PR number');
      return ['pr', 'view', String(op.number), '--repo', repo, '--json', 'number,title,body,author,state,url,updatedAt'];
    }
    case 'prDiff': {
      if (!isSafePrNumber(op.number)) throw new Error('ghRead: unsafe PR number');
      return ['pr', 'diff', String(op.number), '--repo', repo];
    }
  }
}

/** Hardened env for a gh invocation: no interactive prompt, no pager. Auth is gh's own (BYOA) — we
 *  neither set nor strip GH_TOKEN/GH_HOST (the user's gh config owns it). */
function ghEnv(): NodeJS.ProcessEnv {
  return { ...process.env, GH_PROMPT_DISABLED: '1', GH_PAGER: 'cat', GH_NO_UPDATE_NOTIFIER: '1' };
}

export interface GhReadOptions {
  timeoutMs?: number;
  maxBuffer?: number;
}

/** A gh read result, or a typed graceful-degrade signal when gh is unavailable/unauthed (BYOA). */
export type GhReadResult = { ok: true; stdout: string } | { ok: false; reason: 'gh-unavailable'; detail: string };

/**
 * Run one read-only gh op (RESEARCH-9/10) against the allowlisted `repo` via execFile (NO shell), with
 * hardened env. BYOA: relies on the user's `gh` auth. Returns `{ok:false, reason:'gh-unavailable'}`
 * when gh is missing (ENOENT) or fails (e.g. unauthed) — the cognition degrades to a no-finding + a
 * "configure gh" hint, never crashing the dispatch.
 */
export async function ghRead(repo: string, op: GhReadOp, opts: GhReadOptions = {}): Promise<GhReadResult> {
  const args = buildGhReadArgs(repo, op); // throws (→ rejects) on unsafe input BEFORE any spawn
  return new Promise<GhReadResult>((resolve) => {
    execFile('gh', args, { env: ghEnv(), timeout: opts.timeoutMs ?? 60_000, maxBuffer: opts.maxBuffer ?? 16 * 1024 * 1024, windowsHide: true }, (err, stdout) => {
      if (!err) {
        resolve({ ok: true, stdout: stdout.toString() });
        return;
      }
      const detail = (err as NodeJS.ErrnoException).code === 'ENOENT' ? 'gh CLI not installed (BYOA — run `gh auth login`)' : `gh read failed (gh may be unauthed): ${err.message}`;
      resolve({ ok: false, reason: 'gh-unavailable', detail });
    });
  });
}
