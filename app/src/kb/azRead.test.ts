// Read-only az (Azure DevOps) executor (SPEC-0028 RESEARCH-9/10, Slice 2b). Pure security logic —
// org-host allowlist + name/id guards + argv building + no-spawn-on-unsafe-input — is network/process
// free. The live az path (BYOA, network) is validated in an az-authed env (DEV-2), not here.
import { describe, it, expect } from 'vitest';
import { isAzdoOrgUrl, isSafeAzName, isSafeAzTarget, isSafeAzPrId, buildAzReadArgs, azRead, type AzdoTarget } from './azRead';

const target: AzdoTarget = { org: 'https://dev.azure.com/contoso', project: 'MyProject', repository: 'my-repo' };

describe('isAzdoOrgUrl — org-host allowlist (RESEARCH-9 remote scoping)', () => {
  it('accepts https dev.azure.com + *.visualstudio.com', () => {
    expect(isAzdoOrgUrl('https://dev.azure.com/contoso')).toBe(true);
    expect(isAzdoOrgUrl('https://contoso.visualstudio.com')).toBe(true);
  });
  it('rejects non-https, non-allowlisted hosts, control bytes, garbage', () => {
    expect(isAzdoOrgUrl('http://dev.azure.com/contoso')).toBe(false); // not https
    expect(isAzdoOrgUrl('https://evil.com/contoso')).toBe(false); // host not allowlisted
    expect(isAzdoOrgUrl('https://dev.azure.com.evil.com/x')).toBe(false); // suffix-spoof
    expect(isAzdoOrgUrl('ssh://dev.azure.com/x')).toBe(false);
    expect(isAzdoOrgUrl('https://dev.azure.com/\n')).toBe(false);
    expect(isAzdoOrgUrl('not a url')).toBe(false);
    expect(isAzdoOrgUrl(42)).toBe(false);
  });
});

describe('isSafeAzName / isSafeAzPrId', () => {
  it('name allows spaces/punctuation (Azure names) but never a flag or control bytes', () => {
    expect(isSafeAzName('My Project')).toBe(true); // spaces ok (single execFile argv)
    expect(isSafeAzName('repo.v2')).toBe(true);
    expect(isSafeAzName('-flagish')).toBe(false);
    expect(isSafeAzName('a\nb')).toBe(false);
    expect(isSafeAzName('')).toBe(false);
  });
  it('PR id is a positive int', () => {
    expect(isSafeAzPrId(42)).toBe(true);
    expect(isSafeAzPrId(0)).toBe(false);
    expect(isSafeAzPrId(-1)).toBe(false);
    expect(isSafeAzPrId('5')).toBe(false);
  });
  it('isSafeAzTarget requires all three parts valid', () => {
    expect(isSafeAzTarget(target)).toBe(true);
    expect(isSafeAzTarget({ ...target, org: 'https://evil.com/x' })).toBe(false);
    expect(isSafeAzTarget({ ...target, project: '-bad' })).toBe(false);
    expect(isSafeAzTarget({})).toBe(false);
  });
});

describe('buildAzReadArgs — structured GET-only ops, target pinned', () => {
  it('prList: org/project/repository pinned + validated status/top + --output json', () => {
    const args = buildAzReadArgs(target, { kind: 'prList', status: 'active', top: 5 });
    expect(args.slice(0, 3)).toEqual(['repos', 'pr', 'list']);
    expect(args).toContain('--organization');
    expect(args[args.indexOf('--organization') + 1]).toBe('https://dev.azure.com/contoso');
    expect(args[args.indexOf('--project') + 1]).toBe('MyProject');
    expect(args[args.indexOf('--repository') + 1]).toBe('my-repo');
    expect(args[args.indexOf('--status') + 1]).toBe('active');
    expect(args).toContain('--output');
    expect(args[args.indexOf('--output') + 1]).toBe('json');
  });
  it('prList: out-of-enum status → active; absurd top clamped', () => {
    const args = buildAzReadArgs(target, { kind: 'prList', status: 'evil' as unknown as 'active', top: 99999 });
    expect(args[args.indexOf('--status') + 1]).toBe('active');
    expect(args[args.indexOf('--top') + 1]).toBe('100');
  });
  it('prShow: --id positional value + org', () => {
    const args = buildAzReadArgs(target, { kind: 'prShow', id: 7 });
    expect(args.slice(0, 3)).toEqual(['repos', 'pr', 'show']);
    expect(args[args.indexOf('--id') + 1]).toBe('7');
  });
  it('THROWS on an unsafe target or PR id rather than emitting it', () => {
    expect(() => buildAzReadArgs({ ...target, org: 'https://evil.com/x' }, { kind: 'prList' })).toThrow(/unsafe Azure DevOps target/);
    expect(() => buildAzReadArgs({ ...target, project: '--inject' }, { kind: 'prList' })).toThrow(/unsafe Azure DevOps target/);
    expect(() => buildAzReadArgs(target, { kind: 'prShow', id: -1 })).toThrow(/unsafe PR id/);
  });
});

describe('azRead — refuses to spawn on unsafe input (rejects before any az call)', () => {
  it('rejects an unsafe target without spawning az', async () => {
    await expect(azRead({ ...target, org: 'http://dev.azure.com/x' }, { kind: 'prList' })).rejects.toThrow(/unsafe Azure DevOps target/);
  });
  it('rejects an unsafe PR id without spawning az', async () => {
    await expect(azRead(target, { kind: 'prShow', id: 0 })).rejects.toThrow(/unsafe PR id/);
  });
});
