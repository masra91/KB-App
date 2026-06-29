// @vitest-environment happy-dom
//
// SPEC-0009 SETUP — guided first-run flow (model → optional sample seed → short tour), component tier
// (happy-dom). IPC mocked. Asserts: step progression + progress rail; the model step persists a pick via
// setModel (and Skip doesn't); the seed step pushes the samples through the REAL capture path (and Skip
// doesn't); the tour hands off via onDone; and — the hard bar for a setup surface — every step DEGRADES
// (a failed/absent model catalog or a failed seed never blocks finishing; ENG-15/16 + SETUP-4 ethos).
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { runGuidedSetup, SAMPLE_SEED_NOTES } from './setupFlow';
import type { KbApi, ModelCatalogView } from '../kb/types';

let getModelCatalog: ReturnType<typeof vi.fn>;
let setModel: ReturnType<typeof vi.fn>;
let capture: ReturnType<typeof vi.fn>;

const catalog = (over: Partial<ModelCatalogView> = {}): ModelCatalogView => ({
  accepted: ['claude-sonnet-4.6', 'claude-opus-4.8'], resolved: 'claude-sonnet-4.6', staleConfigured: false, ...over,
});

function setApi(): void {
  (window as unknown as { kbApi: Partial<KbApi> }).kbApi = {
    getModelCatalog: getModelCatalog as unknown as KbApi['getModelCatalog'],
    setModel: setModel as unknown as KbApi['setModel'],
    capture: capture as unknown as KbApi['capture'],
  };
}
const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  getModelCatalog = vi.fn(async () => catalog());
  setModel = vi.fn(async () => ({ ok: true, resolved: 'claude-opus-4.8' }));
  capture = vi.fn(async () => ({ ok: true, ids: ['A', 'B', 'C'], captureBatch: 'batch1', committed: true, message: 'ok' }));
  setApi();
});

async function mount(onDone = vi.fn()): Promise<{ root: HTMLElement; onDone: ReturnType<typeof vi.fn> }> {
  const root = document.createElement('div');
  document.body.appendChild(root);
  runGuidedSetup(root, { vaultName: 'My Library', onDone });
  await flush(); // model step awaits getModelCatalog
  return { root, onDone };
}

describe('Guided setup — model step (SPEC-0009)', () => {
  it('renders the model step first, with the live catalog as options + a progress rail', async () => {
    const { root } = await mount();
    expect(root.querySelector('.setup-guided')).toBeTruthy();
    expect(root.querySelectorAll('.setup-dot')).toHaveLength(3);
    expect(root.querySelector('.setup-dot--on')).toBe(root.querySelectorAll('.setup-dot')[0]); // step 1 active
    const opts = Array.from(root.querySelectorAll<HTMLOptionElement>('#setup-model option')).map((o) => o.value);
    expect(opts).toEqual(['', 'claude-sonnet-4.6', 'claude-opus-4.8']); // recommended-default + the catalog
  });

  it('Continue with a pick persists it via setModel, then advances to the seed step', async () => {
    const { root } = await mount();
    (root.querySelector('#setup-model') as HTMLSelectElement).value = 'claude-opus-4.8';
    (root.querySelector('#setup-model-next') as HTMLButtonElement).click();
    await flush();
    expect(setModel).toHaveBeenCalledWith('claude-opus-4.8');
    expect(root.querySelector('#setup-seed-add')).toBeTruthy(); // advanced to seed
  });

  it('Continue WITHOUT a pick (recommended default) does not call setModel but still advances', async () => {
    const { root } = await mount();
    (root.querySelector('#setup-model-next') as HTMLButtonElement).click();
    await flush();
    expect(setModel).not.toHaveBeenCalled();
    expect(root.querySelector('#setup-seed-add')).toBeTruthy();
  });

  it('Skip on the model step advances without persisting', async () => {
    const { root } = await mount();
    (root.querySelector('#setup-model-skip') as HTMLButtonElement).click();
    await flush();
    expect(setModel).not.toHaveBeenCalled();
    expect(root.querySelector('#setup-seed-add')).toBeTruthy();
  });

  it('DEGRADES when the catalog fetch fails — no picker, a calm note, Continue still advances (ENG-15/16)', async () => {
    getModelCatalog = vi.fn(async () => { throw new Error('no CLI'); });
    setApi();
    const { root } = await mount();
    expect(root.querySelector('#setup-model')).toBeNull(); // no dead control
    expect(root.querySelector('.setup-note')?.textContent).toMatch(/default/i);
    (root.querySelector('#setup-model-next') as HTMLButtonElement).click();
    await flush();
    expect(root.querySelector('#setup-seed-add')).toBeTruthy(); // never blocked
  });

  it('DEGRADES on an empty/unknown catalog (accepted:null) — note only, no select (ENG-15/16)', async () => {
    getModelCatalog = vi.fn(async () => catalog({ accepted: null }));
    setApi();
    const { root } = await mount();
    expect(root.querySelector('#setup-model')).toBeNull();
    expect(root.querySelector('#setup-model-next')).toBeTruthy();
  });
});

