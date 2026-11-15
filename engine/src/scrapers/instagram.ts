import { capture } from '../browser.js';
import { config } from '../config.js';
import type { Item, Scraper } from '../types.js';
import { toTag, walk } from '../util.js';

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

export const instagram: Scraper = async (keyword, ctx) => {
  const tag = toTag(keyword);
  const pages = [
    ...(tag ? [`${ORIGIN}/explore/search/keyword/?q=${encodeURIComponent(`#${tag}`)}`, `${ORIGIN}/explore/tags/${encodeURIComponent(tag)}/`] : []),
    `${ORIGIN}/explore/search/keyword/?q=${encodeURIComponent(keyword)}`,
  ];
  const all = new Map<string, Item>();
  let loaded = 0;
  for (const url of [...new Set(pages)]) {
    // the page also loads the home feed and suggestions in the background; only posts that use the keyword count
    const relevant = (p: unknown) => parseMedia(p).filter((it) => mentions(it, keyword));
    const payloads = await capture({
      url,
      match: (u) => u.startsWith(ORIGIN) && /\/(api\/v1|graphql)\//.test(u),
      enough: (p) => relevant(p).length >= ctx.limit,
      maxScrolls: 16,
      embedded: true,
      loginWall: /\/accounts\/(login|signup|emailsignup)/,
      challenge: /\/challenge\/|\/accounts\/suspended/,
    });
    loaded += parseMedia(payloads).length;
    for (const it of relevant(payloads)) if (!all.has(it.url)) all.set(it.url, it);
    ctx.log(`instagram ${url.slice(ORIGIN.length)} posts seen=${loaded} using keyword=${all.size}`);
    if (all.size >= ctx.limit) break;
  }
  return [...all.values()];
};
