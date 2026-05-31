// Capture domain (SPEC-0013): preservation-first arrival. Each payload becomes its own
// immutable inbox unit and the batch is committed BEFORE any processing (CAPTURE-3).
// Shell-agnostic (no electron import) — the IPC layer reads dropped-file bytes and hands
// them here. The archivist (orchestrator.ts) later moves units into `sources/`.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import simpleGit from 'simple-git';
import { ulid, isUlid } from './ulid';
import { ensureGitIdentity } from './vault';
import { mimeForName, rawNameFor } from './media';

export interface TextPayload {
  kind: 'text';
  text: string;
}
export interface FilePayload {
  kind: 'file';
  name: string; // original filename
  data: Uint8Array; // raw bytes (read by the IPC layer)
}
export type CapturePayload = TextPayload | FilePayload;

/** The `captured` event written to each unit's `audit.jsonl`; the archivist reads it to
 *  build `source.md`. `source.md` = identity; `audit.jsonl` = history (SPEC-0013 §3). */
export interface CapturedMeta {
  id: string;
  kind: 'text' | 'file';
  raw: string; // raw filename inside the unit
  contentHash: string; // `sha256:<hex>`
  capturedAt: string; // ISO 8601
  surface: string;
  captureBatch: string; // links payloads from one capture gesture (CAPTURE-14)
  origin?: 'principal' | 'external'; // who produced it; defaults to principal (DATA-2/5)
  originalName?: string;
  mimeType?: string;
  bytes?: number;
}

export interface CaptureOutcome {
  ids: string[];
  captureBatch: string;
  committed: boolean;
}

function sha256(data: Uint8Array): string {
  return 'sha256:' + createHash('sha256').update(data).digest('hex');
}

/**
 * Write each payload as an immutable `inbox/<ULID>/` unit and commit the batch.
 * Add-only + globally-unique ULIDs ⇒ never conflicts with archiving or other captures
 * (CAPTURE-5). One unit per payload, all sharing a `captureBatch` (CAPTURE-14).
 */
export async function captureToInbox(
  root: string,
  surface: string,
  payloads: CapturePayload[],
  now: number = Date.now(),
): Promise<CaptureOutcome> {
  if (payloads.length === 0) throw new Error('captureToInbox: nothing to capture');
  root = path.resolve(root);
  const captureBatch = ulid(now);
  const capturedAt = new Date(now).toISOString();
  const ids: string[] = [];

  for (const p of payloads) {
    const id = ulid(now);
    const dir = path.join(root, 'inbox', id);
    await fs.mkdir(dir, { recursive: true });

    let meta: CapturedMeta;
    if (p.kind === 'text') {
      const data = new TextEncoder().encode(p.text);
      await fs.writeFile(path.join(dir, 'raw.txt'), p.text, 'utf8');
      meta = {
        id,
        kind: 'text',
        raw: 'raw.txt',
        contentHash: sha256(data),
        capturedAt,
        surface,
        captureBatch,
        mimeType: 'text/plain',
      };
    } else {
      const raw = rawNameFor(p.name);
      await fs.writeFile(path.join(dir, raw), Buffer.from(p.data));
      meta = {
        id,
        kind: 'file',
        raw,
        contentHash: sha256(p.data),
        capturedAt,
        surface,
        captureBatch,
        originalName: p.name,
        mimeType: mimeForName(p.name),
        bytes: p.data.byteLength,
      };
    }
    await fs.writeFile(path.join(dir, 'audit.jsonl'), JSON.stringify({ action: 'captured', ...meta }) + '\n', 'utf8');
    ids.push(id);
  }

  // CAPTURE-3: commit the raw units before anything processes them. Add-only — staging
  // just `inbox` keeps capture from sweeping up unrelated working state.
  const git = simpleGit(root);
  await ensureGitIdentity(git);
  await git.raw('add', 'inbox');
  await git.commit(`capture: ${payloads.length} item(s) [${surface}]`);

  return { ids, captureBatch, committed: true };
}

/** Read the `captured` event back from a unit's `audit.jsonl` (first line). */
export async function readCapturedMeta(unitDir: string): Promise<CapturedMeta> {
  const raw = await fs.readFile(path.join(unitDir, 'audit.jsonl'), 'utf8');
  const first = raw.split('\n').find((l) => l.trim().length > 0);
  if (!first) throw new Error(`no captured event in ${unitDir}/audit.jsonl`);
  const obj = JSON.parse(first) as Partial<CapturedMeta> & { action?: string };
  if (!obj.id || !obj.kind || !obj.raw) throw new Error(`malformed captured event in ${unitDir}`);
  return obj as CapturedMeta;
}

/**
 * Adopt foreign drops (SPEC-0014 ORCH-14): the inbox is a contract that also accepts loose
 * files dropped by another app / directly on disk (no ULID, no audit). Wrap each into a
 * canonical `inbox/<ULID>/` unit (`origin: external`, `surface: folder-drop`) and commit,
 * so the archivist can process them like any capture. Idempotent: canonical `<ULID>/`
 * units are left untouched. Returns the ids minted this pass.
 */
export async function normalizeInbox(root: string, now: number = Date.now()): Promise<string[]> {
  root = path.resolve(root);
  const inbox = path.join(root, 'inbox');
  let entries: import('node:fs').Dirent[];
  try {
    entries = await fs.readdir(inbox, { withFileTypes: true });
  } catch {
    return [];
  }

  const minted: string[] = [];
  for (const e of entries) {
    if (e.name.startsWith('.')) continue; // skip hidden/system files (e.g. .DS_Store)
    if (e.isDirectory() && isUlid(e.name)) continue; // already a canonical unit
    if (!e.isFile()) continue; // non-canonical dirs: left for the archivist's failure path

    const id = ulid(now);
    const dir = path.join(inbox, id);
    await fs.mkdir(dir, { recursive: true });
    const raw = rawNameFor(e.name);
    const data = await fs.readFile(path.join(inbox, e.name));

    const meta: CapturedMeta = {
      id,
      kind: 'file',
      raw,
      contentHash: sha256(data),
      capturedAt: new Date(now).toISOString(),
      surface: 'folder-drop',
      captureBatch: id,
      origin: 'external',
      originalName: e.name,
      mimeType: mimeForName(e.name),
      bytes: data.byteLength,
    };
    // Write the canonical unit fully BEFORE removing the original — the raw bytes are
    // never at risk (the original survives until its copy + audit are on disk).
    await fs.writeFile(path.join(dir, raw), data);
    await fs.writeFile(path.join(dir, 'audit.jsonl'), JSON.stringify({ action: 'captured', ...meta }) + '\n', 'utf8');
    await fs.rm(path.join(inbox, e.name));
    minted.push(id);
  }

  if (minted.length > 0) {
    const git = simpleGit(root);
    await ensureGitIdentity(git);
    await git.raw('add', 'inbox');
    await git.commit(`normalize: ${minted.length} foreign drop(s)`);
  }
  return minted;
}
