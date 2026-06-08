// QUIESCE-6 tray item (SPEC-0045). Pure — the helper is electron-free at runtime, so it tests in node.
import { describe, it, expect, vi } from 'vitest';
import { quiesceTrayItems } from './quiesceTray';

describe('quiesceTrayItems (SPEC-0045 QUIESCE-6)', () => {
  it('running normally → a single "Prepare for shutdown…" item wired to onPrepare', () => {
    const onPrepare = vi.fn();
    const onResume = vi.fn();
    const items = quiesceTrayItems(false, { onPrepare, onResume });
    expect(items).toHaveLength(1);
    expect(items[0].label).toMatch(/Prepare for shutdown/i);
    (items[0].click as () => void)();
    expect(onPrepare).toHaveBeenCalledTimes(1);
    expect(onResume).not.toHaveBeenCalled();
  });

  it('quiescing → a "Resume — cancel shutdown" item wired to onResume (reversible, QUIESCE-5)', () => {
    const onPrepare = vi.fn();
    const onResume = vi.fn();
    const items = quiesceTrayItems(true, { onPrepare, onResume });
    expect(items).toHaveLength(1);
    expect(items[0].label).toMatch(/Resume/i);
    (items[0].click as () => void)();
    expect(onResume).toHaveBeenCalledTimes(1);
    expect(onPrepare).not.toHaveBeenCalled();
  });
});
