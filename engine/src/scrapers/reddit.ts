import { hasCookie, visitJson } from '../browser.js';
import { config } from '../config.js';
import { ScrapeError, type Item, type Scraper } from '../types.js';
import { sleep } from '../util.js';
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

const LOGIN_HELP = 'Stop the engine, run "npm run login", sign in on the Reddit tab, close the window, then start the engine again.';

async function search(q: URLSearchParams) {
  let last = { status: 0, json: null as any, snippet: '' };
  for (const host of ['www.reddit.com', 'old.reddit.com']) {
    last = await visitJson(`https://${host}/search.json?${q}`, /\/login/);
    if (last.json?.data?.children) return last.json;
    if (last.status === 429) break;
  }
  if (last.status === 429) throw new ScrapeError('blocked', 'Reddit is rate-limiting this account.');
  if (!(await hasCookie('https://www.reddit.com', 'reddit_session'))) throw new ScrapeError('login_required', `No Reddit sign-in is saved. ${LOGIN_HELP}`);
  // signed in, yet refused: say exactly what Reddit answered instead of guessing
  throw new ScrapeError('parse', `Reddit answered status ${last.status}: ${last.snippet || 'empty page'}`);
}

export const reddit: Scraper = async (keyword, ctx) => {
  const seen = new Map<string, Item>();
  // freshest window first; every window is sorted by Reddit's own "top"
  for (const t of ['week', 'month', 'year'] as const) {
    let after: string | null = null;
    for (let page = 0; page < 2 && seen.size < config.poolSize; page++) {
      const q = new URLSearchParams({ q: keyword, sort: 'top', t, limit: '100', type: 'link', raw_json: '1' });
      if (after) q.set('after', after);
      const parsed = parseListing(await search(q));
      for (const it of parsed.items) if (!seen.has(it.url)) seen.set(it.url, it);
      after = parsed.after;
      if (!after) break;
      await sleep(1500 + Math.random() * 2000);
    }
    ctx.log(`reddit t=${t} total=${seen.size}`);
    if (seen.size >= config.poolSize) break;
    await sleep(1500 + Math.random() * 2000);
  }
  return [...seen.values()];
};
