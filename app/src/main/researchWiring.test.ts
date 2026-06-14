// Researcher cognition wiring (#160 / BUG #65 class) — the single seam that resolves the BYOA copilot
// cliPath + threads the dev-log into the Web adapter for BOTH researcher entry points. Regression test
// for the packaged-app-resolution half of the class: before #160 the call sites passed NO cliPath, so
// the SDK couldn't spawn copilot in the packaged app; this proves the shared seam resolves + threads it.
import { describe, it, expect } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveCopilotCliPath, webResearchOptions, researchDepsOptions } from './researchWiring';
import { noopDevLog } from '../kb/devlog';

describe('resolveCopilotCliPath (#160 / BUG #65 — packaged-app SDK resolution)', () => {
  it('resolves the BYOA copilot on PATH to an absolute cliPath; undefined when absent', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'kb-research-bin-'));
    try {
      const exe = path.join(dir, 'copilot');
      await fs.writeFile(exe, '#!/bin/sh\n');
      expect(resolveCopilotCliPath({ PATH: `/nonexistent:${dir}` } as NodeJS.ProcessEnv, 'linux')).toBe(exe);
      // undefined (NOT null) so it slots into the SDK's "no path → default search" branch.
      expect(resolveCopilotCliPath({ PATH: '' } as NodeJS.ProcessEnv, 'linux')).toBeUndefined();
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

describe('webResearchOptions / researchDepsOptions (one seam for scheduler + Run-now)', () => {
  it('threads the dev-log so a session failure is logged, not swallowed (#160 failed≠empty)', () => {
    expect(webResearchOptions(noopDevLog).log).toBe(noopDevLog);
    expect(researchDepsOptions(noopDevLog).web?.log).toBe(noopDevLog);
  });

  it('always carries a cliPath key wired from the resolver (so neither call site can omit it)', () => {
    // The value is env-dependent (copilot may/may not be on the test PATH); what matters for the
    // regression is that the option is WIRED — present in the opts both entry points build.
    expect(webResearchOptions(noopDevLog)).toHaveProperty('cliPath');
    expect(researchDepsOptions(noopDevLog).web).toHaveProperty('cliPath');
  });

  // SPEC-0048 WS-D(c): researchers must run the PINNED model, not inherit ~/.copilot/settings.json
  // (the #340 model-pin gap, previously closed for deciders/recall but not researchers). The SDK
  // options now carry a concrete `model` from resolveCopilotModel (per-researcher pin → global).
  it('pins the model on both researcher SDK option sets (WS-D — no settings.json inheritance)', () => {
    const web = researchDepsOptions(noopDevLog).web!;
    const code = researchDepsOptions(noopDevLog).code!;
    expect(typeof web.model).toBe('string');
    expect(web.model!.length).toBeGreaterThan(0); // a concrete pinned model, never undefined
    expect(typeof code.model).toBe('string');
    expect(code.model!.length).toBeGreaterThan(0);
  });
});
