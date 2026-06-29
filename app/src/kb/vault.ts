// Vault setup domain logic: inspect a folder, ensure git, scaffold the KB structure,
// write config, and make the first commit. Shell-agnostic (no electron import).
//
// Grounds: DATA-1 (sources/entities/outputs), DATA-9 (git-backed), LIFE-2 (preserve),
// SETUP-3 (git from the start), SETUP-5 (init structure + first commit).
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import simpleGit, { type SimpleGit } from 'simple-git';
import {
  KB_CONFIG_VERSION,
  type VaultConfig,
  type PathInspection,
  type CreateKbOptions,
  type CreateKbResult,
} from './types';
import { detectCopilot } from './copilot';
import { ensureObsidianConfig } from './obsidianConfig';

const run = promisify(execFile);

// The three kinds of content (DATA-1), each its own top-level area in the vault.
const VAULT_DIRS = ['sources', 'entities', 'outputs'] as const;

export async function isGitInstalled(): Promise<boolean> {
  try {
    await run('git', ['--version'], { timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

async function safeIsRepo(git: SimpleGit): Promise<boolean> {
  try {
    return await git.checkIsRepo();
  } catch {
    return false;
  }
}

/** macOS TCC gates these per-app; the canonical iCloud Drive container too. */
const TCC_PROTECTED = [
  { name: 'Documents', segs: ['Documents'] },
  { name: 'Desktop', segs: ['Desktop'] },
  { name: 'Downloads', segs: ['Downloads'] },
  { name: 'iCloud Drive', segs: ['Library', 'Mobile Documents', 'com~apple~CloudDocs'] },
] as const;

/**
 * If `resolved` is AT or INSIDE a macOS TCC-protected location under `home`, return that location's
 * friendly name, else null. On non-darwin platforms always null (TCC is macOS-only). Pure — `home`
 * and `platform` are injected so it's deterministically testable (BUG #56 / STACK-10).
 *
 * Why it matters: macOS gates Documents/Desktop/Downloads/iCloud per-app. An unsigned/unentitled
 * dev build's git + copilot SUBPROCESSES don't inherit the folder grant, so their writes fail with
 * `Operation not permitted` — the pipeline silently never drains. Setup steers the user elsewhere.
 */
export function detectTccProtectedDir(resolved: string, home: string, platform: NodeJS.Platform): string | null {
  if (platform !== 'darwin') return null;
  for (const { name, segs } of TCC_PROTECTED) {
    const base = path.join(home, ...segs);
    const rel = path.relative(base, resolved);
    if (rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))) return name; // base itself or under it
  }
  return null;
}

export async function inspectPath(p: string): Promise<PathInspection> {
  const resolved = path.resolve(p);
  let exists = false;
  let isDirectory = false;
  try {
    const st = await fs.stat(resolved);
    exists = true;
    isDirectory = st.isDirectory();
  } catch {
    // path doesn't exist yet — fine, setup can create it
  }

  const gitInstalled = await isGitInstalled();
  let isGitRepo = false;
  if (exists && isDirectory && gitInstalled) {
    isGitRepo = await safeIsRepo(simpleGit(resolved));
  }

  let alreadyKb = false;
  try {
    await fs.access(path.join(resolved, '.kb', 'config.json'));
    alreadyKb = true;
  } catch {
    // not a KB yet
  }

  const copilot = await detectCopilot();
  const tccProtectedDir = detectTccProtectedDir(resolved, os.homedir(), process.platform);
  return { path: resolved, exists, isDirectory, gitInstalled, isGitRepo, alreadyKb, copilot, tccProtectedDir };
}

/** Set a local committer identity if none is resolvable, so commits never fail. */
export async function ensureGitIdentity(git: SimpleGit): Promise<void> {
  let email = '';
  try {
    email = (await git.raw(['config', 'user.email'])).trim();
  } catch {
    email = '';
  }
  if (!email) {
    await git.addConfig('user.email', 'kb-app@localhost');
    await git.addConfig('user.name', 'Vellum');
  }
}

async function writeIfAbsent(file: string, content: string): Promise<void> {
  try {
    await fs.access(file);
  } catch {
    await fs.writeFile(file, content);
  }
}

function readmeFor(cfg: VaultConfig): string {
  return `# ${cfg.name}

This is a **Vellum** knowledge base — the durable, git-versioned home for your
sources, entities, and synthesis outputs.

- \`sources/\`  — immutable primary & secondary sources (ground truth; never edited)
- \`entities/\` — the versioned knowledge graph (concepts, events, people, …)
- \`outputs/\`  — synthesis outputs (reports, answers), tagged as derived
- \`.kb/\`      — Vellum configuration

Managed by Vellum. You can also open this folder directly in Obsidian.
`;
}

const VAULT_GITIGNORE = `# Vellum — ignore rebuildable / derived caches (not ground truth)
.kb/cache/
.DS_Store
`;

export async function createKb(opts: CreateKbOptions): Promise<CreateKbResult> {
  const root = path.resolve(opts.path);

  if (!(await isGitInstalled())) {
    return { ok: false, message: 'git is not installed or not on PATH. Install git and try again.' };
  }

  await fs.mkdir(root, { recursive: true });
  const git = simpleGit(root);

  // SETUP-3: git-backed from the start.
  if (!(await safeIsRepo(git))) {
    if (!opts.initGitIfNeeded) {
      return { ok: false, message: 'Folder is not a git repository. Enable "Initialize git" to proceed.' };
    }
    await git.init();
  }
  await ensureGitIdentity(git);

  // DATA-1: scaffold the three content kinds (.gitkeep so empty dirs are tracked).
  for (const dir of VAULT_DIRS) {
    await fs.mkdir(path.join(root, dir), { recursive: true });
    await writeIfAbsent(path.join(root, dir, '.gitkeep'), '');
  }
  await fs.mkdir(path.join(root, '.kb'), { recursive: true });

  // Write config (idempotent: never overwrite an existing KB's identity).
  const cfgPath = path.join(root, '.kb', 'config.json');
  let config: VaultConfig | null = null;
  try {
    config = JSON.parse(await fs.readFile(cfgPath, 'utf8')) as VaultConfig;
  } catch {
    config = {
      schemaVersion: KB_CONFIG_VERSION,
      id: randomUUID(),
      name: opts.name?.trim() || path.basename(root),
      createdAt: new Date().toISOString(),
    };
    await fs.writeFile(cfgPath, JSON.stringify(config, null, 2) + '\n');
  }

  await writeIfAbsent(path.join(root, 'README.md'), readmeFor(config));
  await writeIfAbsent(path.join(root, '.gitignore'), VAULT_GITIGNORE);

  // SPEC-0031 VAULT-5/6: ship the curated `.obsidian/` config (entities-only graph, tag colors,
  // core-Obsidian defaults), non-destructively. Committed with the initial scaffold below.
  await ensureObsidianConfig(root);

  // SETUP-5: initial commit (only if there's something new to commit).
  await git.add('.');
  const status = await git.status();
  let committed = false;
  if (status.files.length > 0) {
    await git.commit('chore(kb): initialize knowledge base');
    committed = true;
  }

  return {
    ok: true,
    vaultConfig: config,
    committed,
    message: committed ? 'Library initialized and committed.' : 'Library already initialized (nothing new to commit).',
  };
}
