// SPEC-0009 SETUP — guided first-run continuation ("set model → optional sample seed → short tour").
// renderer.ts owns the tested vault step (SETUP-1..6: pick/create folder → git → Copilot → scaffold +
// first commit). Once the KB exists, instead of jumping straight to the shell we walk the Principal
// through the remaining one-time setup here, on the WS2 design-system primitives ("The Line", `viz-*`):
//
//   1. Model   — pick the default agent model (reuses the live SPEC-0048 picker IPC), or keep the default.
//   2. Seed    — OPTIONAL: push a few sample notes through the REAL capture pipeline so the KB isn't empty.
//   3. Tour    — a short, skippable orientation to Capture / Reviews / Manage / Ask.
//
// Every step is skippable and DEGRADES (never blocks finishing — SETUP-4's "warning, not a hard block"
// ethos): a failed/hung model fetch or a failed seed surfaces a calm note and Continue still works. The
// flow runs only in the create path, so a returning launch (vault already configured) never re-onboards
// (SETUP-6). On Finish it calls `onDone`, which hands off to the navigation shell.
import { esc } from './html';
import { withTimeout } from './loadGuard';
import type { ModelCatalogView } from '../kb/types';

export interface GuidedSetupOptions {
  vaultName: string;
  /** Called once the guided steps are done (or skipped) — hands off to the shell. */
  onDone: () => void;
}

type StepId = 'model' | 'seed' | 'tour';
const STEP_ORDER: StepId[] = ['model', 'seed', 'tour'];

/** The sample notes a seed plants — brand-neutral, demonstrate the three captureable shapes (a note, an
 *  idea, a reading highlight). They flow through the real ingest pipeline as ordinary captures. */
export const SAMPLE_SEED_NOTES: string[] = [
  '# Welcome to your knowledge base\n\nThis is a sample note. Capture anything — meeting notes, ideas, links — and your librarians file it, link it, and surface it when you ask.',
  '# Idea: weekly review ritual\n\nEvery Friday, skim the week\'s captures and promote the keepers. The Reviews queue collects anything that needs a human decision.',
  '# Reading: "The Knowledge Project"\n\nKey takeaway — a second brain is only as good as how easily you can *recall* from it. Ask questions in plain language; answers come back cited to your own sources.',
];

/** Mount the guided post-create setup into `root`. Renders the first step immediately. */
export function runGuidedSetup(root: HTMLElement, opts: GuidedSetupOptions): void {
  let index = 0;
  const goTo = (i: number): void => {
    index = Math.max(0, Math.min(STEP_ORDER.length - 1, i));
    void renderStep(root, STEP_ORDER[index], index, opts, goTo);
  };
  goTo(0);
}

/** The progress rail + frame shared by every step (WS2). `stepIndex` is 0-based. */
function frame(stepIndex: number, title: string, lead: string, body: string, footer: string): string {
  const dots = STEP_ORDER.map((_s, i) => `<span class="setup-dot${i === stepIndex ? ' setup-dot--on' : ''}${i < stepIndex ? ' setup-dot--done' : ''}" aria-hidden="true"></span>`).join('');
  return `
    <div class="setup-guided viz-surface">
      <div class="setup-rail" role="progressbar" aria-valuemin="1" aria-valuemax="${STEP_ORDER.length}" aria-valuenow="${stepIndex + 1}" aria-label="Setup step ${stepIndex + 1} of ${STEP_ORDER.length}">${dots}</div>
      <h1 class="setup-title viz-signage">${esc(title)}</h1>
      <p class="setup-lead viz-body">${lead}</p>
      <div class="setup-body">${body}</div>
      <div class="setup-actions">${footer}</div>
    </div>`;
}

async function renderStep(root: HTMLElement, step: StepId, index: number, opts: GuidedSetupOptions, goTo: (i: number) => void): Promise<void> {
  if (step === 'model') return renderModelStep(root, index, goTo);
  if (step === 'seed') return renderSeedStep(root, index, goTo);
  return renderTourStep(root, index, opts, goTo);
}

// ── Step 1 · Model ────────────────────────────────────────────────────────────────────────────────
async function renderModelStep(root: HTMLElement, index: number, goTo: (i: number) => void): Promise<void> {
  let catalog: ModelCatalogView | null = null;
  try {
    // Bound the wait (#145) — a hung catalog fetch must not strand the wizard on a spinner.
    catalog = await withTimeout(window.kbApi.getModelCatalog());
  } catch {
    catalog = null;
  }
  const accepted = catalog?.accepted ?? null;
  const resolved = catalog?.resolved ?? '';
  const lead = 'Your librarian agents run on a model you bring (GitHub Copilot). Pick a default now, or keep the recommended one — you can change it any time in Manage › Agents.';

  // Degrade (ENG-15/16): no catalog (fetch failed) or an empty/unknown list → no picker, just a calm
  // "using the default" note + Continue. Never a dead control, never a hard block (SETUP-4 ethos).
  let body: string;
  if (!accepted || accepted.length === 0) {
    body = `<p class="setup-note viz-body">${catalog ? `Using the default model${resolved ? ` — <span class="path">${esc(resolved)}</span>` : ''}.` : 'Couldn’t reach the model list right now — your KB will use the default. You can set one later in Manage › Agents.'}</p>`;
  } else {
    const options = [`<option value="">Recommended default${resolved ? ` (${esc(resolved)})` : ''}</option>`]
      .concat(accepted.map((m) => `<option value="${esc(m)}"${m === catalog?.configured ? ' selected' : ''}>${esc(m)}</option>`))
      .join('');
    body = `
      <label class="setup-field viz-field">
        <span class="viz-field__label viz-signage">Default model</span>
        <select id="setup-model" class="viz-select" aria-label="Default agent model">${options}</select>
      </label>
      <p class="setup-note viz-body">Currently runs as <span class="path">${esc(resolved)}</span>.</p>`;
  }
  const footer = `
    <button type="button" class="viz-btn setup-skip" id="setup-model-skip">Skip</button>
    <button type="button" class="viz-btn viz-btn--primary setup-next" id="setup-model-next">Continue</button>`;
  root.innerHTML = frame(index, 'Choose your model', lead, body, footer);

  const advance = (): void => goTo(index + 1);
  root.querySelector<HTMLButtonElement>('#setup-model-skip')!.addEventListener('click', advance);
  root.querySelector<HTMLButtonElement>('#setup-model-next')!.addEventListener('click', async () => {
    const sel = root.querySelector<HTMLSelectElement>('#setup-model');
    const pick = sel?.value ?? '';
    const next = root.querySelector<HTMLButtonElement>('#setup-model-next')!;
    if (pick.length > 0) {
      next.disabled = true;
      next.textContent = 'Saving…';
      try {
        await window.kbApi.setModel(pick); // validated server-side; a rejected id just keeps the default
      } catch {
        /* non-blocking — fall through to the next step regardless (SETUP-4 ethos) */
      }
    }
    advance();
  });
}

