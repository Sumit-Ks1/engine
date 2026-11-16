import { capture } from '../browser.js';
import { config } from '../config.js';
import type { Item, Scraper } from '../types.js';
import { sleep, toTag, walk } from '../util.js';

const ORIGIN = 'https://www.instagram.com';

/** Reads every media object out of whatever payloads the Instagram web app loaded. */
export function parseMedia(payloads: unknown): Item[] {
  const items = new Map<string, Item>();
  walk(payloads, (o) => {
    if (typeof o.code !== 'string' || !/^[A-Za-z0-9_-]{5,}$/.test(o.code)) return;
    if (!('like_count' in o || 'comment_count' in o || 'media_type' in o || 'image_versions2' in o)) return;
    const isReel = o.product_type === 'clips';
    const url = `${ORIGIN}/${isReel ? 'reel' : 'p'}/${o.code}/`;
    const views = o.play_count ?? o.ig_play_count ?? o.fb_play_count ?? o.view_count ?? o.video_view_count ?? null;
    const prev = items.get(url);
    const item: Item = {
      url,
      title: String(o.caption?.text ?? prev?.title ?? '').replace(/\s+/g, ' ').trim().slice(0, 300) || 'Instagram post',
      type: o.is_paid_partnership || o.ad_id ? 'ad' : isReel || o.media_type === 2 ? 'video' : 'image',
      author: o.user?.username ? `@${o.user.username}` : o.owner?.username ? `@${o.owner.username}` : prev?.author,
      thumbnail: o.image_versions2?.candidates?.[0]?.url ?? o.carousel_media?.[0]?.image_versions2?.candidates?.[0]?.url ?? o.thumbnail_url ?? o.display_uri ?? prev?.thumbnail,
      views: typeof views === 'number' ? views : prev?.views ?? null,
      likes: typeof o.like_count === 'number' && o.like_count >= 0 ? o.like_count : prev?.likes ?? null,
      comments: typeof o.comment_count === 'number' ? o.comment_count : prev?.comments ?? null,
      shares: typeof o.reshare_count === 'number' ? o.reshare_count : prev?.shares ?? null,
      publishedAt: typeof o.taken_at === 'number' ? new Date(o.taken_at * 1000).toISOString() : prev?.publishedAt ?? null,
    };
    if (item.author) item.authorUrl = `${ORIGIN}/${item.author.slice(1)}/`;
    items.set(url, item);
    return false;
  });
  return [...items.values()];
}

/** True when a post actually uses the keyword: in its caption (as hashtag or text) or its account name. */
export function mentions(item: Item, keyword: string): boolean {
  const tag = toTag(keyword);
  const hay = `${item.title} ${item.author ?? ''}`.toLowerCase();
  return (!!tag && hay.replace(/[\s._-]/g, '').includes(tag)) || hay.includes(keyword.toLowerCase());
}

/** Instagram's numeric media id for a post shortcode (the id is the shortcode read as base 64). */
export function shortcodeToId(code: string): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  let n = 0n;
  for (const ch of code.slice(0, 11)) n = n * 64n + BigInt(alphabet.indexOf(ch));
  return n.toString();
}

interface Tile { kind: string; code: string; thumb: string | null; alt: string }
/** Reads the tiles of the results grid straight off the page (runs in the page). */
export const GRID = `[...document.querySelectorAll('a[href]')].map((a) => {
  const m = (a.getAttribute('href') || '').match(/^\\/(?:[A-Za-z0-9._]+\\/)?(p|reel|reels)\\/([A-Za-z0-9_-]{5,})/);
  if (!m) return null;
  const img = a.querySelector('img');
  return { kind: m[1], code: m[2], thumb: img ? img.src : null, alt: img ? img.alt : '' };
}).filter(Boolean)`;
/** Asks Instagram for one post's details from inside the signed-in page, the way the site itself does. */
export const INFO = (id: string) => `fetch('/api/v1/media/${id}/info/', { credentials: 'include', headers: { 'x-ig-app-id': '936619743392459', 'x-requested-with': 'XMLHttpRequest' } })
  .then((r) => (r.ok ? r.json() : { __status: r.status })).catch(() => ({ __status: 0 }))`;

const codeOf = (url: string) => url.split('/').filter(Boolean).pop()!;
const hasNumbers = (it?: Item) => !!it && (it.views != null || it.likes != null);

export const instagram: Scraper = async (keyword, ctx) => {
  const tag = toTag(keyword);
  // the plain keyword search is what the Instagram app shows; the hashtag search tops it up
  const pages = [...new Set([keyword, tag ? `#${tag}` : ''].filter(Boolean))].map((q) => `${ORIGIN}/explore/search/keyword/?q=${encodeURIComponent(q)}`);
  const tiles = new Map<string, Tile>();     // posts shown in the results grid, in Instagram's order
  const details = new Map<string, Item>();   // everything the page loaded, by shortcode

  for (const url of pages) {
    const before = tiles.size;
    const { payloads, finalUrl } = await capture({
      cancelled: ctx.cancelled,
      url,
      match: (u) => u.startsWith(ORIGIN) && /\/(api\/v1|graphql)\//.test(u),
      enough: () => tiles.size >= config.poolSize,
      maxScrolls: 18,
      embedded: true,
      loginWall: /\/accounts\/(login|signup|emailsignup)/,
      challenge: /\/challenge\/|\/accounts\/suspended/,
      thin: () => tiles.size - before < 10,
      debugName: `instagram-${keyword}`,
      onPage: async (page, phase) => {
        // only tiles of the search page count; if Instagram bounced us elsewhere, take nothing
        if (!page.url().includes('/explore/')) return;
        const found = (await page.evaluate(GRID).catch(() => [])) as Tile[];
        for (const t of found) if (!tiles.has(t.code)) tiles.set(t.code, t);
        if (phase !== 'done') return;
        // the grid often carries no numbers: look up the posts that have none, gently
        const missing = [...tiles.keys()].filter((c) => !hasNumbers(details.get(c))).slice(0, config.instagramEnrichTop);
        let failures = 0;
        for (const code of missing) {
          if (ctx.cancelled()) break;
          const info: any = await page.evaluate(INFO(shortcodeToId(code))).catch(() => ({ __status: 0 }));
          if (info?.__status !== undefined) {
            if (info.__status === 429 || info.__status === 401 || ++failures >= 3) { ctx.log(`instagram detail lookups stopped (status ${info.__status})`); break; }
          } else {
            for (const it of parseMedia(info)) details.set(codeOf(it.url), it);
          }
          await sleep(900 + Math.random() * 1600);
        }
      },
    });
    for (const it of parseMedia(payloads)) {
      const code = codeOf(it.url);
      if (!hasNumbers(details.get(code))) details.set(code, it);
    }
    ctx.log(`instagram ${finalUrl.slice(ORIGIN.length)} grid=${tiles.size} loaded=${details.size}`);
    if (tiles.size >= ctx.limit) break;
  }

  const out = new Map<string, Item>();
  for (const [code, t] of tiles) {
    const d = details.get(code);
    out.set(code, d ?? {
      url: `${ORIGIN}/${t.kind === 'p' ? 'p' : 'reel'}/${code}/`,
      title: t.alt.replace(/\s+/g, ' ').trim().slice(0, 300) || 'Instagram post',
      type: t.kind === 'p' ? 'image' : 'video',
      thumbnail: t.thumb ?? undefined,
    });
  }
  // posts the page loaded outside the grid count only when they really use the keyword
  for (const [code, d] of details) if (!out.has(code) && mentions(d, keyword)) out.set(code, d);
  return [...out.values()];
};
