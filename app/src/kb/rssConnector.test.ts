// RSS/Atom connector tests (SPEC-0041 INTAKE-5/11). Pure parse + injected-HTTP fetch — no network,
// no git. Asserts the parser normalizes RSS 2.0 + Atom (CDATA, entities, guid/id/link, missing
// fields), the bounded cap (INTAKE-11), and that a non-2xx response THROWS (failed≠empty, INTAKE-12).
import { describe, it, expect, vi } from 'vitest';
import { parseFeed, makeRssIntakeFn, type RssHttpGet } from './rssConnector';
import type { IntakeConnectorConfig } from './intakeConnectors';

const RSS = `<?xml version="1.0"?>
<rss version="2.0"><channel>
  <title>Feed</title>
  <item>
    <title><![CDATA[First & Best]]></title>
    <link>https://example.com/a</link>
    <guid isPermaLink="false">guid-a</guid>
    <pubDate>Tue, 03 Jun 2025 09:00:00 GMT</pubDate>
    <description>Body with &lt;b&gt;markup&lt;/b&gt; &amp; an ampersand.</description>
  </item>
  <item>
    <title>Second</title>
    <link>https://example.com/b</link>
    <description>Plain body.</description>
  </item>
</channel></rss>`;

const ATOM = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Atom Feed</title>
  <entry>
    <title>Atom One</title>
    <link rel="alternate" href="https://example.com/atom1"/>
    <id>urn:uuid:atom-1</id>
    <updated>2025-06-03T10:00:00Z</updated>
    <author><name>Ada</name></author>
    <content type="html">Atom body</content>
  </entry>
</feed>`;

const conn = (config: Record<string, unknown>): IntakeConnectorConfig => ({
  id: 'feed', type: 'rss', schedule: 'hourly', enabled: true, scope: 'global', sensitivity: 'internal', config,
});

describe('parseFeed (INTAKE-5)', () => {
  it('parses RSS 2.0 items — title/link/guid/pubDate/description, CDATA + entities decoded', () => {
    const items = parseFeed(RSS);
    expect(items).toHaveLength(2);
    expect(items[0].title).toBe('First & Best'); // CDATA unwrapped
    expect(items[0].externalId).toBe('guid-a'); // <guid> is the dedup identity
    expect(items[0].link).toBe('https://example.com/a');
    expect(items[0].publishedAt).toBe('2025-06-03T09:00:00.000Z'); // normalized to ISO
    expect(items[0].contentMd).toContain('<b>markup</b>'); // entities decoded
    expect(items[0].contentMd).toContain('& an ampersand');
  });

  it('falls back to the link as external id when <guid> is absent', () => {
    const items = parseFeed(RSS);
    expect(items[1].externalId).toBe('https://example.com/b'); // no guid → link is the stable id
  });

  it('parses Atom entries — id/alternate-link/updated/author/content', () => {
    const items = parseFeed(ATOM);
    expect(items).toHaveLength(1);
    expect(items[0].title).toBe('Atom One');
    expect(items[0].externalId).toBe('urn:uuid:atom-1');
    expect(items[0].link).toBe('https://example.com/atom1');
    expect(items[0].author).toBe('Ada');
    expect(items[0].publishedAt).toBe('2025-06-03T10:00:00.000Z');
    expect(items[0].contentMd).toBe('Atom body');
  });

  it('returns [] for a feed with no items/entries', () => {
    expect(parseFeed('<rss><channel><title>empty</title></channel></rss>')).toEqual([]);
  });
});

describe('makeRssIntakeFn (INTAKE-5/11/12)', () => {
  it('fetches + parses via the injected HTTP get', async () => {
    const http: RssHttpGet = vi.fn(async () => ({ status: 200, text: RSS }));
    const fn = makeRssIntakeFn({ http });
    const items = await fn(conn({ feedUrl: 'https://example.com/feed.xml' }), { maxItems: 25 });
    expect(http).toHaveBeenCalledWith('https://example.com/feed.xml');
    expect(items.map((i) => i.externalId)).toEqual(['guid-a', 'https://example.com/b']);
  });

  it('caps the result to maxItems (INTAKE-11 bounded pass)', async () => {
    const http: RssHttpGet = async () => ({ status: 200, text: RSS });
    const items = await makeRssIntakeFn({ http })(conn({ feedUrl: 'https://x/f' }), { maxItems: 1 });
    expect(items).toHaveLength(1);
  });

  it('THROWS on a non-2xx response (failed≠empty, INTAKE-12)', async () => {
    const http: RssHttpGet = async () => ({ status: 503, text: '' });
    await expect(makeRssIntakeFn({ http })(conn({ feedUrl: 'https://x/f' }), { maxItems: 25 })).rejects.toThrow(/HTTP 503/);
  });

  it('THROWS when config.feedUrl is missing', async () => {
    await expect(makeRssIntakeFn({ http: async () => ({ status: 200, text: RSS }) })(conn({}), { maxItems: 25 })).rejects.toThrow(/feedUrl/);
  });
});
