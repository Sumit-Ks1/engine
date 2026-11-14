import { config } from '../config.js';
import { request } from '../http/client.js';
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
    const coverage = (tag(block, 'description').match(/<li>/g) ?? []).length;
    items.push({
      url,
      title: stripTags(title),
      type: 'article',
      author: source || undefined,
      authorUrl: sourceUrl ? decodeEntities(sourceUrl) : undefined,
      publishedAt: Number.isNaN(date.getTime()) ? null : date.toISOString(),
      extra: { coverage: coverage || 1 },
    });
  }
  return items;
}

/**
 * Google exposes no engagement numbers. Results are the stories Google itself ranks
 * highest for the keyword, freshest window first, in Google's own order.
 */
export const google: Scraper = async (keyword, ctx) => {
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
    ctx.log(`google when=${when || 'any'} total=${seen.size}`);
    if (seen.size >= ctx.limit) break;
  }
  return [...seen.values()];
};
