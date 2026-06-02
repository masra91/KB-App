// The Code researcher's read-only git layer (SPEC-0028 RESEARCH-10, Slice 2a). RESEARCH-10 is
// "read-only world": the Code researcher may clone/fetch a configured repo into its OWN isolated,
// gitignored workspace and READ history/trees/blobs — but must NEVER mutate the user's repo, its
// working tree, or a remote (no commit/push/comment/PR), and must never be steerable into running an
// arbitrary command. This module is the deterministic enforcement of that, behind which the cognition
// (codeResearchFn) stays a thin caller.
//
// THREAT MODEL — two layers, deny-by-default:
//   1. STRUCTURED OPERATIONS, not arbitrary git. Callers pick one of a fixed set of read-only ops
//      (clone/fetch + log/show/ls-files/grep/diff); each builds its OWN fixed arg vector. There is no
//      path for a caller (or an LLM driving a tool in 2b) to pass a raw subcommand — so write verbs
//      (commit/push/checkout/reset/remote/config-set) simply do not exist here.
//   2. OPTION-INJECTION GUARD. git can execute arbitrary commands even on a "read" subcommand via
//      `-c <cfg>`, `--upload-pack=`, `--receive-pack=`, `--exec=`, `core.sshCommand`, `protocol.ext`,
//      etc. So every user-supplied VALUE (ref / path / pattern) is validated to not be a flag (no
//      leading `-`), to carry no NUL/newline, and to stay within a sane charset/length; values are
//      placed positionally (after `--` where the subcommand supports it). The executor itself prepends
//      a fixed set of TRUSTED hardening flags (disable hooks, ssh, prompts, the `ext::` protocol),
//      runs via execFile (NO shell → no shell injection), pins cwd to the sandbox, and never inherits
//      askpass/ssh-command env that could exfiltrate or execute.
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { execFile } from 'node:child_process';
import { isSafeResearcherId } from './researchers';

/** The isolated, gitignored read workspace for a researcher (RESEARCH-10): `<root>/.kb/cache/
 *  researchers/<id>/`. `.kb/cache/` is gitignored + never promoted, so the clone never touches the
 *  user's tracked tree. `id` is slug-validated (no `/`, no `..`) so the path can't escape the cache;
 *  an unsafe id throws before any path is built. */
export function researcherWorkspace(root: string, id: string): string {
  if (!isSafeResearcherId(id)) throw new Error(`codeGit: refusing unsafe researcher id ${JSON.stringify(id)}`);
  return path.join(path.resolve(root), '.kb', 'cache', 'researchers', id);
}

/** Trusted hardening flags the executor ALWAYS prepends (never from caller input). They neutralize the
 *  git option-injection / command-execution surface: no hooks, no interactive/askpass prompts, no
 *  arbitrary transport helpers (`ext::`/`fd::`), no ssh-command override. */
const GIT_HARDENING = [
  '-c', 'core.hooksPath=/dev/null', // a fetched repo's hooks never run
  '-c', 'protocol.ext.allow=never', // block `ext::<cmd>` remote-helper command execution
  '-c', 'protocol.fd.allow=never',
  '-c', 'core.fsmonitor=false',
  '-c', 'core.sshCommand=', // no ssh-command override
  '-c', 'credential.helper=', // never invoke a credential helper (BYOA: gh/az own auth; 2a is local)
];

/** Hardened env: no terminal/askpass prompts (fail fast instead of hanging or leaking), and strip any
 *  inherited ssh/askpass overrides. Inherits the rest (PATH, etc.) so system `git` resolves. */
function hardenedEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.GIT_SSH_COMMAND;
  delete env.GIT_ASKPASS;
  delete env.SSH_ASKPASS;
  env.GIT_TERMINAL_PROMPT = '0';
  env.GIT_CONFIG_NOSYSTEM = '1'; // ignore /etc/gitconfig (no surprise hooks/aliases)
  return env;
}

/** A value supplied by a caller/agent (a ref, path, or grep pattern) that rides into a git arg. It
 *  must never be interpretable as a FLAG or carry control bytes — that is the option-injection guard. */
