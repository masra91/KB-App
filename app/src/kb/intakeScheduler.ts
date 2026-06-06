// The intake connector tick (SPEC-0041 INTAKE-1/11) — proactive feeds reuse the JOBS scheduler's
// *machinery shape* (coarse named-preset cadence via PRESET_INTERVAL_MS, restart-safe "due" derived
// from the last run, single-flight per id) but the EXECUTION BODY is `runIntakeConnector` (a pass →
// PRIMARY source via the ingest path), NOT the JobBehavior→write-sink flow. This is the exact seam
// researcherScheduler uses (a JobBehavior, a Researcher, and an intake Connector are distinct behavior
// shapes that share only scheduling) — it keeps JOBS-10 intact while letting INTAKE write `sources/`.
//
// "Due" comes from the connector's last `intake` audit event (its last pass) — survives restarts with
// no separate timer state, mirroring isJobDue / isResearcherDue.
import path from 'node:path';
import { PRESET_INTERVAL_MS } from './jobs';
import { readEvents } from './activityIndex';
import { readIntakeRegistry } from './intakeRegistry';
import { runIntakeConnector } from './intakeRun';
import { makeRssIntakeFn, type RssIntakeOptions } from './rssConnector';
import type { IntakeConnectorConfig, IntakeFetchFn } from './intakeConnectors';
import { noopDevLog, type DevLog } from './devlog';

/** Is a connector due for a pull? enabled + scheduled + (never-run OR last + interval ≤ now). */
export async function isIntakeDue(root: string, c: IntakeConnectorConfig, now: number): Promise<boolean> {
  if (!c.enabled || c.schedule === 'off') return false;
  const interval = PRESET_INTERVAL_MS[c.schedule];
  const events = await readEvents(root, { actors: ['intake'], subjectId: c.id }); // newest-first
  const last = events[0];
  if (!last) return true; // never run → due
  const lastMs = Date.parse(last.ts);
  return !Number.isFinite(lastMs) || now - lastMs >= interval;
}

/** Injected cognition/IO for the scheduler — RSS options (production) and/or a fetch override (tests). */
export interface IntakeDepsOptions {
  rss?: RssIntakeOptions;
  /** Force one fetch fn for every connector (tests) — bypasses the per-type selection. */
  fetchOverride?: IntakeFetchFn;
}

/** Select the fetch behavior for a connector by `type`. A not-yet-shipped type returns a fn that
 *  THROWS, so a mis-configured connector surfaces as a distinct `intake-failed` (never a silent
 *  no-op) — Slice 1 ships RSS; `m365-mail` lands in Slice 2 (SPEC-0041 F2). */
export function selectIntakeFn(c: IntakeConnectorConfig, opts: IntakeDepsOptions = {}): IntakeFetchFn {
  if (opts.fetchOverride) return opts.fetchOverride;
  switch (c.type) {
    case 'rss':
      return makeRssIntakeFn(opts.rss);
    case 'm365-mail':
      return async () => {
        throw new Error('m365-mail intake is not yet available (SPEC-0041 Slice 2)');
      };
    default:
      return async () => {
        throw new Error(`unknown intake connector type: ${(c as IntakeConnectorConfig).type}`);
      };
  }
}

export class IntakeScheduler {
  private readonly root: string;
  private readonly opts: IntakeDepsOptions;
  private readonly log: DevLog;
  private readonly inFlight = new Set<string>(); // single-flight per connector id (across ticks)
  private tickTimer: ReturnType<typeof setInterval> | null = null;
  private ticking = false;

  /** `root` is the staging worktree (where the registry + audit live + intake writes sources). */
  constructor(root: string, opts: IntakeDepsOptions = {}, log: DevLog = noopDevLog) {
    this.root = path.resolve(root);
    this.opts = opts;
    this.log = log;
  }

  start(tickMs = 60_000): void {
    void this.tick();
    if (this.tickTimer == null) {
      this.tickTimer = setInterval(() => void this.tick(), tickMs);
      this.tickTimer.unref?.();
    }
  }

  stop(): void {
    if (this.tickTimer) {
      clearInterval(this.tickTimer);
      this.tickTimer = null;
    }
  }

  /** One tick: a pull for every enabled+scheduled+due connector, serially, each single-flight.
   *  Returns the ids it fired. Ticks never overlap (`ticking` guard). */
  async tick(now: number = Date.now()): Promise<string[]> {
    if (this.ticking) return [];
    this.ticking = true;
    const fired: string[] = [];
    try {
      const connectors = await readIntakeRegistry(this.root);
      for (const c of connectors) {
        if (this.inFlight.has(c.id)) continue; // single-flight (JOBS-6 analogue)
        if (!(await isIntakeDue(this.root, c, now))) continue;
        fired.push(c.id);
        await this.runStanding(c, now);
      }
    } finally {
      this.ticking = false;
    }
    return fired;
  }

  /** Run one pull (single-flight-guarded). Never throws into the tick loop — a failed connector is
   *  logged + skipped (its own pass already audits `intake-failed`) so one bad feed can't stall others. */
  private async runStanding(c: IntakeConnectorConfig, now: number): Promise<void> {
    if (this.inFlight.has(c.id)) return;
    this.inFlight.add(c.id);
    try {
      const ts = new Date(now).toISOString(); // stamp the pass with the tick's logical time
      await runIntakeConnector(this.root, c, { fetch: selectIntakeFn(c, this.opts), now: () => ts });
    } catch (err) {
      this.log.child({ scope: 'intake-scheduler' }).error('intake-pass-failed', { itemId: c.id, err });
    } finally {
      this.inFlight.delete(c.id);
    }
  }
}
