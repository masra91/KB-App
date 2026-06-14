// Build-time guard for the CLI-built-in tool-name collision class (the Ask/Recall outage: CLI 1.0.62
// added a built-in `grep`, which rejected recall's same-named custom tool — "conflicts with a built-in
// tool of the same name. Set overridesBuiltInTool: true."). The SDK is mocked in agent unit tests, so
// they provably can't reproduce a real-CLI collision ([[feedback-test-real-agent-path]]); this guard
// instead asserts, against KNOWN_BUILTIN_TOOL_NAMES, that every custom tool whose name is a known CLI
// built-in opts into `overridesBuiltInTool: true` — across recall AND all researchers. The real-CLI
// catch is the opt-in library eval (eval/library.eval.ts) over the actual `copilot`.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { KNOWN_BUILTIN_TOOL_NAMES, isBuiltInToolName } from './builtinTools';
import { buildRecallToolDefs, makeReadOnlyTools, type RecallTools } from './recall';

describe('KNOWN_BUILTIN_TOOL_NAMES', () => {
  it('is a non-empty, version-coupled set', () => {
    expect(KNOWN_BUILTIN_TOOL_NAMES.size).toBeGreaterThan(0);
  });

  it('includes the built-ins that caused / would cause collisions (grep is the field-confirmed one)', () => {
    expect(isBuiltInToolName('grep')).toBe(true); // the live Ask/Recall outage
    expect(isBuiltInToolName('fetch')).toBe(true); // the web-researcher precedent (already overridden)
    expect(isBuiltInToolName('read_file')).toBe(true); // SDK README override example
    // KB-specific names are NOT built-ins → must not be force-overridden.
    expect(isBuiltInToolName('entityLookup')).toBe(false);
    expect(isBuiltInToolName('submitFindings')).toBe(false);
  });
});

describe('recall tool defs vs CLI built-ins (the regression — real buildRecallToolDefs, no SDK)', () => {
  // A stub: the guard only inspects def.name / def.overridesBuiltInTool, never invokes a handler.
  const stubTools: RecallTools = {
    entityLookup: async () => [],
    claimsForEntity: async () => [],
    linkTraversal: async () => ({ outgoing: [], incoming: [] }),
    readNode: async () => null,
    readSource: async () => null,
    grep: async () => [],
  };

  const defs = () =>
    buildRecallToolDefs(stubTools, { answered: false, answer: '', citations: [], declaredGrounded: true }, { used: 0, truncated: false }, 10);

  it('the `grep` def opts into overridesBuiltInTool (fails-before this fix → Ask/Recall down)', () => {
    const grep = defs().find((d) => d.name === 'grep')!;
    expect(grep).toBeDefined();
    expect(grep.overridesBuiltInTool).toBe(true);
  });

  it('EVERY built-in-named recall tool overrides; NO KB-specific tool spuriously overrides', () => {
    for (const d of defs()) {
      if (isBuiltInToolName(d.name)) {
        expect(d.overridesBuiltInTool, `${d.name} collides with a CLI built-in but does not override`).toBe(true);
      } else {
        // control: don't blanket-set the flag on names that aren't built-ins (e.g. entityLookup, readNode).
        expect(d.overridesBuiltInTool ?? false, `${d.name} is not a built-in but sets overridesBuiltInTool`).toBe(false);
      }
    }
  });

  it('makeReadOnlyTools still satisfies RecallTools (def-builder wiring intact)', () => {
    // Smoke: the production tools object is shaped as buildRecallToolDefs expects (no vault needed to type-check the call).
    expect(typeof makeReadOnlyTools).toBe('function');
  });
});

// Static audit across every agent that registers custom SDK tools: a tool declared with a built-in name
// MUST carry overridesBuiltInTool within its def. Catches the researcher inline defs (read_file, fetch)
// + any future tool, without spawning a session. This IS KB-Lead's "build-time tool-name-vs-built-ins check".
describe('all agents: custom tools with built-in names opt into the override (static audit)', () => {
  const AGENT_FILES = ['recall.ts', 'recallAgent.ts', 'researchCodeAgent.ts', 'researchWebAgent.ts', 'researchM365Agent.ts'];

  // Match a tool declaration's name from either form used in this codebase:
  //   defineTool('name', { ... })            (SDK researchers)
  //   retrieval('name', ...)                 (recall's wrapper)
  const declRe = () => /(?:defineTool|retrieval)\(\s*'([a-zA-Z_]+)'/g;
  const readAgent = (file: string) => readFileSync(path.join(__dirname, file), 'utf8'); // CJS target → __dirname, not import.meta

  for (const file of AGENT_FILES) {
    it(`${file}: no un-overridden built-in tool name`, () => {
      const src = readAgent(file);
      const offenders: string[] = [];
      for (const m of src.matchAll(declRe())) {
        const name = m[1];
        if (!isBuiltInToolName(name)) continue;
        // Inspect the def body that follows the declaration (bounded window — tool defs are small).
        const body = src.slice(m.index, (m.index ?? 0) + 600);
        if (!/overridesBuiltInTool:\s*true/.test(body)) offenders.push(name);
      }
      expect(offenders, `${file} declares CLI built-in tool(s) without overridesBuiltInTool: ${offenders.join(', ')}`).toEqual([]);
    });
  }

  it('the audit is meaningful: at least one built-in-named custom tool exists to guard', () => {
    let found = 0;
    for (const file of AGENT_FILES) {
      const src = readAgent(file);
      for (const m of src.matchAll(declRe())) if (isBuiltInToolName(m[1])) found++;
    }
    expect(found).toBeGreaterThan(0); // grep (recall) + read_file (code) + fetch (web)
  });
});
