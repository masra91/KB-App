// Replay epochs (SPEC-0022 REPLAY-6) — the append-only mechanism that lets a full replay
// reset every stage's derived queue WITHOUT deleting audit history (DATA-10). The stage
// queue-readers derive "is this unit done?" by scanning each unit's append-only `audit.jsonl`
// for terminal markers (`decomposed`, `claimed`, `connected`, `setaside`). A replay appends a
// `replay-reset` epoch marker (per Source, plus once to the stage-wide connect audit); from
// then on the readers MUST honor only markers appended AFTER the latest epoch — so the unit
// looks unprocessed again and the pipeline re-derives it from scratch (ORCH-13: idempotent
// restart for free). History is preserved in full for Audit; nothing is rewritten.
//
// Single shared helper (not duplicated per stage) per the SPEC-0022 §5 open question — the
// only ORCH coupling this spec introduces. The marker is stage-agnostic: one epoch resets
// every stage for that unit, and the shape (a monotonic `replayId`) is forward-compatible
// with LIFE-12/13 partial replay (a partial replay appends the same marker to a subset).
import { ulid } from './ulid';

/** The append-only epoch marker event name. A line whose `event` equals this resets all
 *  stage queue-reading for the audit file it lives in. */
export const REPLAY_RESET_EVENT = 'replay-reset';

/** Mint a monotonically-increasing replay id (epoch). ULIDs are lexicographically time-
 *  sortable, so "the latest epoch" is well-defined and the id doubles as a timestamp. */
export function newReplayId(): string {
  return ulid();
}

/** One `replay-reset` audit line (with trailing newline) for an append-only `audit.jsonl`.
 *  `ts` is injectable for deterministic tests; defaults to now. */
export function replayResetLine(replayId: string, ts: string = new Date().toISOString()): string {
  return JSON.stringify({ ts, event: REPLAY_RESET_EVENT, replayId }) + '\n';
}

/**
 * Given the raw text of an append-only `audit.jsonl`, return only the lines appended AFTER
 * the latest `replay-reset` epoch marker (REPLAY-6). Lines at/before that marker belong to a
 * superseded generation and are ignored by stage queue-readers, so a replayed unit re-derives.
 * When there is no epoch marker, every line is returned (the common, non-replayed case).
 *
 * Append-only and non-destructive: this only narrows what readers *consider*; the history is
 * untouched on disk (DATA-10). Malformed lines are tolerated (they can't be epoch markers).
 */
export function epochScopedLines(raw: string): string[] {
  const lines = raw.split('\n');
  let lastReset = -1;
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    if (t.length === 0) continue;
    try {
      const o = JSON.parse(t) as { event?: string };
      if (o.event === REPLAY_RESET_EVENT) lastReset = i;
    } catch {
      /* malformed line — never an epoch marker; ignore */
    }
  }
  return lastReset === -1 ? lines : lines.slice(lastReset + 1);
}
