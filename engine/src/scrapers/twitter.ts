import { capture } from '../browser.js';
import { config } from '../config.js';
import type { Item, Scraper } from '../types.js';
import { walk } from '../util.js';

/** Reads posts out of the search payloads the X web app loaded. */
export function parseTimeline(payloads: unknown): Item[] {
  const promoted = new Set<string>();
  walk(payloads, (o) => {
    if (o.promotedMetadata && o.tweet_results?.result) {
      const r = o.tweet_results.result;
      promoted.add(r.rest_id ?? r.tweet?.rest_id);
    }
  });
  const items = new Map<string, Item>();
  walk(payloads, (o) => {
    const l = o.legacy;
    if (typeof o.rest_id !== 'string' || !l || typeof l.full_text !== 'string') return;
    if (l.retweeted_status_result) return; // the original post is walked on its own
    const user = o.core?.user_results?.result;
    const handle = user?.core?.screen_name ?? user?.legacy?.screen_name;
    if (!handle) return;
    const media = l.extended_entities?.media?.[0] ?? l.entities?.media?.[0];
    const views = Number(o.views?.count);
    const body = o.note_tweet?.note_tweet_results?.result?.text ?? l.full_text;
    const url = `https://x.com/${handle}/status/${o.rest_id}`;
    if (items.has(url)) return;
    items.set(url, {
      url,
      title: String(body).replace(/https:\/\/t\.co\/\w+/g, '').replace(/\s+/g, ' ').trim().slice(0, 300) || 'Post',
      type: promoted.has(o.rest_id) ? 'ad' : media?.type === 'video' || media?.type === 'animated_gif' ? 'video' : media ? 'image' : 'post',
      author: `@${handle}`,
      authorUrl: `https://x.com/${handle}`,
      thumbnail: media?.media_url_https,
      views: Number.isFinite(views) ? views : null,
      likes: typeof l.favorite_count === 'number' ? l.favorite_count : null,
      comments: typeof l.reply_count === 'number' ? l.reply_count : null,
      shares: (l.retweet_count ?? 0) + (l.quote_count ?? 0),
      publishedAt: l.created_at ? new Date(l.created_at).toISOString() : null,
      extra: { reposts: l.retweet_count ?? null, quotes: l.quote_count ?? null, bookmarks: l.bookmark_count ?? null },
    });
  });
  return [...items.values()];
}

export const twitter: Scraper = async (keyword, ctx) => {
  const payloads = await capture({
    // "Top" tab: X's own ranking of the most engaged posts for the query
    url: `https://x.com/search?${new URLSearchParams({ q: keyword, src: 'typed_query', f: 'top' })}`,
    match: (u) => u.includes('/SearchTimeline'),
    enough: (p) => parseTimeline(p).length >= config.poolSize,
    maxScrolls: 20,
    loginWall: /\/i\/flow\/login|\/login(\?|$)|x\.com\/?(\?|$)/,
    challenge: /\/account\/access|\/i\/flow\/(?!login)/,
  });
  const items = parseTimeline(payloads);
  ctx.log(`twitter total=${items.length}`);
  return items;
};
