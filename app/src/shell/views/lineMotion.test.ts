// @vitest-environment happy-dom
//
// SPEC-0032 §5 motion (VIZ-1 odometer + signature index, VIZ-6 reduced-motion parity). Pure logic +
// DOM passes driven by a synchronous fake rAF/clock — no real timers. ENG-15/16: malformed elements
// are skipped (never throw) and one bad element never aborts the rest.
import { describe, it, expect } from 'vitest';
import {
  easeOut,
  tweenValue,
  parseCount,
  rollNumber,
  applyOdometers,
  applyIndex,
  ODOMETER_MS,
  type MotionEnv,
} from './lineMotion';

/** A fake env: `raf` queues callbacks; `flush()` drains them while advancing the clock past the roll. */
function fakeEnv(reduced = false): MotionEnv & { flush: () => void; setNow: (t: number) => void } {
  let now = 0;
  let queue: Array<() => void> = [];
  return {
    now: () => now,
    raf: (cb) => { queue.push(cb); },
    reducedMotion: () => reduced,
    setNow: (t) => { now = t; },
    flush() {
      // Drain frames, stepping the clock so the tween completes deterministically.
      for (let i = 0; i < 100 && queue.length; i++) {
        now += ODOMETER_MS / 8;
        const batch = queue;
        queue = [];
        for (const cb of batch) cb();
      }
    },
  };
}

const odo = (key: string, text: string): HTMLElement => {
  const el = document.createElement('span');
  el.setAttribute('data-odo', '');
  if (key) el.dataset.odoKey = key;
  el.textContent = text;
  return el;
};

describe('easeOut / tweenValue', () => {
  it('eases 0→0, 1→1, clamps out of range, decelerates', () => {
    expect(easeOut(0)).toBe(0);
    expect(easeOut(1)).toBe(1);
    expect(easeOut(-1)).toBe(0);
    expect(easeOut(2)).toBe(1);
    expect(easeOut(0.5)).toBeGreaterThan(0.5); // ease-OUT is ahead of linear at the midpoint
  });
  it('tweens from→to, landing exactly at t=1', () => {
    expect(tweenValue(0, 47, 0)).toBe(0);
    expect(tweenValue(0, 47, 1)).toBe(47);
    expect(tweenValue(10, 7, 1)).toBe(7); // a reduction (dedup) rolls down
  });
});

describe('parseCount', () => {
  it('reads counts incl. +/−, ×, thousands separators; NaN for non-numeric', () => {
    expect(parseCount('8 entities')).toBe(8);
    expect(parseCount('+15 (×3.1)')).toBe(15);
    expect(parseCount('−2 deduped')).toBe(-2); // U+2212 minus
    expect(parseCount('1,116')).toBe(1116);
    expect(parseCount('queue')).toBeNaN();
    expect(parseCount('')).toBeNaN();
    expect(parseCount(null)).toBeNaN();
  });
});

describe('rollNumber', () => {
  it('rolls to the target over the frames and lands exactly', () => {
    const env = fakeEnv();
    const el = odo('k', '0');
    rollNumber(el, 0, 47, env);
    env.flush();
    expect(el.textContent).toBe('47');
  });
  it('reduced-motion snaps instantly (no frames)', () => {
    const env = fakeEnv(true);
    const el = odo('k', '0');
    rollNumber(el, 0, 47, env);
    expect(el.textContent).toBe('47'); // already set, before any flush
  });
  it('equal from/to is a no-op snap', () => {
    const env = fakeEnv();
    const el = odo('k', '5');
    rollNumber(el, 5, 5, env);
    expect(el.textContent).toBe('5');
  });
});

describe('applyOdometers (VIZ-1)', () => {
  it('records a first sighting (no roll), then rolls on a later change', () => {
    const env = fakeEnv();
    const store = new Map<string, number>();
    const root = document.createElement('div');
    const el = odo('decompose-vol', '8');
    root.append(el);

    expect(applyOdometers(root, store, env)).toEqual([]); // first sighting → just record
    expect(store.get('decompose-vol')).toBe(8);

    el.textContent = '12'; // a new poll painted the new target
    const rolled = applyOdometers(root, store, env);
    expect(rolled).toEqual(['decompose-vol']);
    env.flush();
    expect(el.textContent).toBe('12');
    expect(store.get('decompose-vol')).toBe(12);
  });

  it('reduced-motion snaps the value without rolling', () => {
    const env = fakeEnv(true);
    const store = new Map<string, number>([['k', 0]]);
    const root = document.createElement('div');
    const el = odo('k', '47');
    root.append(el);
    applyOdometers(root, store, env);
    expect(el.textContent).toBe('47');
  });

  // ENG-15/16: malformed elements are skipped; one bad element never aborts the rest.
  it('skips a missing-key or non-numeric element and still rolls the good ones', () => {
    const env = fakeEnv();
    const store = new Map<string, number>([['good', 1], ['bad-num', 3]]);
    const root = document.createElement('div');
    const noKey = odo('', '9'); // no data-odo-key → skip
    const nonNum = odo('bad-num', 'queue'); // non-numeric target → skip
    const good = odo('good', '5');
    root.append(noKey, nonNum, good);
    const rolled = applyOdometers(root, store, env);
    expect(rolled).toEqual(['good']); // only the valid, changed one
    env.flush();
    expect(good.textContent).toBe('5');
  });
});

describe('applyIndex (signature §5)', () => {
  const carriage = (id: string, step: number): HTMLElement => {
    const el = document.createElement('li');
    if (id) el.dataset.carriageId = id;
    el.dataset.step = String(step);
    const cell = document.createElement('span');
    cell.className = 'line-cell line-cell-current';
    el.append(cell);
    return el;
  };

  it('adds the index class only when a carriage advances a station', () => {
    const env = fakeEnv();
    const store = new Map<string, number>();
    const root = document.createElement('div');
    const c = carriage('ada', 2);
    root.append(c);

    expect(applyIndex(root, store, env)).toEqual([]); // first sighting records, no animation
    c.dataset.step = '3'; // advanced
    expect(applyIndex(root, store, env)).toEqual(['ada']);
    expect(c.querySelector('.line-cell-current')!.classList.contains('line-cell-indexing')).toBe(true);
  });

  it('does NOT index when the step is unchanged or went backwards', () => {
    const env = fakeEnv();
    const store = new Map<string, number>([['x', 3]]);
    const root = document.createElement('div');
    root.append(carriage('x', 3)); // same step
    expect(applyIndex(root, store, env)).toEqual([]);
  });

  it('reduced-motion records the advance but skips the animation (parity)', () => {
    const env = fakeEnv(true);
    const store = new Map<string, number>([['x', 1]]);
    const root = document.createElement('div');
    const c = carriage('x', 2);
    root.append(c);
    expect(applyIndex(root, store, env)).toEqual([]);
    expect(c.querySelector('.line-cell-current')!.classList.contains('line-cell-indexing')).toBe(false);
    expect(store.get('x')).toBe(2); // still tracked
  });

  it('skips a carriage with a missing id or malformed step (ENG-15)', () => {
    const env = fakeEnv();
    const store = new Map<string, number>([['ok', 1]]);
    const root = document.createElement('div');
    const noId = carriage('', 5);
    const ok = carriage('ok', 2);
    ok.dataset.step = '2';
    root.append(noId, ok);
    const out = applyIndex(root, store, env);
    expect(out).toEqual(['ok']);
  });
});
