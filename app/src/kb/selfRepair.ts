// SPEC-0049 HEAL-1 — the self-repair round. The deciders used to blind-retry the SAME prompt on a
// parse/validation failure (3× then toss), so a model that emitted slightly-off JSON failed the same
// way every attempt. Self-repair instead re-prompts with the ERROR fed back ("your JSON failed at X —
// fix it"), so the model corrects on the next round. It's the sibling of `runWithModelFallback`
// (copilotLaunch.ts): that wrapper recovers a bad *model id*; this one recovers a bad *response*.
//
// Boundary (HEAL-6, the #256 hard gate): self-repair ONLY catches failures thrown by `parse` — i.e.
// parse/validation of the model's output. A failure thrown by `attempt` itself (copilot unavailable,
// timeout, a systemic canonical-writer wedge surfacing later) is NOT a parse error and propagates
// unchanged — we never re-prompt our way around a launch/systemic failure, so the orchestrator's
// circuit-breaker still sees it and trips. Repairs are strictly bounded (default 1 round, max 2).

/** The feedback handed back to the model on a repair round: the validator error + the raw output that
 *  failed it, so the model can see exactly what to fix. */
export interface RepairHint {
  /** The parse/validation error message (e.g. "connect: verdict covers 4 of 5 candidates"). */
  error: string;
  /** The model's previous raw output that failed to parse (bounded when appended to the prompt). */
  priorRaw: string;
}

const MAX_PRIOR_RAW_CHARS = 4000;

/**
 * Append a corrective instruction to a base prompt for a repair round (HEAL-1). The model sees its own
 * failed output + the exact validator error and is told to return ONLY corrected JSON. Pure + exported
 * so deciders compose it and tests assert the feedback is faithful.
 */
export function appendRepairInstruction(basePrompt: string, repair: RepairHint): string {
  return [
    basePrompt,
    '',
    '--- YOUR PREVIOUS RESPONSE COULD NOT BE USED — FIX IT ---',
    `The parser rejected your last response with this error:`,
    `  ${repair.error}`,
    'Your previous response was:',
    repair.priorRaw.length > MAX_PRIOR_RAW_CHARS
      ? `${repair.priorRaw.slice(0, MAX_PRIOR_RAW_CHARS)}\n…(truncated)`
      : repair.priorRaw,
    '',
    'Return ONLY a corrected JSON object that resolves that exact error. Output the JSON and nothing',
    'else — no explanation, no markdown code fences. Keep every part of your answer that was already',
    'valid; change only what the error calls out.',
  ].join('\n');
}

/** Result of a self-repair run, including how many repair rounds it took (0 = parsed first try) so the
 *  caller can record it in the AgentTrace (observability — self-healing is visible, not silent). */
export interface SelfRepairOutcome<T> {
  value: T;
  repairs: number;
}

/**
 * Run `attempt` (which launches Copilot and returns raw stdout) then `parse` it; on a parse/validation
 * failure, re-prompt up to `maxRepairs` times with the error fed back, and return the first result that
 * parses. If every round still fails, the LAST parse error is thrown (so the stage handles a genuinely
 * un-repairable item exactly as before — retry/set-aside, or HEAL-5 routing in Slice 2).
 *
 * `attempt(repair)` is called with `null` on the first round and a `RepairHint` on each repair round —
 * the caller uses it to append `appendRepairInstruction` to the prompt. Only `parse` failures are
 * recoverable here; an error from `attempt` propagates immediately (see the boundary note above).
 */
export async function runWithSelfRepair<T>(
  attempt: (repair: RepairHint | null) => Promise<string>,
  parse: (stdout: string) => T,
  opts: { maxRepairs?: number; onRepair?: (round: number, error: string) => void } = {},
): Promise<SelfRepairOutcome<T>> {
  const maxRepairs = Math.max(0, Math.min(2, opts.maxRepairs ?? 1));
  let raw = await attempt(null);
  for (let round = 0; ; round++) {
    try {
      return { value: parse(raw), repairs: round };
    } catch (err) {
      if (round >= maxRepairs) throw err; // exhausted the bounded repair budget — a real, un-repairable failure
      const error = err instanceof Error ? err.message : String(err);
      opts.onRepair?.(round + 1, error);
      raw = await attempt({ error, priorRaw: raw }); // an attempt() failure here propagates (not a parse error)
    }
  }
}
