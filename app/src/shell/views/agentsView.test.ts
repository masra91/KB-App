// @vitest-environment happy-dom
//
// SPEC-0027 PANEL-3 — the Agents view (observe-only) in the component tier. IPC mocked (`listAgents`);
// we assert the rendered list + graceful degradation. The catalog/model/status logic is covered in
// the node tier (agentCatalog.test.ts). The live-status poll is the same `listAgents` call on a timer.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mountAgents } from './agentsView';
import type { AgentView, KbApi } from '../../kb/types';

const AGENTS: AgentView[] = [
  { key: 'decompose', label: 'Decompose', role: 'Extracts candidates.', model: 'Copilot (default)', instructions: 'kb/decomposeAgent.ts', status: 'running' },
  { key: 'reflect', label: 'Reflect', role: 'Rumination.', model: 'gpt-x', instructions: 'kb/reflectAgent.ts', status: 'idle' },
];

function setApi(listAgents: KbApi['listAgents']): void {
  (window as unknown as { kbApi: Pick<KbApi, 'listAgents'> }).kbApi = { listAgents };
}
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

describe('Agents view (SPEC-0027 PANEL-3)', () => {
  let root: HTMLElement;
  beforeEach(() => {
    document.body.innerHTML = '<div id="r"></div>';
    root = document.getElementById('r')!;
  });
  afterEach(() => {
    document.body.innerHTML = ''; // detach → the status poll stops itself on next tick
    vi.restoreAllMocks();
  });

  it('lists agents with status, model, and instruction pointer', async () => {
    setApi(vi.fn(async () => AGENTS));
    await mountAgents(root);
    await tick();
    expect(root.querySelector('h1')?.textContent).toContain('Agents');
    expect(root.querySelectorAll('.agent')).toHaveLength(2);
    const decompose = root.querySelector('.agent[data-key="decompose"]')!;
    expect(decompose.querySelector('.agent-status')?.textContent).toBe('running');
    expect(decompose.textContent).toContain('Copilot (default)');
    expect(decompose.textContent).toContain('kb/decomposeAgent.ts');
    expect(root.querySelector('.agent[data-key="reflect"] .agent-status')?.textContent).toBe('idle');
  });

  it('renders an error instead of throwing if listing fails (PANEL-9)', async () => {
    setApi(vi.fn(async () => {
      throw new Error('boom');
    }));
    await mountAgents(root);
    await tick();
    expect(root.querySelector('.error')?.textContent).toContain('Could not load agents');
  });

  it('shows a friendly empty state when there are no agents', async () => {
    setApi(vi.fn(async () => []));
    await mountAgents(root);
    await tick();
    expect(root.textContent).toContain('open a Knowledge Base');
  });

  it('pauses the status poll while its view is hidden, resumes when shown (efficiency — PANEL-9)', async () => {
    vi.useFakeTimers();
    try {
      const listAgents = vi.fn(async () => AGENTS);
      setApi(listAgents);
      await mountAgents(root); // initial render → one listAgents call
      const initial = listAgents.mock.calls.length;

      root.classList.add('hidden'); // the shell toggles `.hidden` when another view is active
      await vi.advanceTimersByTimeAsync(5000);
      expect(listAgents.mock.calls.length).toBe(initial); // no IPC while hidden

      root.classList.remove('hidden');
      await vi.advanceTimersByTimeAsync(5000);
      expect(listAgents.mock.calls.length).toBeGreaterThan(initial); // resumes when shown
    } finally {
      vi.useRealTimers();
    }
  });
});
