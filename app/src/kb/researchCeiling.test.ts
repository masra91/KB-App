// Global per-Instance egress ceiling ledger (SPEC-0028 RESEARCH-11). Real FS temp dir (TEST-18);
// the clock is passed in (epoch ms) so the rolling window is deterministic.
import { describe, it, expect } from 'vitest';
import { makeTempDir, rmTempDir } from '../../test/tempVault';
import { admitResearchPass, passesInWindow } from './researchCeiling';

async function withTemp(fn: (root: string) => Promise<void>): Promise<void> {
  const dir = await makeTempDir();
  try {
    await fn(dir);
  } finally {
    await rmTempDir(dir);
  }
}

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

describe('passesInWindow (pure)', () => {
  it('counts only timestamps within [now-window, now]', () => {
    const now = 1_000_000_000;
    const passes = [now - 2 * DAY, now - 12 * HOUR, now - 1 * HOUR, now];
    expect(passesInWindow(passes, now, DAY)).toEqual([now - 12 * HOUR, now - 1 * HOUR, now]); // the 2-day-old one aged out
  });
});

describe('admitResearchPass (RESEARCH-11 per-Instance ceiling)', () => {
  it('admits + records passes under the ceiling, then REFUSES at the ceiling (no further egress)', async () => {
    await withTemp(async (root) => {
      const now = 1_000_000_000;
      // ceiling=3: three passes admitted, the fourth refused.
      const a1 = await admitResearchPass(root, now, 3, DAY);
      const a2 = await admitResearchPass(root, now + 1, 3, DAY);
      const a3 = await admitResearchPass(root, now + 2, 3, DAY);
      const a4 = await admitResearchPass(root, now + 3, 3, DAY);
      expect([a1.allowed, a2.allowed, a3.allowed]).toEqual([true, true, true]);
      expect(a4.allowed).toBe(false);
      expect(a4.countInWindow).toBe(3); // the three in-window passes that blocked it
      expect(a4.ceiling).toBe(3);
    });
  });

  it('is persistent across calls (the ledger survives — a cross-dispatch/standing backstop)', async () => {
    await withTemp(async (root) => {
      const now = 2_000_000_000;
      await admitResearchPass(root, now, 2, DAY);
      await admitResearchPass(root, now + 1, 2, DAY);
      // a fresh call (new dispatch/tick) still sees the prior two → refused.
      expect((await admitResearchPass(root, now + 2, 2, DAY)).allowed).toBe(false);
    });
  });

  it('self-heals: once old passes age out of the window, capacity returns', async () => {
    await withTemp(async (root) => {
      const t0 = 3_000_000_000;
      expect((await admitResearchPass(root, t0, 1, DAY)).allowed).toBe(true);
      expect((await admitResearchPass(root, t0 + HOUR, 1, DAY)).allowed).toBe(false); // still within the window → blocked
      // a day+ later the first pass has aged out → admitted again (no manual reset).
      expect((await admitResearchPass(root, t0 + DAY + HOUR, 1, DAY)).allowed).toBe(true);
    });
  });
});