export function isSafeGitValue(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0 && v.length <= 512 && !v.startsWith('-') && !/[\0\n\r]/.test(v);
}

/** A git ref/branch/commit-ish: safe value + the conservative ref charset (no spaces, no `..`, no `~^:`
 *  range/peel operators that could widen scope unexpectedly). */
export function isSafeGitRef(v: unknown): v is string {
  return isSafeGitValue(v) && /^[A-Za-z0-9._/-]+$/.test(v) && !v.includes('..');
}

/** A repo-relative path argument: a safe value that cannot traverse out of the repo. */
export function isSafeRepoPath(v: unknown): v is string {
  if (!isSafeGitValue(v) || path.isAbsolute(v)) return false;
  return !v.split('/').includes('..');
}

/** One read-only operation the Code researcher may run (RESEARCH-10). The set IS the allowlist —
 *  there is no raw-subcommand escape hatch. */
export type GitReadOp =
  | { kind: 'log'; maxCount?: number; ref?: string; path?: string }
  | { kind: 'show'; ref: string; path?: string }
  | { kind: 'lsFiles' }
  | { kind: 'grep'; pattern: string; ref?: string }
  | { kind: 'diff'; refA: string; refB: string; path?: string };

/** A bounded positive integer for `--max-count` (defaults applied by the caller; never from raw input). */
function safeCount(n: number | undefined, dflt: number, max: number): number {
  if (n === undefined || !Number.isInteger(n) || n <= 0) return dflt;
  return Math.min(n, max);
}

/**
 * Build the FIXED, safe argv (after the hardening flags) for a read-only op. Throws on any unsafe
 * value rather than silently dropping it — a bad ref/path is a programming/injection error, not a
 * recoverable state. The returned argv never contains a caller-supplied FLAG (values are guarded +
 * placed after `--` where the subcommand parses pathspecs).
 */
export function buildGitReadArgs(op: GitReadOp): string[] {
  switch (op.kind) {
    case 'log': {
      const args = ['log', '--no-color', `--max-count=${safeCount(op.maxCount, 20, 500)}`, '--date=iso', '--pretty=format:%H%x09%ad%x09%an%x09%s'];
      if (op.ref !== undefined) {
        if (!isSafeGitRef(op.ref)) throw new Error('codeGit: unsafe ref');
        args.push(op.ref);
      }
      if (op.path !== undefined) {
        if (!isSafeRepoPath(op.path)) throw new Error('codeGit: unsafe path');
        args.push('--', op.path);
      }
      return args;
    }
    case 'show': {
      if (!isSafeGitRef(op.ref)) throw new Error('codeGit: unsafe ref');
      // `git show <ref>:<path>` reads a blob at a ref; path (if any) is validated + joined as the
      // object name (not a separate flag), so it can't be a flag and can't traverse out.
      if (op.path !== undefined) {
        if (!isSafeRepoPath(op.path)) throw new Error('codeGit: unsafe path');
        return ['show', '--no-color', `${op.ref}:${op.path}`];
      }
      return ['show', '--no-color', '--stat', op.ref];
    }
    case 'lsFiles':
      return ['ls-files'];
    case 'grep': {
      if (!isSafeGitValue(op.pattern)) throw new Error('codeGit: unsafe pattern');
      // `-e <pattern>` keeps the pattern from ever being parsed as an option even if it slipped the
      // leading-`-` guard; `--no-color`, fixed-strings to avoid regex surprises, line numbers for cites.
      const args = ['grep', '--no-color', '-n', '-I', '--fixed-strings', '-e', op.pattern];
      if (op.ref !== undefined) {
        if (!isSafeGitRef(op.ref)) throw new Error('codeGit: unsafe ref');
        args.push(op.ref);
      }
      return args;
    }
    case 'diff': {
      if (!isSafeGitRef(op.refA) || !isSafeGitRef(op.refB)) throw new Error('codeGit: unsafe ref');
      const args = ['diff', '--no-color', '--stat', op.refA, op.refB];
      if (op.path !== undefined) {
        if (!isSafeRepoPath(op.path)) throw new Error('codeGit: unsafe path');
        args.push('--', op.path);
      }
      return args;
    }
  }
}

