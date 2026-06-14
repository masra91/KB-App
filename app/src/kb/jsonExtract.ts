// SPEC-0049 HEAL-2 — lenient JSON extraction. The deciders ask Copilot for "ONLY a JSON object",
// but a strong model still occasionally wraps it: ```json fences, a leading "Here's the result:",
// or a trailing "Let me know if…". The old extractor — `stdout.match(/\{[\s\S]*\}/)` — is greedy
// (first `{` to LAST `}`), so any stray `}` in trailing prose, or two objects, broke the parse and
// the item was blind-retried then tossed (a root cause of the 203 set-aside items).
//
// `extractBalancedJson` instead scans for the FIRST brace-balanced top-level object, tracking string
// + escape state so a `}` inside a JSON string value never miscounts. It tolerates prose/fences on
// BOTH sides. It returns the object substring (still `JSON.parse`d by the caller, which keeps each
// stage's own validation + error messages) or `null` when there is genuinely no object — the caller
// throws its specific "no JSON object" error, which self-repair (HEAL-1) then feeds back to the model.

/** Strip a single leading/trailing markdown code fence (```json … ``` or ``` … ```) if the output is
 *  fence-wrapped. Conservative: only peels a fence that opens at the start of a (trimmed) line, so JSON
 *  string values that happen to contain backticks are untouched. */
function stripCodeFences(raw: string): string {
  const fence = raw.match(/```(?:json|JSON)?\s*\n?([\s\S]*?)\n?```/);
  return fence ? fence[1] : raw;
}

/**
 * Return the first brace-balanced top-level JSON object in `raw` (tolerating leading/trailing prose
 * and code fences), or `null` if there is none. Brace counting ignores braces inside JSON strings
 * (respecting `\` escapes), so `{"note":"a } b"}` extracts whole. Does NOT validate that the object
 * is parseable — the caller `JSON.parse`s the result (so a truncated/malformed object surfaces as a
 * normal JSON SyntaxError, which self-repair can feed back).
 */
export function extractBalancedJson(raw: string): string | null {
  const text = stripCodeFences(raw);
  const start = text.indexOf('{');
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (inString) {
      if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null; // an opening brace but no balanced close (truncated output) — caller throws "no JSON object"
}
