// SPEC-0042 EVAL Slice-3 — cassette persistence (fork S3-B): COMMITTED JSON cassettes, secret-scrubbed,
// `--live` to refresh. Cassettes are reproducibility INPUTS (unlike the gitignored Slice-2 baselines, which
// are run outputs) so they're committed + reviewed like code. Load asserts the file is clean + public-web
// before it can be replayed; save asserts before it can be written — an unscrubbed cassette never lands.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { type Cassette, type CassetteEntry, assertCassetteClean } from './cassette';

function asEntry(v: unknown, i: number): CassetteEntry {
  if (typeof v !== 'object' || v === null) throw new Error(`cassette entries[${i}] must be an object`);
  const e = v as Record<string, unknown>;
  if (typeof e.url !== 'string') throw new Error(`cassette entries[${i}].url must be a string`);
  if (typeof e.status !== 'number') throw new Error(`cassette entries[${i}].status must be a number`);
  if (typeof e.text !== 'string') throw new Error(`cassette entries[${i}].text must be a string`);
  return { url: e.url, status: e.status, text: e.text, truncated: e.truncated === true };
}

/** Parse + validate a raw JSON value into a Cassette (fail-fast on a malformed shape or dirty tier). */
export function parseCassette(raw: unknown): Cassette {
  if (typeof raw !== 'object' || raw === null) throw new Error('cassette must be a JSON object');
  const o = raw as Record<string, unknown>;
  if (o.tier !== 'public-web') throw new Error(`cassette.tier must be 'public-web' (got ${JSON.stringify(o.tier)})`);
  if (!Array.isArray(o.entries)) throw new Error('cassette.entries must be an array');
  const cassette: Cassette = { tier: 'public-web', entries: o.entries.map(asEntry) };
  assertCassetteClean(cassette); // fail-loud: a committed cassette with leaked secrets must never replay
  return cassette;
}

/** Read + validate a committed cassette file (the eval harness loads this for a replay run). */
export async function loadCassette(file: string): Promise<Cassette> {
  let text: string;
  try {
    text = await fs.readFile(file, 'utf8');
  } catch (e) {
    throw new Error(`cassette not found: ${file} (run the scenario with --live to record it) — ${e instanceof Error ? e.message : e}`);
  }
  return parseCassette(JSON.parse(text));
}

/** Write a recorded cassette (pretty JSON, stable order) — asserts clean first so a dirty one can't land. */
export async function saveCassette(file: string, cassette: Cassette): Promise<void> {
  assertCassetteClean(cassette);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(cassette, null, 2) + '\n', 'utf8');
}
