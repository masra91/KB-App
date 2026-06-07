// SPEC-0042 EVAL Slice-3 — the scenario library is well-formed (EVAL-10). Deterministic CI smoke: every
// eval/scenarios/*.yaml validates, the eight capabilities are all covered, every deterministic check names
// a REAL validator (a typo would otherwise only fail at live-run time), and each research scenario's
// committed cassette loads clean. No pipeline, no model — pure static checks over the declarative library.
import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { loadScenario } from './loader';
import { VALIDATORS } from './validators';
import { loadCassette } from './cassetteStore';
import { EVAL_CAPABILITIES } from './scenario';

const SCENARIOS_DIR = path.resolve(process.cwd(), 'eval/scenarios');
const CASSETTES_DIR = path.resolve(process.cwd(), 'eval/cassettes');

async function listScenarioFiles(): Promise<string[]> {
  return (await fs.readdir(SCENARIOS_DIR)).filter((f) => f.endsWith('.yaml') || f.endsWith('.yml')).sort();
}

describe('SPEC-0042 scenario library (EVAL-10)', () => {
  it('has ≥8 scenarios covering all eight capabilities', async () => {
    const files = await listScenarioFiles();
    expect(files.length).toBeGreaterThanOrEqual(8);
    const caps = new Set<string>();
    for (const f of files) caps.add((await loadScenario(path.join(SCENARIOS_DIR, f))).capability);
    for (const cap of EVAL_CAPABILITIES) expect(caps.has(cap), `missing a scenario for capability '${cap}'`).toBe(true);
  });

  it('every scenario validates + every deterministic check names a real validator', async () => {
    for (const f of await listScenarioFiles()) {
      const scenario = await loadScenario(path.join(SCENARIOS_DIR, f)); // throws if invalid
      for (const c of scenario.expect.deterministic ?? []) {
        expect(VALIDATORS[c.check], `${f}: unknown deterministic check '${c.check}'`).toBeTypeOf('function');
      }
      for (const j of scenario.expect.judge ?? []) expect(typeof j.rubric).toBe('string');
    }
  });

  it('every research scenario points at a clean, committed public-web cassette', async () => {
    for (const f of await listScenarioFiles()) {
      const scenario = await loadScenario(path.join(SCENARIOS_DIR, f));
      const hasResearch = scenario.actions.some((a) => 'dispatchResearcher' in a);
      if (!hasResearch) continue;
      const named = (scenario.meta as { cassette?: string } | undefined)?.cassette ?? `${scenario.id}.json`;
      const cassette = await loadCassette(path.join(CASSETTES_DIR, named)); // throws if missing/dirty/wrong-tier
      expect(cassette.tier).toBe('public-web');
    }
  });
});
