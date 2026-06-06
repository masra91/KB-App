// M365 mail intake connector tests (SPEC-0041 INTAKE-5/6/7/11/12, Slice 2). Pure — the retrieval
// session is injected, so no SDK / tenant / network. Asserts message→item mapping, the bounded cap,
// tenant-allowlist (unconfigured THROWS, not silent), webLink defense-in-depth, the env-gated live
// throw, and read-only-by-construction (the skill forbids any mutation; no write tool is modeled).
import { describe, it, expect, vi } from 'vitest';
import {
  makeM365MailIntakeFn,
  mailTenantOf,
  mailFolderOf,
  M365_MAIL_INTAKE_SKILL,
  SUBMIT_MESSAGES_TOOL,
  type M365MailMessage,
} from './m365MailConnector';
import type { IntakeConnectorConfig } from './intakeConnectors';

const conn = (config: Record<string, unknown> = { tenantId: 't-123' }): IntakeConnectorConfig => ({
  id: 'work-mail', type: 'm365-mail', schedule: 'hourly', enabled: true, scope: 'work', sensitivity: 'confidential', config,
});

const msg = (over: Partial<M365MailMessage> = {}): M365MailMessage => ({
  id: 'AAMkmsg1', subject: 'Q3 plan', from: 'ada@corp.com', receivedDateTime: '2025-06-03T09:00:00Z',
  webLink: 'https://outlook.office365.com/owa/?ItemID=AAMkmsg1', bodyText: 'The plan is...', ...over,
});

describe('makeM365MailIntakeFn (INTAKE-5/6/7/11/12, Slice 2)', () => {
  it('maps Graph messages → intake items (id/subject/from/received/webLink/body)', async () => {
    const session = vi.fn(async () => [msg()]);
    const items = await makeM365MailIntakeFn({ session })(conn(), { maxItems: 25 });
    expect(session).toHaveBeenCalledWith(expect.objectContaining({ tenantId: 't-123', folder: 'Inbox', maxItems: 25 }));
    expect(items[0]).toEqual({
      externalId: 'AAMkmsg1',
      title: 'Q3 plan',
      link: 'https://outlook.office365.com/owa/?ItemID=AAMkmsg1',
      publishedAt: '2025-06-03T09:00:00Z',
      author: 'ada@corp.com',
      contentMd: 'The plan is...',
    });
  });

  it('drops a non-M365 webLink (defense-in-depth) + falls back to "(no subject)"', async () => {
    const session = async () => [msg({ subject: '', webLink: 'https://evil.example.com/x' })];
    const items = await makeM365MailIntakeFn({ session })(conn(), { maxItems: 25 });
    expect(items[0].title).toBe('(no subject)');
    expect(items[0].link).toBeUndefined(); // external link not carried onto the primary source
  });

  it('caps to maxItems (INTAKE-11 bounded pass)', async () => {
    const session = async () => [msg({ id: 'a' }), msg({ id: 'b' }), msg({ id: 'c' })];
    const items = await makeM365MailIntakeFn({ session })(conn(), { maxItems: 2 });
    expect(items.map((i) => i.externalId)).toEqual(['a', 'b']);
  });

  it('THROWS when no tenantId is configured (failed≠empty, INTAKE-12)', async () => {
    const session = async () => [msg()];
    await expect(makeM365MailIntakeFn({ session })(conn({}), { maxItems: 25 })).rejects.toThrow(/tenantId/);
  });

  it('THROWS on the wrong connector type', async () => {
    await expect(makeM365MailIntakeFn({ session: async () => [] })({ ...conn(), type: 'rss' }, { maxItems: 25 })).rejects.toThrow(/wrong type/);
  });

  it('env-gated: no injected session + no MCP factory → live path THROWS (surfaces, not silent)', async () => {
    // Default (no opts.session, no opts.mcpServer) → liveMailSession throws BEFORE loading the SDK.
    await expect(makeM365MailIntakeFn({})(conn(), { maxItems: 25 })).rejects.toThrow(/Graph MCP not configured|env-gated/);
  });

  it('read-only by construction: the skill forbids mutation; the only sink is submitMessages', () => {
    expect(M365_MAIL_INTAKE_SKILL).toMatch(/never send, reply, forward, mark as read/i);
    expect(M365_MAIL_INTAKE_SKILL).toMatch(/READ-ONLY/);
    expect(SUBMIT_MESSAGES_TOOL).toBe('submitMessages');
  });

  it('config accessors: tenant + folder defaults', () => {
    expect(mailTenantOf(conn({ tenantId: ' t9 ' }))).toBe('t9');
    expect(mailTenantOf(conn({}))).toBeUndefined();
    expect(mailFolderOf(conn({ tenantId: 't', folder: 'Newsletters' }))).toBe('Newsletters');
    expect(mailFolderOf(conn())).toBe('Inbox');
  });
});
