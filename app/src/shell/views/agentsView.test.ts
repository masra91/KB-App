// @vitest-environment happy-dom
//
// SPEC-0027 PANEL-3 — the Agents view (observe-only) in the component tier. IPC mocked (`listAgents`);
// we assert the rendered list + graceful degradation. The catalog/model/status logic is covered in
// the node tier (agentCatalog.test.ts). The live-status poll is the same `listAgents` call on a timer.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mountAgents } from './agentsView';
import type { AgentView, KbApi, ModelCatalogView } from '../../kb/types';

const AGENTS: AgentView[] = [
  { key: 'decompose', label: 'Decompose', role: 'Extracts candidates.', model: 'Copilot (default)', instructions: 'kb/decomposeAgent.ts', status: 'running' },
  { key: 'reflect', label: 'Reflect', role: 'Rumination.', model: 'gpt-x', instructions: 'kb/reflectAgent.ts', status: 'idle' },
];

function setApi(
  listAgents: KbApi['listAgents'],
  getModelCatalog?: KbApi['getModelCatalog'],
  setModel?: KbApi['setModel'],
  setAgentModel?: KbApi['setAgentModel'],
): void {
  (window as unknown as { kbApi: Partial<KbApi> }).kbApi = { listAgents, getModelCatalog, setModel, setAgentModel };
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
    expect(root.querySelector('.agent-note')?.textContent).toContain('librarian'); // section sub-note (hub owns the title — WS-E)
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
    expect(root.querySelector('.load-error')?.textContent).toContain('Couldn’t load'); // retryable fallback (#145)
    expect(root.querySelector('.load-retry')).toBeTruthy();
  });

  it('shows a friendly empty state when there are no agents', async () => {
    setApi(vi.fn(async () => []));
    await mountAgents(root);
    await tick();
    expect(root.textContent).toContain('open a Knowledge Base');
  });

  // WS3 migration (DESIGN-LEGACY-VIEWS §4): the Agents view moved off the legacy off-system primitives
  // (.muted text + a hard-coded #7ad17a status hue) onto The Line — the status chip is the blessed
  // .viz-chip primitive and the status-* family carries state via the canonical hue TOKENS, never hex.
  // These are the fails-before/passes-after guards on the CLASS.
  describe('WS3 design-system migration (DESIGN-LEGACY-VIEWS §4 — onto The Line)', () => {
    it('renders the status chip as a blessed .viz-chip carrying its status-* state class', async () => {
      setApi(vi.fn(async () => AGENTS));
      await mountAgents(root);
      await tick();
      const chip = root.querySelector<HTMLElement>('.agent[data-key="decompose"] .agent-status')!;
      expect(chip.classList.contains('viz-chip')).toBe(true); // shape/hue from design-system.css, not hex
      expect(chip.classList.contains('status-running')).toBe(true);
      // State is never color-alone (§3 DESIGN-4) — the text label carries the meaning too.
      expect(chip.textContent).toBe('running');
    });

    it('keeps the .viz-chip primitive on the in-place status poll refresh (regression: className rebuild)', async () => {
      vi.useFakeTimers();
      try {
        // running → idle on the second call, so the poll rewrites the chip className in place (PANEL-9).
        const listAgents = vi
          .fn<KbApi['listAgents']>()
          .mockResolvedValueOnce(AGENTS)
          .mockResolvedValue([{ ...AGENTS[0], status: 'idle' }, AGENTS[1]]);
        setApi(listAgents);
        await mountAgents(root);
        await vi.advanceTimersByTimeAsync(5000); // one poll → refreshStatus rewrites the chip class
        const chip = root.querySelector<HTMLElement>('.agent[data-key="decompose"] .agent-status')!;
        expect(chip.textContent).toBe('idle'); // status updated in place
        expect(chip.classList.contains('viz-chip')).toBe(true); // chip primitive NOT stripped by the rebuild
        expect(chip.classList.contains('status-idle')).toBe(true);
        expect(chip.classList.contains('status-running')).toBe(false);
      } finally {
        vi.useRealTimers();
      }
    });

    it('carries NO legacy off-system primitives (.muted) on any render path', async () => {
      setApi(vi.fn(async () => AGENTS));
      await mountAgents(root);
      await tick();
      expect(root.querySelector('.muted')).toBeNull(); // header note + role text migrated to --viz-ink-muted
      // empty state too
      setApi(vi.fn(async () => []));
      await mountAgents(root);
      await tick();
      expect(root.querySelector('.muted')).toBeNull();
    });
  });

  // UX v2 material adoption (DL-2 Agents contract; vellum-ux-v2-language §1/§3/§4). The visual is
  // signed by DL-2 on a live walkthrough; these guard the DOM CONTRACT the v2 CSS hangs off (material
  // classes + the Spectral voice hook) so a markup refactor can't silently drop the crafted depth.
  describe('UX v2 material adoption (DL-2 contract)', () => {
    it('wraps the group in a material card with paper-grain, scoped .agents-v2', async () => {
      setApi(vi.fn(async () => AGENTS));
      await mountAgents(root);
      await tick();
      const container = root.querySelector<HTMLElement>('.agents-v2')!;
      expect(container).toBeTruthy();
      expect(container.classList.contains('viz-card')).toBe(true); // raised material container (depth, not flat)
      expect(container.classList.contains('viz-grain')).toBe(true); // vellum paper tooth
    });

    it('renders each agent as a hover-lift material card with a Spectral-voice head', async () => {
      setApi(vi.fn(async () => AGENTS));
      await mountAgents(root);
      await tick();
      for (const agent of Array.from(root.querySelectorAll<HTMLElement>('.agent'))) {
        expect(agent.classList.contains('viz-card')).toBe(true);
        expect(agent.classList.contains('viz-card--lift')).toBe(true); // hover-life (§3)
      }
      const label = root.querySelector<HTMLElement>('.agent[data-key="decompose"] .agent-label')!;
      expect(label.classList.contains('viz-voice')).toBe(true); // Spectral head (§4), no emoji
    });

    it('keeps the material adoption on the empty + loading states (no flat .card fallback)', async () => {
      setApi(vi.fn(async () => []));
      await mountAgents(root);
      await tick();
      const container = root.querySelector<HTMLElement>('.agents-v2')!;
      expect(container?.classList.contains('viz-card')).toBe(true);
      expect(root.querySelector('.card')).toBeNull(); // the legacy flat card is fully retired here
    });
  });

  // SPEC-0048 — the global "Default model" picker over the live CLI catalog.
  describe('SPEC-0048 model picker', () => {
    const CATALOG: ModelCatalogView = {
      accepted: ['claude-opus-4.8', 'claude-sonnet-4.5', 'gpt-5.5'],
      resolved: 'claude-opus-4.8',
      configured: 'claude-opus-4.8',
      staleConfigured: false,
    };

    it('renders a .viz-select picker over the catalog with the configured model selected + a "runs as" caption', async () => {
      setApi(vi.fn(async () => AGENTS), vi.fn(async () => CATALOG), vi.fn());
      await mountAgents(root);
      await tick();
      const select = root.querySelector<HTMLSelectElement>('select.viz-select#model-default')!;
      expect(select).toBeTruthy();
      // an "Auto" clear option + one per accepted model
      expect(select.querySelectorAll('option')).toHaveLength(4);
      expect(select.value).toBe('claude-opus-4.8'); // the configured pick is selected
      expect(root.querySelector('.model-runs')?.textContent).toContain('claude-opus-4.8'); // runs-as caption
      expect(root.querySelector('.model-stale')).toBeNull(); // not stale → no brass note
    });

    it('shows a BRASS stale note when the persisted pick is no longer in the live catalog', async () => {
      const stale: ModelCatalogView = { accepted: ['claude-opus-4.8'], resolved: 'claude-opus-4.8', configured: 'claude-opus-4', staleConfigured: true };
      setApi(vi.fn(async () => AGENTS), vi.fn(async () => stale), vi.fn());
      await mountAgents(root);
      await tick();
      const note = root.querySelector<HTMLElement>('.model-stale')!;
      expect(note).toBeTruthy();
      expect(note.classList.contains('model-stale')).toBe(true);
      expect(note.getAttribute('role')).toBe('status');
      expect(note.textContent).toContain('claude-opus-4'); // names the unavailable id
      // #184 a11y audit: the needs-you brass hue rides an aria-hidden ◆ mark (the label text reads AA
      // in --viz-ink); fails-before this fix (no mark span — brass was on the text, sub-AA on cream).
      const mark = note.querySelector('.model-stale-mark')!;
      expect(mark).toBeTruthy();
      expect(mark.getAttribute('aria-hidden')).toBe('true'); // glyph carries hue, not announced
    });

    it('persists a pick via setModel on change and updates the runs-as caption in place', async () => {
      const setModel = vi.fn(async () => ({ ok: true, resolved: 'gpt-5.5' }));
      setApi(vi.fn(async () => AGENTS), vi.fn(async () => CATALOG), setModel);
      await mountAgents(root);
      await tick();
      const select = root.querySelector<HTMLSelectElement>('#model-default')!;
      select.value = 'gpt-5.5';
      select.dispatchEvent(new Event('change'));
      await tick();
      expect(setModel).toHaveBeenCalledWith('gpt-5.5');
      expect(root.querySelector('.model-runs .path')?.textContent).toBe('gpt-5.5'); // caption reflects the new resolved
    });

    it('degrades to the agent list with NO picker when the catalog IPC is unavailable (ENG-15/16)', async () => {
      // getModelCatalog omitted → the call throws → catalog null → control omitted, list still renders.
      setApi(vi.fn(async () => AGENTS));
      await mountAgents(root);
      await tick();
      expect(root.querySelector('select.viz-select')).toBeNull();
      expect(root.querySelectorAll('.agent')).toHaveLength(2); // the list never blocks on the picker
    });

    it('shows a resolved-only readout (no dropdown) when the CLI catalog could not be probed (accepted=null)', async () => {
      const unprobed: ModelCatalogView = { accepted: null, resolved: 'claude-opus-4.8', configured: undefined, staleConfigured: false };
      setApi(vi.fn(async () => AGENTS), vi.fn(async () => unprobed), vi.fn());
      await mountAgents(root);
      await tick();
      expect(root.querySelector('select')).toBeNull(); // can't offer a list
      expect(root.querySelector('.model-runs')?.textContent).toContain('claude-opus-4.8'); // but shows what runs
    });

    // SPEC-0048 per-agent override (the SHOULD): each agent-backed row gets its own picker.
    it('renders a per-agent picker per agent-backed row with "Use default" + the configured pick selected', async () => {
      const agents: AgentView[] = [
        { key: 'connect', label: 'Connect', role: 'r', model: 'claude-sonnet-4.5', configuredModel: 'claude-sonnet-4.5', instructions: 'kb/connectAgent.ts', status: 'idle' },
        { key: 'decompose', label: 'Decompose', role: 'r', model: 'claude-opus-4.8', instructions: 'kb/decomposeAgent.ts', status: 'idle' },
      ];
      setApi(vi.fn(async () => agents), vi.fn(async () => CATALOG), vi.fn(), vi.fn());
      await mountAgents(root);
      await tick();
      const connectSel = root.querySelector<HTMLSelectElement>('.agent[data-key="connect"] .agent-model-select')!;
      expect(connectSel).toBeTruthy();
      expect(connectSel.querySelector('option')?.textContent).toContain('Use default'); // clear-override option, names the global
      // its configured pick is the selected option (assert the render's `selected` directly — robust to happy-dom's value quirk)
      expect(connectSel.querySelector('option[value="claude-sonnet-4.5"]')?.hasAttribute('selected')).toBe(true);
      // decompose has no per-agent pick → "Use default" (value '') is the selected option
      const decSel = root.querySelector<HTMLSelectElement>('.agent[data-key="decompose"] .agent-model-select')!;
      expect(decSel.querySelector('option[value=""]')?.hasAttribute('selected')).toBe(true);
      expect(root.querySelector('.agent[data-key="connect"] .agent-model-runs')?.textContent).toContain('claude-sonnet-4.5');
    });

    it('persists a per-agent pick via setAgentModel(key,id) on change and updates that row in place', async () => {
      const agents: AgentView[] = [{ key: 'connect', label: 'Connect', role: 'r', model: 'claude-opus-4.8', instructions: 'kb/connectAgent.ts', status: 'idle' }];
      const setAgentModel = vi.fn(async () => ({ ok: true, resolved: 'claude-sonnet-4.5' }));
      setApi(vi.fn(async () => agents), vi.fn(async () => CATALOG), vi.fn(), setAgentModel);
      await mountAgents(root);
      await tick();
      const sel = root.querySelector<HTMLSelectElement>('.agent[data-key="connect"] .agent-model-select')!;
      sel.value = 'claude-sonnet-4.5';
      sel.dispatchEvent(new Event('change'));
      await tick();
      expect(setAgentModel).toHaveBeenCalledWith('connect', 'claude-sonnet-4.5');
      expect(root.querySelector('.agent[data-key="connect"] .agent-model-runs .path')?.textContent).toBe('claude-sonnet-4.5');
    });

    // P1 chip-overlap fix: the per-agent picker + its "runs as:" caption must STACK inside one <dd> so
    // the caption never wraps beside / overlaps the select (or the row highlight) at narrow widths. The
    // CSS stack hangs off this DOM contract — the select and `.agent-model-runs` are siblings in the
    // Model cell, select FIRST (the caption is the block beneath it). Guards markup drift that would
    // re-orphan the caption next to the control.
    it('stacks the per-agent picker above its "runs as:" caption in one Model cell (select then caption)', async () => {
      const agents: AgentView[] = [{ key: 'connect', label: 'Connect', role: 'r', model: 'claude-sonnet-4.5', configuredModel: 'claude-sonnet-4.5', instructions: 'kb/connectAgent.ts', status: 'idle' }];
      setApi(vi.fn(async () => agents), vi.fn(async () => CATALOG), vi.fn(), vi.fn());
      await mountAgents(root);
      await tick();
      const select = root.querySelector<HTMLElement>('.agent[data-key="connect"] .agent-model-select')!;
      const runs = root.querySelector<HTMLElement>('.agent[data-key="connect"] .agent-model-runs')!;
      expect(select).toBeTruthy();
      expect(runs).toBeTruthy();
      const cell = select.parentElement!; // the <dd> Model cell
      expect(cell.tagName).toBe('DD');
      expect(runs.parentElement).toBe(cell); // caption is a sibling in the SAME cell, not nested in the select
      // select precedes the caption (caption stacks beneath via the .agent-model-runs block rule)
      expect(cell.compareDocumentPosition(runs) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      expect(select.compareDocumentPosition(runs) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    });
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
