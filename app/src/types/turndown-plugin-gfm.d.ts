// Minimal type shim for `turndown-plugin-gfm` (no @types published). The package exports
// turndown plugins (gfm = tables + strikethrough + task lists) used by richText.ts.
declare module 'turndown-plugin-gfm' {
  import type TurndownService from 'turndown';
  export const gfm: TurndownService.Plugin;
  export const tables: TurndownService.Plugin;
  export const strikethrough: TurndownService.Plugin;
  export const taskListItems: TurndownService.Plugin;
}
