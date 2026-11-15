import { config } from '../config.js';
import { request, Session } from '../http/client.js';
import type { Item, Scraper } from '../types.js';
import { decodeEntities, stripTags } from '../util.js';

const tag = (xml: string, name: string) => {
  const m = xml.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`));
  return m ? decodeEntities(m[1].replace(/^<!\[CDATA\[|\]\]>$/g, '').trim()) : '';
};

export function parseNewsRss(xml: string): Item[] {
  const items: Item[] = [];
  for (const m of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    const block = m[1];
    const url = tag(block, 'link');
    if (!/^https?:\/\//.test(url)) continue;
    const source = tag(block, 'source');
    const sourceUrl = block.match(/<source[^>]*url="([^"]+)"/)?.[1];
    let title = tag(block, 'title');
    if (source && title.endsWith(` - ${source}`)) title = title.slice(0, -source.length - 3);
    const date = new Date(tag(block, 'pubDate'));
    // the description lists every outlet covering the same story: a proxy for how big it is
    const coverage = (tag(block, 'description').match(/<li>/g) ?? []).length || 1;
    items.push({
      url,
      title: stripTags(title),
      type: 'article',
      author: source || undefined,
      authorUrl: sourceUrl ? decodeEntities(sourceUrl) : undefined,
      publishedAt: Number.isNaN(date.getTime()) ? null : date.toISOString(),
      extra: { coverage, signal: coverage > 1 ? `${coverage} outlets` : '1 outlet' },
    });
  }
  return items;
}

/** Google Trends answers start with an anti-JSON-hijacking prefix. */
const trendsJson = (body: string) => JSON.parse(body.slice(body.indexOf('{')));

/** Related searches from Google Trends: "rising" (fastest growing) then "top" (most searched). */
export function parseRelated(json: any): Item[] {
  const lists: any[] = json?.default?.rankedList ?? [];
  const out: Item[] = [];
  // Trends returns [top, rising]; rising is the trending signal, so it goes first
  for (const [kind, list] of [['rising', lists[1]], ['top', lists[0]]] as const) {
    for (const k of list?.rankedKeyword ?? []) {
      if (!k?.query) continue;
      out.push({
        url: `https://www.google.com/search?q=${encodeURIComponent(k.query)}`,
        title: k.query,
        type: 'search',
        author: kind === 'rising' ? 'Rising search' : 'Top search',
        authorUrl: k.link ? `https://trends.google.com${k.link}` : undefined,
        extra: {
          kind,
          signal: kind === 'rising' ? (k.formattedValue === 'Breakout' ? 'Breakout (+5000%)' : `${k.formattedValue} growth`) : `${k.value}/100 interest`,
          value: typeof k.value === 'number' ? k.value : null,
        },
      });
    }
  }
  return out;
}

async function trends(keyword: string, log: (m: string) => void): Promise<Item[]> {
  const base = 'https://trends.google.com';
  const session = new Session();
  const hl = `${config.lang}-${config.region}`;
  // the landing page hands out the cookie the data endpoints insist on
  await request(`${base}/trends/explore?${new URLSearchParams({ q: keyword, geo: config.region, hl })}`, { session, retries: 1, passStatuses: [429] });
  const req = { comparisonItem: [{ keyword, geo: config.region, time: 'today 1-m' }], category: 0, property: '' };
  const explore = trendsJson((await request(`${base}/trends/api/explore?${new URLSearchParams({ hl, tz: '-330', req: JSON.stringify(req) })}`, {
    session, retries: 2, headers: { accept: 'application/json, text/plain, */*', referer: `${base}/trends/explore` },
  })).body);
  const widget = (explore.widgets ?? []).find((w: any) => w.id === 'RELATED_QUERIES');
  if (!widget) return [];
  const related = trendsJson((await request(`${base}/trends/api/widgetdata/relatedsearches?${new URLSearchParams({ hl, tz: '-330', req: JSON.stringify(widget.request), token: widget.token })}`, {
    session, retries: 2, headers: { accept: 'application/json, text/plain, */*', referer: `${base}/trends/explore` },
  })).body);
  const items = parseRelated(related);
  log(`google trends related=${items.length}`);
  return items;
}

async function stories(keyword: string, log: (m: string) => void): Promise<Item[]> {
  const seen = new Map<string, Item>();
  for (const when of ['7d', '30d', '']) {
    const q = new URLSearchParams({
      q: when ? `${keyword} when:${when}` : keyword,
      hl: `${config.lang}-${config.region}`,
      gl: config.region,
      ceid: `${config.region}:${config.lang}`,
    });
    const res = await request(`https://news.google.com/rss/search?${q}`, { headers: { accept: 'application/rss+xml,application/xml;q=0.9,*/*;q=0.8' } });
    for (const it of parseNewsRss(res.body)) {
      const key = it.title.toLowerCase();
      if (!seen.has(key)) seen.set(key, it);
    }
    log(`google stories when=${when || 'any'} total=${seen.size}`);
    if (seen.size >= 100) break;
  }
  // biggest stories (covered by the most outlets) first, newest breaking ties
  return [...seen.values()].sort((a, b) => Number(b.extra?.coverage ?? 0) - Number(a.extra?.coverage ?? 0)
    || String(b.publishedAt).localeCompare(String(a.publishedAt)));
}

/**
 * Google has no likes or views. Its trending signals are what people search (Google Trends:
 * rising and top related searches) and what is being covered (top stories by outlet count).
 */
export const google: Scraper = async (keyword, ctx) => {
  const [t, s] = await Promise.allSettled([trends(keyword, ctx.log), stories(keyword, ctx.log)]);
  if (t.status === 'rejected') ctx.log(`google trends unavailable: ${(t.reason as Error).message}`);
  if (s.status === 'rejected' && (t.status === 'rejected' || !t.value.length)) throw s.reason;
  const related = t.status === 'fulfilled' ? t.value : [];
  const news = s.status === 'fulfilled' ? s.value : [];
  return [...related, ...news.slice(0, Math.max(0, ctx.limit - related.length))];
};
