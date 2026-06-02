// The global per-Instance egress ceiling ledger (SPEC-0028 RESEARCH-11) — the persistent, rolling-window
// hard backstop on total research passes (external egress) this Instance performs. Unlike the dispatcher's
// per-dispatch burst cap (which resets every fan-out), this counts passes ACROSS dispatches + scheduled
// standing passes over a rolling window, so a slow runaway (a chain re-triggering itself tick after tick,
// or many standing researchers) can't egress unboundedly over time. It is enforced at `runResearcher` —
// the one chokepoint every pass (inline OR standing) flows through.
//
// Self-healing by design: timestamps older than the window are pruned on every check, so capacity returns
// automatically — it's a safety net, not a quota the Principal has to reset. The ledger lives in the
// working zone (`.kb/research/`, never promoted), beside the dedup `seen.json`.
import { promises as fs } from 'node:fs';
import path from 'node:path';

/** Persistent per-Instance pass ledger (working zone — never promoted). Epoch-ms timestamps of passes. */
const PASSES_REL = path.join('.kb', 'research', 'passes.json');

async function readPasses(root: string): Promise<number[]> {
  try {
    const parsed = JSON.parse(await fs.readFile(path.join(path.resolve(root), PASSES_REL), 'utf8')) as unknown;
    return Array.isArray(parsed) ? parsed.filter((x): x is number => typeof x === 'number' && Number.isFinite(x)) : [];
  } catch {
    return [];
  }
}

async function writePasses(root: string, passes: readonly number[]): Promise<void> {
  const p = path.join(path.resolve(root), PASSES_REL);
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, JSON.stringify(passes) + '\n', 'utf8');
}

/** Count of recorded passes still inside the rolling window at `nowMs` (pure — for tests + callers). */
export function passesInWindow(passes: readonly number[], nowMs: number, windowMs: number): number[] {
  return passes.filter((t) => t <= nowMs && nowMs - t < windowMs);
}

export interface CeilingAdmission {
  /** May this pass proceed to egress? `false` once the rolling-window count has hit the ceiling. */
  allowed: boolean;
  /** Passes already in the window (admitted ⇒ this pass is NOT included; refused ⇒ the count that blocked it). */
  countInWindow: number;
  /** The ceiling that was applied (for the audit/outcome message). */
  ceiling: number;
}

/**
 * Admit (or refuse) one research pass against the per-Instance ceiling (RESEARCH-11). Reads the ledger,
 * prunes it to the rolling window, and: if the in-window count has reached `ceiling`, REFUSES (no egress,
 * nothing recorded); otherwise records this pass's timestamp + persists (the pruned ledger, so it stays
 * bounded + self-healing) and ALLOWS it. Single Instance ⇒ passes are effectively serial (scheduler
 * single-flight + sequential dispatch), so a plain read-modify-write needs no extra lock.
 */
export async function admitResearchPass(root: string, nowMs: number, ceiling: number, windowMs: number): Promise<CeilingAdmission> {
  const inWindow = passesInWindow(await readPasses(root), nowMs, windowMs);
  if (inWindow.length >= ceiling) return { allowed: false, countInWindow: inWindow.length, ceiling };
  await writePasses(root, [...inWindow, nowMs]); // record this pass + drop aged-out entries in one write
  return { allowed: true, countInWindow: inWindow.length, ceiling };
}
