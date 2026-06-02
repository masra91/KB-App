// Resolve the user's real PATH for GUI-launched apps (SPEC-0010 STACK-9).
//
// macOS (and Linux) GUI launches (Finder/Dock/launchd) give a process a minimal PATH
// (/usr/bin:/bin:/usr/sbin:/sbin) — NOT the user's login-shell PATH. Anything we spawn by
// name (copilot, gh, git) then fails to resolve even though it works from a terminal.
// Verified: with the minimal PATH `copilot` is "command not found"; with /opt/homebrew/bin
// (or the login-shell PATH) prepended it runs. This module recomputes a complete PATH so
// child_process spawns behave the same regardless of how the app was launched.
//
// Pure + injectable: the shell invocation is passed in, so the merge logic is unit-tested in
// the node tier (no spawning, no Electron) — STACK-6 / TEST-2.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, statSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const run = promisify(execFile);

/** Common locations user-installed CLIs live that a GUI PATH usually omits. */
export function defaultFallbackDirs(home: string = os.homedir()): string[] {
  return ['/opt/homebrew/bin', '/opt/homebrew/sbin', '/usr/local/bin', `${home}/.local/bin`, `${home}/.npm-global/bin`];
}

/**
 * Merge `resolved` (login-shell PATH) and `fallbacks` ahead of `current`, de-duplicated,
 * order-preserving, dropping empty segments. Pure — this is the heart of the fix and what
 * the tests assert.
 */
export function mergePath(current: string | undefined, resolved: string | undefined, fallbacks: string[]): string {
  const parts: string[] = [];
  const seen = new Set<string>();
  const add = (p: string): void => {
    const t = p.trim();
    if (t.length === 0 || seen.has(t)) return;
    seen.add(t);
    parts.push(t);
  };
  for (const seg of (resolved ?? '').split(':')) add(seg);
  for (const f of fallbacks) add(f);
  for (const seg of (current ?? '').split(':')) add(seg);
  return parts.join(':');
}

/** Injectable shell runner (tests pass a fake; production shells out). */
export type ShellRunner = (shell: string, args: string[]) => Promise<string>;

const defaultRunner: ShellRunner = async (shell, args) => {
  const { stdout } = await run(shell, args, { timeout: 4000, maxBuffer: 1024 * 1024 });
  return stdout;
};

/**
 * Ask the user's login shell for its PATH via `$SHELL -ilc`, so rc/profile files that set
 * PATH (Homebrew, nvm, pyenv, …) are sourced. Returns null on any failure (no $SHELL,
 * timeout, odd shell) so the caller falls back to {@link defaultFallbackDirs}.
 */
export async function loginShellPath(opts: { shell?: string; runner?: ShellRunner } = {}): Promise<string | null> {
  const shell = opts.shell ?? process.env.SHELL ?? '';
  if (shell.length === 0) return null;
  const runner = opts.runner ?? defaultRunner;
  try {
    // Mark our output so we can ignore any banner/noise an interactive rc prints first.
    const out = await runner(shell, ['-ilc', 'printf "__KBPATH__%s\\n" "$PATH"']);
    for (const raw of out.split('\n')) {
      const line = raw.trim();
      if (line.startsWith('__KBPATH__')) {
        const p = line.slice('__KBPATH__'.length);
        return p.includes('/') ? p : null;
      }
    }
    return null;
  } catch {
    return null;
  }
}

export interface EnsurePathOptions {
  /** Environment to read/mutate; defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
  /** Defaults to `process.platform`. */
  platform?: NodeJS.Platform;
  shell?: string;
  runner?: ShellRunner;
  fallbacks?: string[];
  home?: string;
}

/**
 * Augment `env.PATH` so GUI-launched processes can find user-installed CLIs (copilot, gh,
 * git). No-op on Windows (different model). Idempotent. Returns the PATH it set.
 */
export async function ensurePath(opts: EnsurePathOptions = {}): Promise<string> {
  const env = opts.env ?? process.env;
  const platform = opts.platform ?? process.platform;
  if (platform === 'win32') return env.PATH ?? '';
  const resolved = await loginShellPath({ shell: opts.shell, runner: opts.runner });
  const fallbacks = opts.fallbacks ?? defaultFallbackDirs(opts.home);
  const merged = mergePath(env.PATH, resolved ?? undefined, fallbacks);
  env.PATH = merged;
  return merged;
}

/**
 * Resolve an executable to its absolute path by scanning `PATH` (a `which`/`where` in pure JS, no
 * subprocess). Used to give the Copilot SDK an explicit `cliPath` for the user's BYOA `copilot`
 * binary (SPEC-0030 BUG #65 / ORCH-21): in the packaged app the SDK's default search can't reach a
 * binary, and `copilot` lives on the (STACK-9-ensured) PATH — pass the resolved path so it spawns.
 * Returns the first match, or null if not found. On Windows, also tries PATHEXT-style suffixes.
 */
export function resolveExecutable(name: string, env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string | null {
  const dirs = (env.PATH ?? '').split(path.delimiter).filter((d) => d.length > 0);
  const candidates = platform === 'win32' ? [name, `${name}.exe`, `${name}.cmd`, `${name}.bat`] : [name];
  for (const dir of dirs) {
    for (const cand of candidates) {
      const full = path.join(dir, cand);
      try {
        if (existsSync(full) && statSync(full).isFile()) return full;
      } catch {
        /* unreadable entry — skip */
      }
    }
  }
  return null;
}
