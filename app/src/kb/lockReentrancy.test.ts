// Mutex (canonical-writer lock) behavior docs + a PARKED re-entrancy guardrail (#163).
//
// #163's silent wedge turned out NOT to be re-entrancy: a full lock-safety audit found no nested
// `lock.run` on the same Mutex anywhere, and the real cause was an UNBOUNDED in-section git op
// (fixed by routing the canonical writers through `boundedGit` — see boundedCanonicalGit.test.ts).
//
// A re-entrancy fail-fast (a re-entrant `lock.run` → throw) is therefore a guardrail for a bug that
// doesn't exist today, and #170's stuck-section watchdog already de-silences any hypothetical future
// one (names it as `lock.stuck holder=<label>` within the threshold). Per DEV-2 we DEFER the throw
// (it would need AsyncLocalStorage on the hot shared Mutex + detaching the legitimate `void poke()`
// context — real false-positive risk for marginal gain). So case 1 below is `it.skip`, kept ready
// in case we ever revisit; cases 2 + 3 are live docs of the Mutex behavior the guardrail must never
// break (serialized re-acquire, and the fire-and-forget detached follow-up).
import { describe, it, expect } from 'vitest';
import { Mutex } from './stageLock';

/** Resolve to `TIMEOUT` if `p` hasn't settled in `ms` — turns a (hypothetical) deadlock into a
 *  clean, bounded assertion instead of an infinite hang the runner would have to kill. */
const TIMEOUT = Symbol('did-not-settle');
function within<T>(p: Promise<T>, ms: number): Promise<T | typeof TIMEOUT> {
  return Promise.race([p, new Promise<typeof TIMEOUT>((res) => setTimeout(() => res(TIMEOUT), ms))]);
}

describe('Mutex re-entrancy + detachment (#163)', () => {
  // DEFERRED guardrail (#163 reframe): no current re-entrancy exists, and #170's watchdog surfaces a
  // hypothetical one as a named `lock.stuck` meanwhile — so we don't ship the fail-fast throw. Kept
  // skipped (RED today: a re-entrant acquire deadlocks) so it's ready if we ever add the guardrail.
  it.skip('[deferred] an awaited re-acquire of the same Mutex should fail fast instead of deadlocking', async () => {
    const lock = new Mutex();
    const reentrant = lock.run(async () => {
      await lock.run(async () => 'inner'); // <-- awaited re-acquire on the SAME mutex (would deadlock today)
      return 'outer-completed';
    });
    const outcome = await within(
      reentrant.then((v) => ({ kind: 'resolved' as const, v }), (e) => ({ kind: 'rejected' as const, e })),
      300,
    );
    expect(outcome).not.toBe(TIMEOUT); // a future fail-fast would reject, not hang
    if (outcome !== TIMEOUT) {
      expect(outcome.kind).toBe('rejected');
    }
  });

  it('a sequential (post-release) re-acquire of the same Mutex works', async () => {
    // The normal serialized case: acquiring again AFTER the prior section settled is fine.
    const lock = new Mutex();
    const a = await lock.run(async () => 'a');
    const b = await lock.run(async () => 'b'); // prior section already settled — not re-entrant
    expect([a, b]).toEqual(['a', 'b']);
  });

  it('a context-detached follow-up run (the `void poke()` shape) does NOT deadlock or throw', async () => {
    // The legitimate fire-and-forget pattern: a held section schedules a follow-up drain on a LATER
    // task (context-detached), not awaited inside the section. The outer returns → the lock releases
    // → the detached run acquires cleanly. This models `void connect.poke()` (claims afterDrain) — a
    // live regression guard that any future Mutex change (or guardrail) must keep working.
    const lock = new Mutex();
    const ran: string[] = [];
    let detachedErr: unknown = null;
    await lock.run(async () => {
      ran.push('outer');
      setTimeout(() => {
        void lock.run(async () => { ran.push('detached'); }).catch((e) => { detachedErr = e; });
      }, 0);
    });
    await new Promise((r) => setTimeout(r, 50)); // let the detached follow-up run after release
    expect(detachedErr).toBeNull();
    expect(ran).toEqual(['outer', 'detached']);
  });
});
