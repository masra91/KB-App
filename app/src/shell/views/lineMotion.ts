// The Line — motion layer (SPEC-0032 §5 / VIZ-1, VIZ-6, VIZ-9). The render is a full-innerHTML repaint
// guarded by a change-hash (so ember-breathe doesn't restart on an unchanged poll). That repaint
// destroys the number nodes, so a CSS odometer can't tween across it — instead this applies the two
// JS-driven motions AFTER each repaint, reading the PRIOR value from a small keyed store:
//
//  • **Odometer** (VIZ-1) — count text rolls from its last value to the new one over 400ms ease-out,
//    fixing the "0 → sudden numbers" jank the Principal flagged. Element carries `data-odo` +
//    `data-odo-key` (stable id); its textContent is the TARGET. Equal value or reduced-motion → snap.
//  • **Index** (signature, §5) — when a carriage's stepper advances a station since the last render,
//    its now-current cell gets `.line-cell-indexing` to fire the 220ms translateX settle. The cell's
//    state is ALSO conveyed by fill+colour, so reduced-motion simply skips the animation (full parity).
//
// Pure + injectable (clock/rAF/reduced-motion) so it unit-tests in happy-dom with a synchronous fake
// rAF and no real timers. ENG-15/16: a malformed (non-numeric / missing-key) element is skipped, never
// throws, and one bad element never aborts the rest.

/** §5: counts roll 400ms ease-out (mirrors the `--viz-dur-odometer` CSS token). */
export const ODOMETER_MS = 400;

export interface MotionEnv {
  now: () => number;
  raf: (cb: () => void) => void;
  reducedMotion: () => boolean;
}

/** Browser-backed env. `prefers-reduced-motion` is read live each call so an OS toggle takes effect. */
export function defaultMotionEnv(): MotionEnv {
  return {
    now: () => (typeof performance !== 'undefined' ? performance.now() : Date.now()),
    raf: (cb) => {
      if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => cb());
      else setTimeout(cb, 16);
    },
    reducedMotion: () =>
      typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches,
  };
}

/** Cubic ease-out (fast then settling) — the odometer's deceleration curve. */
export function easeOut(t: number): number {
  const c = Math.min(1, Math.max(0, t));
  return 1 - Math.pow(1 - c, 3);
}

/** The displayed integer at progress `t∈[0,1]` rolling `from`→`to` (rounded, monotone-safe). */
export function tweenValue(from: number, to: number, t: number): number {
  return Math.round(from + (to - from) * easeOut(t));
}

/** Parse the integer a count element displays (tolerant of `+`, `−`, thousands separators); NaN if none. */
export function parseCount(text: string | null): number {
  if (!text) return NaN;
  const m = text.replace(/[−]/g, '-').match(/-?\d[\d,]*/); // U+2212 minus → ASCII
  return m ? parseInt(m[0].replace(/,/g, ''), 10) : NaN;
}

/** Roll one element's number from `from`→`to` over {@link ODOMETER_MS} (rAF). Equal/reduced-motion → snap. */
export function rollNumber(el: HTMLElement, from: number, to: number, env: MotionEnv = defaultMotionEnv()): void {
  if (from === to || env.reducedMotion()) {
    el.textContent = String(to);
    return;
  }
  const start = env.now();
  const step = (): void => {
    const t = (env.now() - start) / ODOMETER_MS;
    if (t >= 1) {
      el.textContent = String(to);
      return;
    }
    el.textContent = String(tweenValue(from, to, t));
    env.raf(step);
  };
  env.raf(step);
}

/**
 * Odometer pass (VIZ-1): roll every `[data-odo]` under `root` from its stored prior value to its
 * current textContent. `store` (key → last value) persists across renders. Returns the keys that
 * actually rolled (testable). A first sighting (no prior) just records — nothing to roll from.
 */
export function applyOdometers(root: ParentNode, store: Map<string, number>, env: MotionEnv = defaultMotionEnv()): string[] {
  const rolled: string[] = [];
  for (const el of Array.from(root.querySelectorAll<HTMLElement>('[data-odo]'))) {
    const key = el.dataset.odoKey;
    if (!key) continue; // ENG-15: missing key → skip, no throw
    const to = parseCount(el.textContent);
    if (!Number.isFinite(to)) continue; // ENG-15: non-numeric target → skip
    const from = store.get(key);
    store.set(key, to);
    if (from !== undefined && from !== to) {
      rollNumber(el, from, to, env);
      rolled.push(key);
    }
  }
  return rolled;
}

/**
 * Index pass (signature motion, §5): for each carriage `[data-carriage-id]` whose `data-step` advanced
 * past its stored prior, add `.line-cell-indexing` to its current cell to fire the settle. `store`
 * (carriageId → last step) persists across renders. Returns the ids that indexed (testable).
 * Reduced-motion: records the new step but skips the class (parity — state is also fill+colour).
 */
export function applyIndex(root: ParentNode, store: Map<string, number>, env: MotionEnv = defaultMotionEnv()): string[] {
  const advanced: string[] = [];
  const reduce = env.reducedMotion();
  for (const el of Array.from(root.querySelectorAll<HTMLElement>('[data-carriage-id]'))) {
    const id = el.dataset.carriageId;
    if (!id) continue; // ENG-15
    const step = parseCount(el.dataset.step ?? '');
    if (!Number.isFinite(step)) continue; // ENG-15: malformed step → skip
    const prev = store.get(id);
    store.set(id, step);
    if (prev !== undefined && step > prev && !reduce) {
      const cell = el.querySelector<HTMLElement>('.line-cell-current');
      if (cell) {
        cell.classList.add('line-cell-indexing');
        advanced.push(id);
      }
    }
  }
  return advanced;
}

/** A render's carry-over motion stores (one per render target). */
export interface MotionStores {
  odo: Map<string, number>;
  step: Map<string, number>;
}
export function createMotionStores(): MotionStores {
  return { odo: new Map(), step: new Map() };
}

/** Apply both motions after a repaint. Each pass is isolated so one failing never blocks the other. */
export function applyLineMotion(root: ParentNode, stores: MotionStores, env: MotionEnv = defaultMotionEnv()): void {
  applyOdometers(root, stores.odo, env);
  applyIndex(root, stores.step, env);
}
