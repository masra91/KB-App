// Researcher cognition wiring (#160 / BUG #65 class) — the single seam that resolves the BYOA copilot
// cliPath + threads the dev-log into the Web adapter for BOTH researcher entry points. Regression test
// for the packaged-app-resolution half of the class: before #160 the call sites passed NO cliPath, so
// the SDK couldn't spawn copilot in the packaged app; this proves the shared seam resolves + threads it.
import { describe, it, expect } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  resolveCopilotCliPath,
  webResearchOptions,
  researchDepsOptions,
  resolveWorkIqCli,
  m365ResearchOptions,
  intakeDepsOptions,
  workIqStatus,
  installWorkIq,
} from './researchWiring';
import { noopDevLog } from '../kb/devlog';

/** Run `fn` with `process.env.PATH` set to a temp dir holding (or not) a `workiq` binary, so the
 *  PATH-scanning `resolveWorkIqCli` sees a deterministic installed/missing state. Restores PATH after. */
async function withWorkIqOnPath(installed: boolean, fn: () => void | Promise<void>): Promise<void> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'kb-workiq-bin-'));
  const savedPath = process.env.PATH;
  try {
    if (installed) {
      const exe = path.join(dir, 'workiq');
      await fs.writeFile(exe, '#!/bin/sh\n');
    }
    process.env.PATH = dir; // ONLY this dir — so the result is fully determined by `installed`
    await fn();
  } finally {
    process.env.PATH = savedPath;
    await fs.rm(dir, { recursive: true, force: true });
  }
}

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

  // WORKIQ-FIX: the missing third arm. researchDepsOptions returned {web, code} → opts.m365 was always
  // undefined → makeM365ResearchFn had no mcpServer → silent no-finding. Now it's wired.
  it('wires the M365/WorkIQ arm into researchDepsOptions (was the silent-no-op gap)', () => {
    const m365 = researchDepsOptions(noopDevLog).m365;
    expect(m365).toBeDefined();
    expect(m365).toHaveProperty('cliPath'); // copilot cliPath wired like web/code
    expect(typeof m365!.model).toBe('string');
    expect(m365!.model!.length).toBeGreaterThan(0); // pinned model, no settings.json inheritance
  });
});

describe('WORKIQ-FIX — CLI detection, MCP factory injection, status + install', () => {
  it('resolveWorkIqCli resolves the workiq binary on PATH; undefined when absent', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'kb-workiq-'));
    try {
      const exe = path.join(dir, 'workiq');
      await fs.writeFile(exe, '#!/bin/sh\n');
      expect(resolveWorkIqCli({ PATH: `/nonexistent:${dir}` } as NodeJS.ProcessEnv, 'linux')).toBe(exe);
      expect(resolveWorkIqCli({ PATH: '' } as NodeJS.ProcessEnv, 'linux')).toBeUndefined();
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('INJECTS the read-only WorkIQ MCP factory only when the CLI is installed (fail-loud when missing)', async () => {
    await withWorkIqOnPath(true, () => {
      const m365 = m365ResearchOptions();
      expect(typeof m365.mcpServer).toBe('function'); // installed → factory present → live MCP injected
      const { server, readTools } = m365.mcpServer!({ tenantId: 'contoso', surfaces: ['mail'] });
      expect(server).toMatchObject({ type: 'stdio', args: expect.arrayContaining(['--read-only', '--tenant', 'contoso']) });
      expect(readTools.length).toBeGreaterThan(0);
    });
    await withWorkIqOnPath(false, () => {
      // No CLI → NO factory → makeM365ResearchFn's liveSdkSession throws needs-setup → research-failed.
      expect(m365ResearchOptions().mcpServer).toBeUndefined();
    });
  });

  it('intakeDepsOptions wires the m365-mail WorkIQ MCP factory (was the dead `{}` at scheduler ctor)', async () => {
    await withWorkIqOnPath(true, () => {
      const m365Mail = intakeDepsOptions().m365Mail;
      expect(m365Mail).toBeDefined();
      expect(typeof m365Mail!.mcpServer).toBe('function');
      // Mail factory is scoped to the mail surface only.
      const { readTools } = m365Mail!.mcpServer!({ tenantId: 'contoso' });
      expect(readTools).toEqual(expect.arrayContaining(['workiq_search_mail']));
    });
  });

  it('workIqStatus reports installed + cliPath when present, not-installed otherwise (with command)', async () => {
    await withWorkIqOnPath(true, () => {
      const s = workIqStatus();
      expect(s.installed).toBe(true);
      expect(typeof s.cliPath).toBe('string');
      expect(s.installCommand).toContain('workiq');
    });
    await withWorkIqOnPath(false, () => {
      const s = workIqStatus();
      expect(s.installed).toBe(false);
      expect(s.cliPath).toBeUndefined();
      expect(s.installCommand.length).toBeGreaterThan(0); // card still shows how to install
    });
  });

  it('installWorkIq: ok:true after the runner installs the CLI (re-detected on PATH)', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'kb-workiq-inst-'));
    const savedPath = process.env.PATH;
    try {
      process.env.PATH = dir;
      // Injected runner simulates a successful global install by dropping the binary on PATH.
      const runner = async (): Promise<void> => {
        await fs.writeFile(path.join(dir, 'workiq'), '#!/bin/sh\n');
      };
      const res = await installWorkIq(runner);
      expect(res.ok).toBe(true);
      expect(res.status.installed).toBe(true);
    } finally {
      process.env.PATH = savedPath;
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('installWorkIq: ok:false + cause when the install command fails', async () => {
    await withWorkIqOnPath(false, async () => {
      const runner = async (): Promise<void> => { throw new Error('npm: network down'); };
      const res = await installWorkIq(runner);
      expect(res).toMatchObject({ ok: false, error: expect.stringContaining('network down'), status: { installed: false } });
    });
  });

  it('installWorkIq: ok:false when the command "succeeds" but the CLI is still missing (no lying)', async () => {
    await withWorkIqOnPath(false, async () => {
      const runner = async (): Promise<void> => {}; // no-op: pretends success but installs nothing
      const res = await installWorkIq(runner);
      expect(res).toMatchObject({ ok: false, error: expect.stringMatching(/still not on PATH/i) });
    });
  });
});
