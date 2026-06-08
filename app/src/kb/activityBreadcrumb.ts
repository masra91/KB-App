// Activity breadcrumb (SPEC-0030 OBS-18) — a tiny in-memory record of "the last thing the pipeline
// was doing", so a crash handler can name the last `runId`/`itemId`/`stage` even when the trap is
// native and otherwise uncatchable. It is fed passively by the dev-log's `onEmit` hook (devlog.ts):
// every pipeline log line updates it, with NO change to stage code. Process-global on purpose — the
// crash handler reads one shared truth, and there is exactly one main process.
//
// Merge semantics: `ts`/`event` always advance to the latest line; `stage`/`runId`/`itemId` persist
// the LAST line that carried each (an id-less line — e.g. a `lock` heartbeat — must not erase which
// item we were mid-flight on). The result reads as "we were in <stage>, last touched <item>".

import type { EmitRecord } from './devlog';

export interface ActivityBreadcrumb {
  /** The most recent stage/scope a line was emitted under. */
  stage?: string;
  /** The last item id touched (persists across id-less lines). */
  itemId?: string;
  /** The last run id touched (persists across id-less lines). */
  runId?: string;
  /** The most recent log event name. */
  event?: string;
  /** When the most recent line was emitted (ISO). */
  ts?: string;
}

let current: ActivityBreadcrumb = {};

/** Fold a dev-log emit into the breadcrumb. Safe to pass the raw {@link EmitRecord} from `onEmit`. */
export function noteActivity(rec: { ts?: string; event?: string; scope?: string; runId?: string; itemId?: string }): void {
  const next: ActivityBreadcrumb = { ...current };
  if (rec.ts !== undefined) next.ts = rec.ts;
  if (rec.event !== undefined) next.event = rec.event;
  // Persist ids: only overwrite when the new line actually carries them.
  if (rec.scope !== undefined) next.stage = rec.scope;
  if (rec.runId !== undefined) next.runId = rec.runId;
  if (rec.itemId !== undefined) next.itemId = rec.itemId;
  current = next;
}

/** Adapter matching the dev-log `onEmit` signature — wire `createVaultDevLog({ onEmit: breadcrumbObserver })`. */
export function breadcrumbObserver(rec: EmitRecord): void {
  noteActivity(rec);
}

/** A snapshot of the last-known pipeline activity (the crash handler reads this). */
export function currentBreadcrumb(): ActivityBreadcrumb {
  return { ...current };
}

/** Clear the breadcrumb (tests; also a fresh pipeline start could reset it). */
export function resetBreadcrumb(): void {
  current = {};
}
