// CLI-version-coupled registry of the Copilot CLI's BUILT-IN tool names — the single source of truth
// for "which of our custom agent tools collide with a built-in and therefore MUST set
// `overridesBuiltInTool: true`". This exists because the CLI grew built-ins over time: CLI 1.0.62 added
// a built-in `grep`, which began rejecting recall's same-named custom tool at session creation
// ("External tool 'grep' conflicts with a built-in tool of the same name. Set overridesBuiltInTool:
// true.") — Ask/Recall went down in the field. The web researcher's `fetch` hit the identical class
// earlier and was already fixed with the override flag (researchWebAgent.ts).
//
// Why a checked-in constant (not a live CLI probe): the SDK only forwards `overridesBuiltInTool` — the
// collision is enforced CLI-side and is version-specific, so a unit test (which mocks the SDK) provably
// cannot catch it ([[feedback-test-real-agent-path]]). This constant lets a build-time guard
// (builtinTools.test.ts) assert every custom tool whose name is a known built-in opts into the override,
// across recall + ALL researchers, without needing the live CLI. The real-CLI catch is the opt-in
// library eval (eval/library.eval.ts), which exercises recall/research over the actual `copilot`.
//
// Bump this set when the prod CLI version changes its built-in surface. Names confirmed for CLI 1.0.62
// from: the live `grep` rejection; the SDK README's override example (`read_file`, `edit_file`); the SDK
// dist tool tokens (`glob`, `bash`, `fetch`, `view`, `str_replace_editor`); the CLI `--allow-tool`
// help (`shell`); and the web researcher's own note that `web_search` is the CLI built-in.

/** The Copilot CLI built-in tool names as of CLI 1.0.62 (see file header for provenance + bump policy). */
export const KNOWN_BUILTIN_TOOL_NAMES: ReadonlySet<string> = new Set([
  'grep',
  'glob',
  'bash',
  'shell',
  'fetch',
  'web_search',
  'view',
  'read_file',
  'write_file',
  'edit_file',
  'str_replace_editor',
]);

/** True if `name` collides with a CLI built-in → a custom tool of this name MUST set `overridesBuiltInTool: true`. */
export function isBuiltInToolName(name: string): boolean {
  return KNOWN_BUILTIN_TOOL_NAMES.has(name);
}
