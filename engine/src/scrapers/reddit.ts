import { request, Session } from '../http/client.js';
import { ScrapeError, type Item, type Scraper } from '../types.js';
import { decodeEntities } from '../util.js';

export function parseListing(json: any): { items: Item[]; after: string | null } {
  const items: Item[] = [];
  for (const child of json?.data?.children ?? []) {
    const d = child?.data;
    if (child?.kind !== 't3' || !d?.permalink) continue;
    const preview = d.preview?.images?.[0]?.source?.url;
    const thumb = preview ?? (/^https?:/.test(d.thumbnail ?? '') ? d.thumbnail : undefined);
    items.push({
      url: `https://www.reddit.com${d.permalink}`,
      title: decodeEntities(d.title ?? ''),
      type: d.promoted ? 'ad' : d.is_video || d.post_hint?.includes('video') ? 'video' : d.post_hint === 'image' || d.is_gallery ? 'image' : 'post',
      author: d.author ? `u/${d.author}` : undefined,
      authorUrl: d.author ? `https://www.reddit.com/user/${d.author}` : undefined,
      thumbnail: thumb ? decodeEntities(thumb) : undefined,
      views: typeof d.view_count === 'number' ? d.view_count : null,
      likes: typeof d.score === 'number' ? d.score : null,
      comments: typeof d.num_comments === 'number' ? d.num_comments : null,
      shares: typeof d.num_crossposts === 'number' ? d.num_crossposts : null,
      publishedAt: d.created_utc ? new Date(d.created_utc * 1000).toISOString() : null,
      extra: { subreddit: d.subreddit_name_prefixed ?? null, upvoteRatio: d.upvote_ratio ?? null, nsfw: !!d.over_18 },
    });
  }
  return { items, after: json?.data?.after ?? null };
}

export const reddit: Scraper = async (keyword, ctx) => {
  const session = new Session();
  const seen = new Map<string, Item>();
  let host = 'www.reddit.com';
  for (const t of ['week', 'month', 'year'] as const) {
    let after: string | null = null;
    for (let page = 0; page < 3 && seen.size < ctx.limit; page++) {
      const q = new URLSearchParams({ q: keyword, sort: 'top', t, limit: '100', type: 'link', raw_json: '1', include_over_18: 'off' });
      if (after) q.set('after', after);
      let res;
      try {
        res = await request(`https://${host}/search.json?${q}`, { session, headers: { accept: 'application/json' } });
      } catch (e) {
        if (host === 'www.reddit.com' && e instanceof ScrapeError && e.kind === 'blocked') {
          host = 'old.reddit.com';
          res = await request(`https://${host}/search.json?${q}`, { session, headers: { accept: 'application/json' } });
        } else throw e;
      }
      let json: any;
      try { json = res.json(); } catch { throw new ScrapeError('blocked', 'Reddit returned a non-JSON page (bot check)'); }
      const parsed = parseListing(json);
      for (const it of parsed.items) if (!seen.has(it.url)) seen.set(it.url, it);
      after = parsed.after;
      if (!after) break;
    }
    ctx.log(`reddit t=${t} total=${seen.size}`);
    if (seen.size >= ctx.limit) break;
  }
  return [...seen.values()];
};
