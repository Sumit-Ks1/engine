import { fetch } from 'undici';
import { capture } from '../browser.js';
import { config } from '../config.js';
import { ScrapeError, type Item, type Scraper } from '../types.js';
import { sleep } from '../util.js';
import { decodeEntities, parseCount } from '../util.js';

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

export interface RedditTile { path: string; title: string; nums: (string | null)[]; text: string; ts: string | null; thumb: string | null }

/** Reads the post cards of the search page (runs in the page). */
export const TILES = `[...document.querySelectorAll('a[href*="/comments/"]')].map((a) => {
  const m = (a.getAttribute('href') || '').match(/^(?:https:\\/\\/www\\.reddit\\.com)?(\\/r\\/[^/]+\\/comments\\/[a-z0-9]+\\/[^/?#]*)/);
  if (!m) return null;
  const unit = a.closest('[data-testid="sdui-post-unit"], [data-testid="search-post-unit"], search-telemetry-tracker, shreddit-post, article') || a.parentElement || a;
  const titleEl = unit.querySelector('[data-testid="post-title-text"], [data-testid="post-title"], [id^="search-post-title"]');
  const time = unit.querySelector('faceplate-timeago, time');
  const img = unit.querySelector('img[src*="redd.it"], img[src*="redditmedia"], img[src*="redditstatic"]');
  return {
    path: m[1],
    title: ((titleEl ? titleEl.textContent : '') || a.getAttribute('aria-label') || a.textContent || '').trim(),
    nums: [...unit.querySelectorAll('faceplate-number')].map((n) => n.getAttribute('number')),
    text: (unit.innerText || '').replace(/\\s+/g, ' ').slice(0, 600),
    ts: time ? (time.getAttribute('ts') || time.getAttribute('datetime')) : null,
    thumb: img ? img.src : null,
  };
}).filter(Boolean)`;

/** Turns the cards read off the search page into results. */
export function parseTiles(tiles: RedditTile[]): Item[] {
  const best = new Map<string, RedditTile>();
  for (const t of tiles) {
    const prev = best.get(t.path);
    // the same post is linked several times in a card (title, thumbnail, comments); keep the richest read
    if (!prev || t.title.length > prev.title.length || (t.nums.length > prev.nums.length && t.title.length >= prev.title.length)) best.set(t.path, { ...t, thumb: t.thumb ?? prev?.thumb ?? null, ts: t.ts ?? prev?.ts ?? null });
  }
  const out: Item[] = [];
  for (const t of best.values()) {
    if (!t.title) continue;
    const votes = t.text.match(/([\d.,]+\s?[kKmM]?)\s+(?:votes?|upvotes?|points?)/);
    const comments = t.text.match(/([\d.,]+\s?[kKmM]?)\s+comments?/);
    const date = t.ts ? new Date(t.ts) : null;
    out.push({
      url: `https://www.reddit.com${t.path}`,
      title: t.title.slice(0, 300),
      type: /\bpromoted\b/i.test(t.text.slice(0, 120)) ? 'ad' : 'post',
      author: t.path.split('/').slice(1, 3).join('/'),
      authorUrl: `https://www.reddit.com/${t.path.split('/').slice(1, 3).join('/')}/`,
      thumbnail: t.thumb ?? undefined,
      // the card's number elements hold exact counts (votes, then comments); the visible text is rounded
      likes: t.nums[0] != null ? parseCount(t.nums[0]) : votes ? parseCount(votes[1]) : null,
      comments: t.nums[1] != null ? parseCount(t.nums[1]) : comments ? parseCount(comments[1]) : null,
      publishedAt: date && !Number.isNaN(date.getTime()) ? date.toISOString() : null,
      extra: { subreddit: t.path.split('/').slice(1, 3).join('/') },
    });
  }
  return out;
}

const WINDOWS = ['week', 'month', 'year'] as const;

/** Reddit's official API with a developer token: the access Reddit itself points blocked clients to. */
async function viaApi(keyword: string, want: number, log: (m: string) => void): Promise<Item[]> {
  const ua = 'web:trend-dashboard:1.0';
  const basic = Buffer.from(`${config.reddit.clientId}:${config.reddit.clientSecret}`).toString('base64');
  const tokenRes = await fetch('https://www.reddit.com/api/v1/access_token', {
    method: 'POST', headers: { authorization: `Basic ${basic}`, 'content-type': 'application/x-www-form-urlencoded', 'user-agent': ua },
    body: 'grant_type=client_credentials', signal: AbortSignal.timeout(20_000),
  }).catch((e: Error) => { throw new ScrapeError('network', `Reddit token request failed: ${e.message}`); });
  const token = ((await tokenRes.json().catch(() => ({}))) as { access_token?: string }).access_token;
  if (!token) throw new ScrapeError('parse', `Reddit rejected the developer app credentials (status ${tokenRes.status}). Check REDDIT_CLIENT_ID and REDDIT_CLIENT_SECRET.`);
  const seen = new Map<string, Item>();
  for (const t of WINDOWS) {
    const q = new URLSearchParams({ q: keyword, sort: 'top', t, limit: '100', type: 'link', raw_json: '1' });
    const res = await fetch(`https://oauth.reddit.com/search?${q}`, { headers: { authorization: `Bearer ${token}`, 'user-agent': ua }, signal: AbortSignal.timeout(20_000) });
    if (res.status === 429) throw new ScrapeError('blocked', 'Reddit API rate limit reached.');
    if (!res.ok) throw new ScrapeError('parse', `Reddit API answered status ${res.status}`);
    for (const it of parseListing(await res.json()).items) if (!seen.has(it.url)) seen.set(it.url, it);
    log(`reddit api t=${t} total=${seen.size}`);
    if (seen.size >= want) break;
    await sleep(1200);
  }
  return [...seen.values()];
}

export const reddit: Scraper = async (keyword, ctx) => {
  if (config.reddit.clientId && config.reddit.clientSecret) return viaApi(keyword, config.poolSize, ctx.log);

  // the normal search page, read the way a person sees it; freshest window first
  const tiles: RedditTile[] = [];
  for (const t of WINDOWS) {
    const count = () => parseTiles(tiles).length;
    await capture({
      cancelled: ctx.cancelled,
      url: `https://www.reddit.com/search/?${new URLSearchParams({ q: keyword, type: 'posts', sort: 'top', t })}`,
      referer: 'https://www.reddit.com/',
      match: () => false,
      enough: () => count() >= config.poolSize,
      maxScrolls: 10,
      loginWall: /\/login/,
      thin: () => count() < 5,
      debugName: `reddit-${keyword}`,
      onPage: async (page, phase) => {
        if (phase === 'loaded') {
          const body = ((await page.evaluate('document.body ? document.body.innerText.slice(0, 400) : ""').catch(() => '')) as string);
          if (/blocked by network security/i.test(body)) {
            throw new ScrapeError('blocked', 'Reddit is blocking this browser ("blocked by network security"). Open reddit.com in the sign-in window (npm run login) and check that the account is signed in and can search; or add a Reddit developer app (REDDIT_CLIENT_ID / REDDIT_CLIENT_SECRET in .env).');
          }
        }
        tiles.push(...((await page.evaluate(TILES).catch(() => [])) as RedditTile[]));
      },
    });
    ctx.log(`reddit t=${t} total=${count()}`);
    if (count() >= ctx.limit) break;
    await sleep(2000 + Math.random() * 2500);
  }
  return parseTiles(tiles);
};