// ── Step 2 · Sample seed (optional) ─────────────────────────────────────────────────────────────────
async function renderSeedStep(root: HTMLElement, index: number, goTo: (i: number) => void): Promise<void> {
  const lead = 'Want a few sample notes to explore? They flow in through the same pipeline your real captures use — so you can see filing, linking, and recall right away. Skip for an empty, pristine KB.';
  const body = `
    <ul class="setup-samples viz-body">
      <li>A welcome note</li>
      <li>An idea (weekly review ritual)</li>
      <li>A reading highlight</li>
    </ul>
    <p class="setup-note viz-body">Samples are ordinary notes — you can edit or delete them like anything else.</p>
    <p class="setup-seed-status viz-body" role="status" aria-live="polite"></p>`;
  const footer = `
    <button type="button" class="viz-btn setup-skip" id="setup-seed-skip">Skip — start empty</button>
    <button type="button" class="viz-btn viz-btn--primary setup-next" id="setup-seed-add">Add ${SAMPLE_SEED_NOTES.length} samples</button>`;
  root.innerHTML = frame(index, 'Add a few samples?', lead, body, footer);

  const advance = (): void => goTo(index + 1);
  root.querySelector<HTMLButtonElement>('#setup-seed-skip')!.addEventListener('click', advance);
  root.querySelector<HTMLButtonElement>('#setup-seed-add')!.addEventListener('click', async () => {
    const add = root.querySelector<HTMLButtonElement>('#setup-seed-add')!;
    const status = root.querySelector<HTMLElement>('.setup-seed-status')!;
    add.disabled = true;
    add.textContent = 'Adding…';
    try {
      // Reuse the REAL capture path — one request carrying the sample notes as text inputs (dogfood, no
      // bespoke seeder). The pipeline files them like any capture; the wizard doesn't wait on enrichment.
      await window.kbApi.capture({ inputs: SAMPLE_SEED_NOTES.map((text) => ({ kind: 'text', text })) });
      status.textContent = 'Samples added — they’ll appear as your librarians file them.';
      advance();
    } catch {
      // Non-blocking: seeding is a nicety, not a gate. Let the Principal continue with an honest note.
      status.textContent = 'Couldn’t add samples right now — you can capture your own anytime. Continuing…';
      add.disabled = false;
      add.textContent = 'Continue';
      add.classList.remove('viz-btn--primary');
      add.onclick = advance;
    }
  });
}

// ── Step 3 · Short tour ──────────────────────────────────────────────────────────────────────────────
interface TourCard { glyph: string; title: string; body: string; }
const TOUR_CARDS: TourCard[] = [
  { glyph: '✎', title: 'Capture', body: 'Jot anything — notes, links, files. It’s the home screen, always one keystroke away.' },
  { glyph: '◷', title: 'Reviews', body: 'When a librarian needs a human call, it lands here — a small “needs you” queue, never a firehose.' },
  { glyph: '⚙', title: 'Manage', body: 'Tune your agents, researchers, and sources — enable, configure, run, or retire them.' },
  { glyph: '❖', title: 'Ask', body: 'Ask in plain language. Answers come back grounded in — and cited to — your own captures.' },
];

function renderTourStep(root: HTMLElement, index: number, opts: GuidedSetupOptions, goTo: (i: number) => void): void {
  const lead = `Your KB <span class="path">${esc(opts.vaultName)}</span> is ready. A 10-second lay of the land:`;
  const cards = TOUR_CARDS.map(
    (c) => `<li class="setup-tour-card viz-no-chrome"><span class="setup-tour-glyph" aria-hidden="true">${esc(c.glyph)}</span><div><span class="setup-tour-title viz-signage">${esc(c.title)}</span><p class="setup-tour-body viz-body">${esc(c.body)}</p></div></li>`,
  ).join('');
  const body = `<ul class="setup-tour">${cards}</ul>`;
  const footer = `
    <button type="button" class="viz-btn setup-back" id="setup-tour-back">Back</button>
    <button type="button" class="viz-btn viz-btn--primary setup-finish" id="setup-tour-finish">Enter ${esc(opts.vaultName)}</button>`;
  root.innerHTML = frame(index, 'You’re set up', lead, body, footer);

  root.querySelector<HTMLButtonElement>('#setup-tour-back')!.addEventListener('click', () => goTo(index - 1));
  root.querySelector<HTMLButtonElement>('#setup-tour-finish')!.addEventListener('click', () => opts.onDone());
}
