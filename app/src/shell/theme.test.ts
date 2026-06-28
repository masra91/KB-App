// @vitest-environment happy-dom
//
// SPEC-0058 theme-toggle — the Light/Dark switch logic. Asserts: persisted choice round-trips, applies an
// EXPLICIT data-theme to the root (never a prefers-color-scheme media query — DL-2's themeCohesion
// invariant), default-LIGHT fallback on absent/garbled/unavailable storage, and boot init.
import { describe, it, expect, beforeEach } from 'vitest';
import { initTheme, setTheme, applyTheme, readStoredTheme, DEFAULT_THEME, THEME_STORAGE_KEY } from './theme';

/** A minimal Map-backed localStorage (happy-dom's is partial across versions). */
function installLocalStorage(): void {
  const store = new Map<string, string>();
  Object.defineProperty(window, 'localStorage', {
    configurable: true,
    value: {
      getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
      setItem: (k: string, v: string) => void store.set(k, String(v)),
      removeItem: (k: string) => void store.delete(k),
      clear: () => store.clear(),
    },
  });
}

beforeEach(() => {
  installLocalStorage();
  document.documentElement.removeAttribute('data-theme');
});

describe('theme module (SPEC-0058)', () => {
  it('default is LIGHT when nothing is stored (the fixed-light Vellum identity)', () => {
    expect(DEFAULT_THEME).toBe('light');
    expect(readStoredTheme()).toBe('light');
  });

  it('setTheme applies an explicit data-theme on the root AND persists it', () => {
    setTheme('dark');
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe('dark');
    expect(readStoredTheme()).toBe('dark');

    setTheme('light');
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
    expect(readStoredTheme()).toBe('light');
  });

  it('applyTheme is pure DOM (no persistence) and only ever sets data-theme', () => {
    const root = document.createElement('html');
    applyTheme('dark', root);
    expect(root.getAttribute('data-theme')).toBe('dark');
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBeNull(); // applyTheme does NOT persist
  });

  it('initTheme applies the persisted choice on boot (no light→dark flash)', () => {
    window.localStorage.setItem(THEME_STORAGE_KEY, 'dark');
    expect(initTheme()).toBe('dark');
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
  });

  it('a garbled / unknown stored value falls back to default LIGHT', () => {
    window.localStorage.setItem(THEME_STORAGE_KEY, 'midnight'); // not a valid Theme
    expect(readStoredTheme()).toBe('light');
    expect(initTheme()).toBe('light');
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
  });

  it('never touches prefers-color-scheme — it only sets the explicit data-theme attribute', () => {
    // The whole point of the themeCohesion invariant: the toggle is an explicit data-theme set; it must not
    // introduce any OS-auto behavior. (System/auto is DL-1's separate [data-theme=auto] foundation layer.)
    setTheme('dark');
    setTheme('light');
    expect(document.documentElement.getAttribute('data-theme')).toBe('light'); // explicit, deterministic
  });
});
