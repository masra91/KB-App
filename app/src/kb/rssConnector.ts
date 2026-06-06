// The RSS/Atom intake connector (SPEC-0041 INTAKE-5, Slice 1) — the first concrete `IntakeFetchFn`.
// Fetches a feed over the SSRF-safe gated fetch (RESEARCH-8's `makeGatedFetch`, reused), parses RSS
// 2.0 / Atom into normalized `IntakeItem`s, bounded to `maxItems`. READ-ONLY (INTAKE-7): it only GETs
// the feed URL — no remote mutation. The parse is a small, dependency-free reader (ENG-5: prefer no
// dep; feeds are simple, predictable XML) — robust to CDATA + entity-escaping, tolerant of missing
// fields. The HTTP fetch is injectable so the parser is unit-tested without a network.
import { makeGatedFetch, type Resolver } from './researchFetch';
import type { IntakeConnectorConfig, IntakeFetchFn, IntakeItem } from './intakeConnectors';

/** A minimal HTTP GET returning the body text — the gated fetch's shape, injectable for tests. */
export type RssHttpGet = (url: string) => Promise<{ status: number; text: string }>;

export interface RssIntakeOptions {
  /** Injected HTTP GET (tests). Production builds an SSRF-safe gated fetch per the connector's
   *  `allowedDomains` (default: any public host — a public feed). */
  http?: RssHttpGet;
  /** Injected DNS resolver, forwarded to the gated fetch (tests). */
  resolver?: Resolver;
}

/** Decode the handful of XML entities that appear in feed text (after CDATA is unwrapped). */
function decodeEntities(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0*39;|&apos;/g, "'")
    .replace(/&#0*38;|&amp;/g, '&'); // amp last so it doesn't double-decode the others
}

/** Unwrap `<![CDATA[…]]>` and trim; decode entities in the remaining text. */
function cleanText(raw: string | undefined): string {
  if (!raw) return '';
  const cdata = raw.match(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/);
  const inner = cdata ? cdata[1] : raw;
  return decodeEntities(inner).trim();
}

/** First captured group of the first tag match (namespace-tolerant: `tag` matches `ns:tag` too). */
function tagText(block: string, tag: string): string | undefined {
  const re = new RegExp(`<(?:[\\w-]+:)?${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:[\\w-]+:)?${tag}>`, 'i');
  const m = block.match(re);
  return m ? m[1] : undefined;
}

/** Atom `<link href="…"/>` — prefer rel="alternate"/no-rel; fall back to the first href. */
function atomLink(block: string): string | undefined {
  const links = [...block.matchAll(/<(?:[\w-]+:)?link\b([^>]*)\/?>/gi)];
  if (links.length === 0) return undefined;
  const hrefOf = (attrs: string): string | undefined => attrs.match(/\bhref\s*=\s*["']([^"']+)["']/i)?.[1];
  const alt = links.find((l) => /\brel\s*=\s*["']alternate["']/i.test(l[1])) ?? links.find((l) => !/\brel\s*=/i.test(l[1]));
  return hrefOf((alt ?? links[0])[1]);
}

/** Parse a feed document into normalized items (RSS 2.0 `<item>` or Atom `<entry>`). */
export function parseFeed(xml: string): IntakeItem[] {
  const isAtom = /<entry[\s>]/i.test(xml) && !/<item[\s>]/i.test(xml);
  const blockTag = isAtom ? 'entry' : 'item';
  const blocks = [...xml.matchAll(new RegExp(`<${blockTag}(?:\\s[^>]*)?>([\\s\\S]*?)</${blockTag}>`, 'gi'))].map((m) => m[1]);

  const items: IntakeItem[] = [];
  for (const block of blocks) {
    const title = cleanText(tagText(block, 'title'));
    const link = isAtom ? atomLink(block) : cleanText(tagText(block, 'link')) || undefined;
    // Dedup identity: RSS <guid> / Atom <id>, else the link (a stable permalink), else '' → the
    // run's content-hash fallback (INTAKE-8) keys it.
    const externalId = cleanText(tagText(block, 'guid')) || cleanText(tagText(block, 'id')) || link || '';
    const publishedRaw = cleanText(tagText(block, 'pubDate')) || cleanText(tagText(block, 'published')) || cleanText(tagText(block, 'updated'));
    const publishedAt = publishedRaw ? new Date(publishedRaw).toISOString().replace('Invalid Date', '') : undefined;
    const author = cleanText(tagText(block, 'creator')) || cleanText(tagText(tagText(block, 'author') ?? '', 'name')) || undefined;
    // Body: RSS content:encoded > description; Atom content > summary.
    const body = cleanText(tagText(block, 'encoded')) || cleanText(tagText(block, 'content')) || cleanText(tagText(block, 'description')) || cleanText(tagText(block, 'summary'));

    if (!title && !body && !externalId) continue; // not a real entry — skip
    items.push({
      externalId,
      title: title || '(untitled)',
      ...(link ? { link } : {}),
      ...(publishedAt && publishedAt !== '' ? { publishedAt } : {}),
      ...(author ? { author } : {}),
      contentMd: body,
    });
  }
  return items;
}

/** The connector's feed URL from its typed config (`{ feedUrl: string }`). */
function feedUrlOf(c: IntakeConnectorConfig): string {
  const url = (c.config?.feedUrl ?? c.config?.url) as unknown;
  if (typeof url !== 'string' || url.trim().length === 0) throw new Error(`rss connector ${c.id}: missing config.feedUrl`);
  return url.trim();
}

/** The connector's per-feed domain allowlist (`config.allowedDomains`), or `[]` = any public host. */
function allowedDomainsOf(c: IntakeConnectorConfig): readonly string[] {
  const a = c.config?.allowedDomains;
  return Array.isArray(a) ? a.filter((x): x is string => typeof x === 'string') : [];
}

/**
 * Build the RSS `IntakeFetchFn` (INTAKE-5). Production uses the SSRF-safe gated fetch scoped to the
 * connector's `allowedDomains`; tests inject `opts.http`. Throws on a non-2xx response or a fetch
 * error so `runIntakeConnector` records a DISTINCT `intake-failed` (never a silent empty, INTAKE-12).
 */
export function makeRssIntakeFn(opts: RssIntakeOptions = {}): IntakeFetchFn {
  return async (c, ctx) => {
    const url = feedUrlOf(c);
    const get: RssHttpGet =
      opts.http ??
      (async (u) => {
        const gated = makeGatedFetch({ allowedDomains: allowedDomainsOf(c), resolver: opts.resolver, maxBytes: 1024 * 1024 });
        const res = await gated(u);
        return { status: res.status, text: res.text };
      });
    const res = await get(url);
    if (res.status < 200 || res.status >= 300) throw new Error(`rss fetch ${url} → HTTP ${res.status}`);
    const items = parseFeed(res.text);
    // Feeds list newest-first; cap to the bounded pass size (INTAKE-11).
    return items.slice(0, ctx.maxItems);
  };
}
