// macOS folder-permission helpers (SPEC-0034 MACOS-5/7, #56) — pure classifiers that route the
// "Asking for the keys" UX. The denial classifier is the crux: it decides whether a write failure is
// a TCC-grant denial (→ the Blocked recovery, never a silent stall) vs a generic error.
import { describe, it, expect } from 'vitest';
import { isPermissionDeniedError, isICloudVault, isLocalTccProtected } from './permissions';

describe('isPermissionDeniedError (MACOS-5 denial signal)', () => {
  it('matches the Node errno codes for a direct fs write denial', () => {
    expect(isPermissionDeniedError(Object.assign(new Error('x'), { code: 'EPERM' }))).toBe(true);
    expect(isPermissionDeniedError(Object.assign(new Error('x'), { code: 'EACCES' }))).toBe(true);
  });

  it('matches the message text from a spawned git/copilot subprocess failure (no structured code)', () => {
    // git surfaces the text, not an errno — e.g. `fatal: … : Operation not permitted`
    expect(isPermissionDeniedError(new Error('fatal: could not write to .git/index: Operation not permitted'))).toBe(true);
    expect(isPermissionDeniedError(new Error('EACCES: permission denied, open ...'))).toBe(true);
    expect(isPermissionDeniedError('Operation not permitted')).toBe(true); // raw string
  });

  it('is case-insensitive on the message', () => {
    expect(isPermissionDeniedError(new Error('OPERATION NOT PERMITTED'))).toBe(true);
  });

  it('does NOT match unrelated errors (so only real denials route to Blocked)', () => {
    expect(isPermissionDeniedError(new Error('ENOSPC: no space left on device'))).toBe(false);
    expect(isPermissionDeniedError(Object.assign(new Error('x'), { code: 'ENOENT' }))).toBe(false);
    expect(isPermissionDeniedError(new Error('something else'))).toBe(false);
    expect(isPermissionDeniedError(null)).toBe(false);
    expect(isPermissionDeniedError(undefined)).toBe(false);
  });
});

describe('vault-location classifiers (MACOS-2/7)', () => {
  it('isICloudVault is true only for the iCloud Drive friendly name', () => {
    expect(isICloudVault('iCloud Drive')).toBe(true);
    expect(isICloudVault('Documents')).toBe(false);
    expect(isICloudVault(null)).toBe(false);
  });

  it('isLocalTccProtected is true for local TCC folders, false for iCloud and unprotected', () => {
    // local TCC folders → the pre-prompt grant flow gates on these
    expect(isLocalTccProtected('Documents')).toBe(true);
    expect(isLocalTccProtected('Desktop')).toBe(true);
    expect(isLocalTccProtected('Downloads')).toBe(true);
    // iCloud is detect-warn-only (v1) — NOT a grant flow
    expect(isLocalTccProtected('iCloud Drive')).toBe(false);
    // unprotected location → no grant flow at all
    expect(isLocalTccProtected(null)).toBe(false);
  });
});