export interface CodeGitOptions {
  /** Shallow-clone/fetch depth (default 1 — a researcher reads current state, not full history). */
  depth?: number;
  /** Per-git-invocation timeout, ms (default 60s). */
  timeoutMs?: number;
  /** Max captured stdout bytes (default 16 MiB) — a read, not a dump. */
  maxBuffer?: number;
}

/** True if `p` exists (any type). try/catch — `fs.stat`'s overloads make a `.catch` arrow infer `any`. */
async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.stat(p);
    return true;
  } catch {
    return false;
  }
}

/** Run one git invocation via execFile (NO shell) with the hardened env. `args` is the FULL argv
 *  after `git` (callers prepend `-C`/hardening + a built read-vector). Rejects on non-zero exit. */
function git(args: string[], cwd: string, opts: CodeGitOptions): Promise<{ stdout: string }> {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, env: hardenedEnv(), timeout: opts.timeoutMs ?? 60_000, maxBuffer: opts.maxBuffer ?? 16 * 1024 * 1024, windowsHide: true }, (err, stdout) => {
      if (err) reject(err);
      else resolve({ stdout: stdout.toString() });
    });
  });
}

/**
 * Validate a Slice-2a repo source: an ABSOLUTE LOCAL path to an existing git repository. Slice 2a is
 * local-only (RESEARCH-8 `local-only` tier) — no remote URLs (those are 2b, host-allowlisted), so a
 * `https://`/`git@`/`ext::` source is refused here, closing the clone-URL injection surface entirely.
 */
export async function assertLocalRepoSource(repoSource: string): Promise<void> {
  if (typeof repoSource !== 'string' || !path.isAbsolute(repoSource) || /[\0\n\r]/.test(repoSource)) {
    throw new Error('codeGit: repo source must be an absolute local path (Slice 2a is local-only)');
  }
  let isDir = false;
  try {
    isDir = (await fs.stat(repoSource)).isDirectory();
  } catch {
    isDir = false;
  }
  if (!isDir) throw new Error('codeGit: repo source path does not exist or is not a directory');
  if (!(await pathExists(path.join(repoSource, '.git')))) throw new Error('codeGit: repo source is not a git repository (.git not found)');
}

/**
 * Bring the researcher's isolated workspace current from `repoSource` (RESEARCH-10): first run clones
 * the validated LOCAL source into the (system-minted, gitignored) `workspace`; later runs `fetch` to
 * refresh. Shallow + `--no-tags`. Never touches the user's repo/worktree — it only writes inside the
 * sandbox. Hooks/transport-helpers/credential-helpers are disabled by GIT_HARDENING.
 */
export async function cloneOrRefresh(workspace: string, repoSource: string, opts: CodeGitOptions = {}): Promise<void> {
  await assertLocalRepoSource(repoSource);
  const depth = String(opts.depth ?? 1);
  const cloned = await pathExists(path.join(workspace, '.git'));
  if (cloned) {
    await git(['-C', workspace, ...GIT_HARDENING, 'fetch', '--no-tags', '--depth', depth, 'origin'], workspace, opts);
    return;
  }
  await fs.mkdir(path.dirname(workspace), { recursive: true });
  // `--` separates options from the (validated, absolute) source + target, so neither can be a flag.
  await git([...GIT_HARDENING, 'clone', '--no-tags', '--depth', depth, '--', repoSource, workspace], path.dirname(workspace), opts);
}

/** Run one read-only op (RESEARCH-10) in the workspace, returning its stdout. The op's argv is built by
 *  buildGitReadArgs (structured + value-guarded); GIT_HARDENING is prepended; cwd is the sandbox. */
export async function gitRead(workspace: string, op: GitReadOp, opts: CodeGitOptions = {}): Promise<string> {
  const { stdout } = await git(['-C', workspace, ...GIT_HARDENING, ...buildGitReadArgs(op)], workspace, opts);
  return stdout;
}
