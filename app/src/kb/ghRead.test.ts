// Read-only gh executor (SPEC-0028 RESEARCH-9/10, Slice 2b). Pure security logic — guards + argv
// building + no-spawn-on-unsafe-input — is network/process-free. The live gh path (BYOA, network) is
// validated in a gh-authed env (DEV-2), not here.
import { describe, it, expect } from 'vitest';
import { isSafeGhRepo, isSafePrNumber, buildGhReadArgs, ghRead } from './ghRead';

describe('isSafeGhRepo — repo/host allowlist guard (RESEARCH-9)', () => {
  it('accepts owner/name slugs', () => {
    expect(isSafeGhRepo('octocat/hello-world')).toBe(true);
    expect(isSafeGhRepo('My-Org/the_repo.js')).toBe(true);
  });
  it('rejects flags, missing/extra slash, spaces, control bytes, leading-dash segments', () => {
    expect(isSafeGhRepo('--repo=evil')).toBe(false);
    expect(isSafeGhRepo('noslash')).toBe(false);
    expect(isSafeGhRepo('a/b/c')).toBe(false);
    expect(isSafeGhRepo('own er/name')).toBe(false);
    expect(isSafeGhRepo('-bad/name')).toBe(false);
    expect(isSafeGhRepo('owner/-bad')).toBe(false);
    expect(isSafeGhRepo('owner/name\n')).toBe(false);
    expect(isSafeGhRepo(42)).toBe(false);
  });
});

describe('isSafePrNumber', () => {
  it('accepts positive ints, rejects everything else', () => {
    expect(isSafePrNumber(42)).toBe(true);
    expect(isSafePrNumber(0)).toBe(false);
    expect(isSafePrNumber(-1)).toBe(false);
    expect(isSafePrNumber(1.5)).toBe(false);
    expect(isSafePrNumber('5')).toBe(false);
  });
});

describe('buildGhReadArgs — structured GET-only ops, repo pinned via --repo', () => {
  it('prList: --repo + validated state/limit + fixed --json fields', () => {
    const args = buildGhReadArgs('octocat/hello-world', { kind: 'prList', state: 'open', limit: 5 });
    expect(args.slice(0, 5)).toEqual(['pr', 'list', '--repo', 'octocat/hello-world', '--state']);
    expect(args).toContain('open');
    expect(args).toContain('5');
    expect(args).toContain('--json');
  });
  it('prList: an out-of-enum state falls back to open; absurd limit is clamped', () => {
    const args = buildGhReadArgs('o/r', { kind: 'prList', state: 'evil' as unknown as 'open', limit: 99999 });
    expect(args[args.indexOf('--state') + 1]).toBe('open');
    expect(args[args.indexOf('--limit') + 1]).toBe('100');
  });
  it('prView / prDiff: PR number positional + --repo', () => {
    expect(buildGhReadArgs('o/r', { kind: 'prView', number: 7 })).toEqual(['pr', 'view', '7', '--repo', 'o/r', '--json', 'number,title,body,author,state,url,updatedAt']);
    expect(buildGhReadArgs('o/r', { kind: 'prDiff', number: 7 })).toEqual(['pr', 'diff', '7', '--repo', 'o/r']);
  });
  it('THROWS on an unsafe repo or PR number rather than emitting it', () => {
    expect(() => buildGhReadArgs('--repo=evil', { kind: 'prList' })).toThrow(/unsafe repo/);
    expect(() => buildGhReadArgs('o/r', { kind: 'prView', number: -1 })).toThrow(/unsafe PR number/);
    expect(() => buildGhReadArgs('o/r', { kind: 'prDiff', number: 0 })).toThrow(/unsafe PR number/);
  });
});

describe('ghRead — refuses to spawn on unsafe input (rejects before any gh call)', () => {
  it('rejects an unsafe repo without spawning gh', async () => {
    await expect(ghRead('not a repo', { kind: 'prList' })).rejects.toThrow(/unsafe repo/);
  });
  it('rejects an unsafe PR number without spawning gh', async () => {
    await expect(ghRead('o/r', { kind: 'prView', number: -5 })).rejects.toThrow(/unsafe PR number/);
  });
});
