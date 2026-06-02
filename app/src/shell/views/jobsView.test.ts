// @vitest-environment happy-dom
//
// SPEC-0027 PANEL-2/7 — the Jobs view, in the component tier (SPEC-0012 TEST-5; happy-dom via
// per-file env, node tier stays default). The IPC is mocked (`window.kbApi`); we assert the rendered
// DOM, that risky changes (enable, posture→Autonomous, Run now) gate behind a confirm before calling
// IPC, and that non-risky changes (disable, cadence) apply directly. The pure merge/risk logic is
// covered separately in `kb/jobsPanel.test.ts`.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mountJobs } from './jobsView';
import { LOAD_TIMEOUT_MS } from '../loadGuard';
import type { JobView, KbApi } from '../../kb/types';

function job(over: Partial<JobView> & Pick<JobView, 'id'>): JobView {
  return {
    type: over.id,
    label: 'Reflect',
    description: 'reviews your KB',
    production: true,
    registered: false,
    enabled: false,
    schedule: 'off',
    posture: 'guarded',
    lastRun: null,
    ...over,
  };
}

type JobsApi = Pick<KbApi, 'listJobs' | 'setJobConfig' | 'runJobNow'>;
function setApi(api: JobsApi): void {
  (window as unknown as { kbApi: JobsApi }).kbApi = api;
}
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

function li(root: HTMLElement, id: string): HTMLElement {
  return root.querySelector<HTMLElement>(`.job[data-id="${id}"]`)!;
}

