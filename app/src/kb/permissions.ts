// macOS folder-permission helpers (SPEC-0034 MACOS-5/7, #56) — pure, shell-agnostic (no electron
// import) so they're trivially testable and shared by main + renderer. The TCC grant is the macOS
// system permission that lets the app (and its spawned git/copilot) read+write a protected vault
// folder; until it's granted, protected-folder writes fail with `Operation not permitted`. These
// classify the situations the "Asking for the keys" UX (specs/design/macos-permission.md) routes on.

/**
 * True iff the vault sits in **iCloud Drive** (`tccProtectedDir` is the friendly name from
 * {@link detectTccProtectedDir}). iCloud is **detect-warn-only** in v1 (MACOS-2, KB-Lead-locked) — its
 * sync/eviction edges are surfaced as a quiet, non-blocking note, NOT a blocking grant flow.
 */
export function isICloudVault(tccProtectedDir: string | null): boolean {
  return tccProtectedDir === 'iCloud Drive';
}

/**
 * True iff the vault is in a **local TCC-gated folder** (Documents / Desktop / Downloads) — the case
 * where the app's first protected write triggers the macOS **TCC grant dialog**, so the first-run
 * pre-prompt gates on this (MACOS-7). iCloud is excluded (detect-warn-only — see {@link isICloudVault});
 * a `null` (unprotected) location needs no grant flow at all.
 */
export function isLocalTccProtected(tccProtectedDir: string | null): boolean {
  return tccProtectedDir !== null && !isICloudVault(tccProtectedDir);
}

/**
 * Recognize a macOS **folder-permission denial** from a thrown fs/git error — the `Operation not
 * permitted` / `EPERM` / `EACCES` signature a protected-folder write fails with when the app lacks the
 * TCC grant (MACOS-5). This is the signal that routes ANY write-time denial to the **Blocked** recovery
 * surface — loudly, never a silent stall (#56). Matches BOTH the Node `errno` code (direct `fs` writes)
 * AND the message text, because spawned `git`/`copilot` subprocess failures surface the text
 * (`fatal: … : Operation not permitted`), not a structured `code`.
 */
export function isPermissionDeniedError(err: unknown): boolean {
  if (err == null) return false;
  const code = (err as { code?: unknown }).code;
  if (code === 'EPERM' || code === 'EACCES') return true;
  const msg = err instanceof Error ? err.message : typeof err === 'string' ? err : String((err as { message?: unknown }).message ?? '');
  return /operation not permitted|\bEPERM\b|\bEACCES\b|permission denied/i.test(msg);
}