describe('Guided setup — sample seed step (SPEC-0009)', () => {
  async function toSeed(): Promise<HTMLElement> {
    const { root } = await mount();
    (root.querySelector('#setup-model-skip') as HTMLButtonElement).click();
    await flush();
    return root;
  }

  it('"Add samples" pushes the samples through the real capture path (one request, all notes), then advances', async () => {
    const root = await toSeed();
    (root.querySelector('#setup-seed-add') as HTMLButtonElement).click();
    await flush();
    expect(capture).toHaveBeenCalledTimes(1);
    const req = capture.mock.calls[0][0] as { inputs: { kind: string; text: string }[] };
    expect(req.inputs).toHaveLength(SAMPLE_SEED_NOTES.length);
    expect(req.inputs.every((i) => i.kind === 'text')).toBe(true);
    expect(root.querySelector('.setup-tour')).toBeTruthy(); // advanced to the tour
  });

  it('Skip starts empty — no capture, advances to the tour', async () => {
    const root = await toSeed();
    (root.querySelector('#setup-seed-skip') as HTMLButtonElement).click();
    await flush();
    expect(capture).not.toHaveBeenCalled();
    expect(root.querySelector('.setup-tour')).toBeTruthy();
  });

  it('Back from the seed step returns to the model step (skip/back works across guided steps)', async () => {
    const root = await toSeed();
    (root.querySelector('#setup-seed-back') as HTMLButtonElement).click();
    await flush();
    expect(root.querySelector('#setup-model-next')).toBeTruthy(); // back on the model step
    expect(root.querySelectorAll('.setup-dot')[0].classList.contains('setup-dot--on')).toBe(true);
  });

  it('a failed seed is NON-BLOCKING — honest note + a Continue that still advances (ENG-15/16)', async () => {
    capture = vi.fn(async () => { throw new Error('disk full'); });
    setApi();
    const root = await toSeed();
    (root.querySelector('#setup-seed-add') as HTMLButtonElement).click();
    await flush();
    expect(root.querySelector('.setup-seed-status')?.textContent).toMatch(/couldn’t add|continuing/i);
    const cont = root.querySelector('#setup-seed-add') as HTMLButtonElement;
    expect(cont.disabled).toBe(false);
    cont.click(); // the recovered Continue
    await flush();
    expect(root.querySelector('.setup-tour')).toBeTruthy();
  });
});

describe('Guided setup — tour + handoff (SPEC-0009)', () => {
  async function toTour(): Promise<{ root: HTMLElement; onDone: ReturnType<typeof vi.fn> }> {
    const onDone = vi.fn();
    const { root } = await mount(onDone);
    (root.querySelector('#setup-model-skip') as HTMLButtonElement).click();
    await flush();
    (root.querySelector('#setup-seed-skip') as HTMLButtonElement).click();
    await flush();
    return { root, onDone };
  }

  it('renders the tour cards + the vault name, with the last progress dot active', async () => {
    const { root } = await toTour();
    expect(root.querySelectorAll('.setup-tour-card').length).toBeGreaterThanOrEqual(4);
    expect(root.querySelector('.setup-lead')?.textContent).toContain('My Library');
    expect(root.querySelectorAll('.setup-dot')[2].classList.contains('setup-dot--on')).toBe(true);
  });

  it('Finish hands off via onDone (→ the shell); it is NOT called before Finish', async () => {
    const { root, onDone } = await toTour();
    expect(onDone).not.toHaveBeenCalled();
    (root.querySelector('#setup-tour-finish') as HTMLButtonElement).click();
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it('Back from the tour returns to the seed step', async () => {
    const { root } = await toTour();
    (root.querySelector('#setup-tour-back') as HTMLButtonElement).click();
    await flush();
    expect(root.querySelector('#setup-seed-add')).toBeTruthy();
  });
});
