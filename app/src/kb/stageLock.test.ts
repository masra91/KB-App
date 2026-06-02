// The canonical-writer Mutex (SPEC-0014 §5) + its OBS-7 introspection (SPEC-0030). Serialization
// semantics must be unchanged; `state()` is read-only bookkeeping for the Status view.
import { describe, it, expect } from 'vitest';
import { Mutex } from './stageLock';

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 5));

describe('Mutex (canonical writer)', () => {
  it('serializes sections — they never overlap, order preserved', async () => {
    const lock = new Mutex();
    const log: string[] = [];
    const section = (name: string) => async (): Promise<void> => {
      log.push(`${name}:start`);
      await tick();
      log.push(`${name}:end`);
    };
    await Promise.all([lock.run(section('a')), lock.run(section('b')), lock.run(section('c'))]);
    // Each section fully completes before the next starts (no interleaving), FIFO order.
    expect(log).toEqual(['a:start', 'a:end', 'b:start', 'b:end', 'c:start', 'c:end']);
  });

  it('a throwing section never wedges the lock (chain advances)', async () => {
    const lock = new Mutex();
    await expect(lock.run(async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    // The next section still runs (the original `prev.then(fn, fn)` resilience).
    await expect(lock.run(async () => 42)).resolves.toBe(42);
    expect(lock.state().held).toBe(false);
  });

  it('state() reports held + waiters + holder while a section runs (OBS-7)', async () => {
    const lock = new Mutex();
    expect(lock.state()).toMatchObject({ held: false, waiters: 0 });

    let releaseFirst: () => void = () => {};
    const firstDone = new Promise<void>((r) => (releaseFirst = r));
    const first = lock.run(async () => { await firstDone; }, 'decompose');
    const second = lock.run(async () => {}, 'connect'); // queues behind `first`
    await tick(); // let `first` acquire

    const s = lock.state();
    expect(s.held).toBe(true);
    expect(s.holder).toBe('decompose'); // the running section's label
    expect(typeof s.since).toBe('string');
    expect(s.waiters).toBe(1); // `second` is waiting

    releaseFirst();
    await Promise.all([first, second]);
    expect(lock.state()).toMatchObject({ held: false, waiters: 0 });
    expect(lock.state().holder).toBeUndefined();
  });

  it('an unlabelled section still reports held (label is optional)', async () => {
    const lock = new Mutex();
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    const p = lock.run(async () => { await gate; }); // no label
    await tick();
    expect(lock.state().held).toBe(true);
    expect(lock.state().holder).toBeUndefined();
    release();
    await p;
  });
});