describe('Jobs view (SPEC-0027 PANEL-2/7)', () => {
  let root: HTMLElement;
  beforeEach(() => {
    document.body.innerHTML = '<div id="r"></div>';
    root = document.getElementById('r')!;
  });

  it('lists jobs with label, reference badge, and last-run summary (PANEL-2)', async () => {
    setApi({
      listJobs: vi.fn(async () => [
        job({ id: 'reflect', label: 'Reflect', production: true }),
        job({
          id: 'example',
          label: 'Entity census',
          production: false,
          registered: true,
          enabled: true,
          schedule: 'hourly',
          lastRun: { ts: '2026-06-02T07:00:00.000Z', inspected: 'entities/ (3 nodes)', applied: 1, deferred: 2 },
        }),
      ]),
      setJobConfig: vi.fn(),
      runJobNow: vi.fn(),
    });
    await mountJobs(root);

    expect(root.querySelector('h1')?.textContent).toContain('Jobs');
    expect(root.querySelectorAll('.job')).toHaveLength(2);
    expect(li(root, 'reflect').querySelector('.job-label')?.textContent).toBe('Reflect');
    // The non-production reference job is badged; the production one is not.
    expect(li(root, 'example').querySelector('.badge')).toBeTruthy();
    expect(li(root, 'reflect').querySelector('.badge')).toBeNull();
    expect(li(root, 'example').querySelector('.job-lastrun')?.textContent).toContain('1 applied, 2 deferred');
    expect(li(root, 'reflect').querySelector('.job-lastrun')?.textContent).toContain('Never run');
  });

  it('shows a friendly empty state when there are no jobs (PANEL-9)', async () => {
    setApi({ listJobs: vi.fn(async () => []), setJobConfig: vi.fn(), runJobNow: vi.fn() });
    await mountJobs(root);
    expect(root.textContent).toContain('open a Knowledge Base');
  });

  it('enabling a job is risky: confirms first, then persists on confirm (PANEL-7)', async () => {
    const setJobConfig = vi.fn(async () => [job({ id: 'reflect', enabled: true, registered: true })]);
    setApi({ listJobs: vi.fn(async () => [job({ id: 'reflect' })]), setJobConfig, runJobNow: vi.fn() });
    await mountJobs(root);

    const row = li(root, 'reflect');
    const toggle = row.querySelector<HTMLInputElement>('.job-enabled')!;
    toggle.checked = true;
    toggle.dispatchEvent(new Event('change', { bubbles: true }));

    // Confirm is revealed; nothing persisted yet.
    expect(row.querySelector<HTMLElement>('.job-confirm')!.hidden).toBe(false);
    expect(setJobConfig).not.toHaveBeenCalled();

    row.querySelector<HTMLButtonElement>('.job-confirm-go')!.click();
    await tick();
    expect(setJobConfig).toHaveBeenCalledWith({ id: 'reflect', type: 'reflect', enabled: true });
  });

  it('cancelling a risky change reverts the control and does not persist (PANEL-7)', async () => {
    const setJobConfig = vi.fn();
    setApi({ listJobs: vi.fn(async () => [job({ id: 'reflect' })]), setJobConfig, runJobNow: vi.fn() });
    await mountJobs(root);

    const row = li(root, 'reflect');
    const toggle = row.querySelector<HTMLInputElement>('.job-enabled')!;
    toggle.checked = true;
    toggle.dispatchEvent(new Event('change', { bubbles: true }));
    row.querySelector<HTMLButtonElement>('.job-confirm-cancel')!.click();
    await tick();

    expect(setJobConfig).not.toHaveBeenCalled();
    expect(toggle.checked).toBe(false); // reverted
    expect(row.querySelector<HTMLElement>('.job-confirm')!.hidden).toBe(true);
  });

  it('changing the schedule is not risky — persists directly (PANEL-2)', async () => {
    const setJobConfig = vi.fn(async () => [job({ id: 'reflect', schedule: 'daily' })]);
    setApi({ listJobs: vi.fn(async () => [job({ id: 'reflect' })]), setJobConfig, runJobNow: vi.fn() });
    await mountJobs(root);

    const sched = li(root, 'reflect').querySelector<HTMLSelectElement>('.job-schedule')!;
    sched.value = 'daily';
    sched.dispatchEvent(new Event('change', { bubbles: true }));
    await tick();
    expect(setJobConfig).toHaveBeenCalledWith({ id: 'reflect', type: 'reflect', schedule: 'daily' });
  });

  it('moving to Autonomous posture is risky — confirms first (PANEL-7)', async () => {
    const setJobConfig = vi.fn(async () => [job({ id: 'reflect', posture: 'autonomous' })]);
    setApi({ listJobs: vi.fn(async () => [job({ id: 'reflect' })]), setJobConfig, runJobNow: vi.fn() });
    await mountJobs(root);

    const row = li(root, 'reflect');
    const posture = row.querySelector<HTMLSelectElement>('.job-posture')!;
    posture.value = 'autonomous';
    posture.dispatchEvent(new Event('change', { bubbles: true }));
    expect(row.querySelector<HTMLElement>('.job-confirm')!.hidden).toBe(false);
    expect(setJobConfig).not.toHaveBeenCalled();

    row.querySelector<HTMLButtonElement>('.job-confirm-go')!.click();
    await tick();
    expect(setJobConfig).toHaveBeenCalledWith({ id: 'reflect', type: 'reflect', posture: 'autonomous' });
  });

  it('Run now confirms, calls IPC, and reports the outcome (PANEL-2/JOBS-11)', async () => {
    const runJobNow = vi.fn(async () => ({ ran: true as const, outcome: 'advanced' as const, applied: 2, deferred: 1 }));
    setApi({ listJobs: vi.fn(async () => [job({ id: 'reflect' })]), setJobConfig: vi.fn(), runJobNow });
    await mountJobs(root);

    const row = li(root, 'reflect');
    row.querySelector<HTMLButtonElement>('.job-run')!.click();
    expect(row.querySelector<HTMLElement>('.job-confirm')!.hidden).toBe(false);
    expect(runJobNow).not.toHaveBeenCalled();

    row.querySelector<HTMLButtonElement>('.job-confirm-go')!.click();
    await tick();
    expect(runJobNow).toHaveBeenCalledWith('reflect');
    expect(li(root, 'reflect').querySelector('.job-status')?.textContent).toContain('2 applied, 1 deferred');
  });

  it('Run now shows a clear running state on the button (PANEL-10) then resets on completion', async () => {
    type RunOk = { ran: true; outcome: 'advanced'; applied: number; deferred: number };
    let resolveRun!: (v: RunOk) => void;
    const runJobNow = vi.fn((): Promise<RunOk> => new Promise<RunOk>((res) => (resolveRun = res)));
    setApi({ listJobs: vi.fn(async () => [job({ id: 'reflect' })]), setJobConfig: vi.fn(), runJobNow });
    await mountJobs(root);
    li(root, 'reflect').querySelector<HTMLButtonElement>('.job-run')!.click();
    li(root, 'reflect').querySelector<HTMLButtonElement>('.job-confirm-go')!.click();
    await tick();

    const runBtn = li(root, 'reflect').querySelector<HTMLButtonElement>('.job-run')!;
    expect(runBtn.disabled).toBe(true);
    expect(runBtn.textContent).toBe('Running…');

    resolveRun({ ran: true, outcome: 'advanced', applied: 1, deferred: 0 });
    await tick();
    const after = li(root, 'reflect').querySelector<HTMLButtonElement>('.job-run')!;
    expect(after.disabled).toBe(false);
    expect(after.textContent).toBe('Run now');
  });

  it('renders an error instead of throwing if listing fails (PANEL-9)', async () => {
    setApi({
      listJobs: vi.fn(async () => {
        throw new Error('boom');
      }),
      setJobConfig: vi.fn(),
      runJobNow: vi.fn(),
    });
    await mountJobs(root);
    expect(root.querySelector('.load-error')?.textContent).toContain('Couldn’t load'); // retryable fallback (#145)
    expect(root.querySelector('.load-retry')).toBeTruthy();
  });
});

describe('Jobs view · #145 load resilience (no infinite spinner on a hung IPC)', () => {
  let root: HTMLElement;
  beforeEach(() => {
    vi.useFakeTimers();
    document.body.innerHTML = '<div id="r"></div>';
    root = document.getElementById('r')!;
  });
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('times out a hung listJobs → retryable error, and Retry re-loads successfully', async () => {
    const listJobs = vi.fn<KbApi['listJobs']>().mockReturnValueOnce(new Promise<JobView[]>(() => {})); // hangs
    setApi({ listJobs, setJobConfig: vi.fn(), runJobNow: vi.fn() });
    const mounted = mountJobs(root); // blocked on the hung load
    expect(root.textContent).toContain('Loading…'); // spinner initially

    await vi.advanceTimersByTimeAsync(LOAD_TIMEOUT_MS); // trip the timeout
    await mounted;
    expect(root.textContent).not.toContain('Loading…'); // no infinite spinner
    expect(root.querySelector('.load-error')).toBeTruthy();

    // Retry succeeds → the list renders.
    listJobs.mockResolvedValueOnce([job({ id: 'reflect' })]);
    root.querySelector<HTMLButtonElement>('.load-retry')!.click();
    await vi.advanceTimersByTimeAsync(0); // flush the (resolved) reload
    expect(root.querySelector('.job[data-id="reflect"]')).toBeTruthy();
  });
});
