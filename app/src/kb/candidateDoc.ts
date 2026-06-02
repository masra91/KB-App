// Render a Decompose CANDIDATE file (SPEC-0021 STAGING-5 / SPEC-0020 CONNECT §3.1).
//
// Decompose no longer writes resolved `entities/` nodes (CANON-4): it emits one per-mention
// CANDIDATE into the WORKING `candidates/` path on `staging`, which Connect later reads + resolves
// into evergreen `entities/`. The on-disk schema IS Connect's `Candidate` contract (connect.ts) —
// we serialize exactly those fields, in a stable key order, so Connect's `validCandidate` round-
// trips. JSON (not markdown) because candidates are machine-internal working state, never the
// human-facing evergreen knowledge that markdown nodes are (CANON-9): they live only on `staging`
// and are deleted once Connect consumes them. Layout mirrors `sources/`: a ULID-name file under a
// date shard derived from the id's own timestamp, so folder and id can never disagree.
import path from 'node:path';
import { dateShard } from './ulid';
import type { Candidate } from './connect';

/** Repo-relative path for a candidate file: `candidates/<dateShard(id)>/<id>.json`. */
export function candidateFileRel(id: string): string {
  return path.join('candidates', dateShard(id), `${id}.json`);
}

/**
 * Serialize a candidate to its on-disk JSON. Fields are written in the `Candidate` contract's
 * order (id, sourceId, kind, name, confidence, mentions) with a trailing newline — deterministic
 * output so a re-run of the same decision produces byte-identical files.
 */
export function renderCandidate(c: Candidate): string {
  const ordered: Candidate = {
    id: c.id,
    sourceId: c.sourceId,
    kind: c.kind,
    name: c.name,
    confidence: c.confidence,
    mentions: c.mentions,
  };
  return JSON.stringify(ordered, null, 2) + '\n';
}
