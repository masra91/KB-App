// QCAP-14 tray menu composition — pure (node tier). Guards the PM-locked 3-contributor seam + the
// read-only invariant: status items are disabled (report-only), DEV-1's action items pass through
// verbatim/in-order, the QUIESCE-6 hook inserts cleanly, Quit is last, no stray/double separators.
import { describe, it, expect } from 'vitest';
import type { MenuItemConstructorOptions } from 'electron';
import { buildTrayTemplate } from './trayMenu';

const labels = (t: MenuItemConstructorOptions[]): string[] =>
  t.map((i) => (i.type === 'separator' ? '─' : (i.role ?? i.label ?? '?')));

const ACTIONS: MenuItemConstructorOptions[] = [
  { label: 'Quick Capture  (⌥Space)', click: () => {} },
  { label: 'Show KB-App', click: () => {} },
];

describe('buildTrayTemplate (QCAP-14 tray menu composition)', () => {
  it('renders the status readout as READ-ONLY (disabled, no click) above the actions — observatory invariant', () => {
    const t = buildTrayTemplate({ statusLines: ['◐ Running — ~1,000 waiting', 'Decompose 12 · Linking 340'], actionItems: ACTIONS });
    const status = t.slice(0, 2);
    expect(status.map((i) => i.label)).toEqual(['◐ Running — ~1,000 waiting', 'Decompose 12 · Linking 340']);
    expect(status.every((i) => i.enabled === false)).toBe(true); // disabled = read-only
    expect(status.every((i) => i.click === undefined)).toBe(true); // no action wired to a status line
  });

  it('orders sections: status · ─ · actions · ─ · Quit (Quit last, role=quit)', () => {
    const t = buildTrayTemplate({ statusLines: ['◐ Running — ~5 waiting'], actionItems: ACTIONS });
    expect(labels(t)).toEqual(['◐ Running — ~5 waiting', '─', 'Quick Capture  (⌥Space)', 'Show KB-App', '─', 'quit']);
  });

  it('preserves DEV-1 action items verbatim and in order', () => {
    const t = buildTrayTemplate({ statusLines: [], actionItems: ACTIONS });
    const actionLabels = t.filter((i) => i.type !== 'separator' && i.role !== 'quit').map((i) => i.label);
    expect(actionLabels).toEqual(['Quick Capture  (⌥Space)', 'Show KB-App']);
  });

  it('no status (idle/headless/empty) → no leading separator before the actions', () => {
    const t = buildTrayTemplate({ statusLines: [], actionItems: ACTIONS });
    expect(t[0].label).toBe('Quick Capture  (⌥Space)'); // actions lead; no orphan rule on top
    expect(labels(t)).toEqual(['Quick Capture  (⌥Space)', 'Show KB-App', '─', 'quit']);
  });

  it('DEV-2 QUIESCE-6 hook items drop in between actions and Quit, behind their own separator', () => {
    const extra: MenuItemConstructorOptions[] = [{ label: 'Prepare for shutdown', click: () => {} }];
    const t = buildTrayTemplate({ statusLines: ['○ Idle — all caught up'], actionItems: ACTIONS, extraItems: extra });
    expect(labels(t)).toEqual([
      '○ Idle — all caught up',
      '─',
      'Quick Capture  (⌥Space)',
      'Show KB-App',
      '─',
      'Prepare for shutdown',
      '─',
      'quit',
    ]);
  });
});
