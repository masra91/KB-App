// SPEC-0042 EVAL Slice-1 — scenario loader (EVAL-1). Reads a YAML scenario file, parses it, and runs
// the pure schema validation; a malformed scenario throws a clear error, never a partial run.
import { readFile } from 'node:fs/promises';
import { load as loadYaml } from 'js-yaml';
import { validateScenario, type Scenario } from './scenario';

/** Parse + validate scenario YAML text (label is used only for the error message). */
export function parseScenario(text: string, label = '<inline>'): Scenario {
  let raw: unknown;
  try {
    raw = loadYaml(text);
  } catch (e) {
    throw new Error(`scenario ${label}: YAML parse error — ${e instanceof Error ? e.message : String(e)}`);
  }
  const parsed = validateScenario(raw);
  if (parsed.ok && parsed.scenario) return parsed.scenario;
  throw new Error(`scenario ${label}: ${parsed.error ?? 'invalid scenario'}`);
}

/** Load + validate a scenario from a YAML file path (EVAL-1). */
export async function loadScenario(filePath: string): Promise<Scenario> {
  return parseScenario(await readFile(filePath, 'utf8'), filePath);
}
