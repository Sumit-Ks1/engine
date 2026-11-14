import { request, Session } from '../http/client.js';
import { ScrapeError, type Item, type Scraper } from '../types.js';
import { parseCount, toTag, walk } from '../util.js';
import { discover } from './discovery.js';

const ORIGIN = 'https://www.instagram.com';
const APP_ID = '936619743392459'; // public id of the instagram.com web client

/** Media objects from the hashtag payload the web client itself loads. */
export function parseTagInfo(json: unknown): Item[] {
  const items = new Map<string, Item>();
  walk(json, (o) => {
    if (typeof o.code !== 'string' || !('like_count' in o || 'comment_count' in o)) return;
    const isVideo = o.media_type === 2 || o.product_type === 'clips';
    const url = `${ORIGIN}/${o.product_type === 'clips' ? 'reel' : 'p'}/${o.code}/`;
    if (items.has(url)) return false;
    items.set(url, {
      url,
      title: (o.caption?.text ?? '').trim().slice(0, 300) || 'Instagram post',
      type: isVideo ? 'video' : 'image',
      author: o.user?.username ? `@${o.user.username}` : undefined,
      authorUrl: o.user?.username ? `${ORIGIN}/${o.user.username}/` : undefined,
      thumbnail: o.image_versions2?.candidates?.[0]?.url ?? o.carousel_media?.[0]?.image_versions2?.candidates?.[0]?.url,
      views: o.play_count ?? o.ig_play_count ?? o.view_count ?? null,
      likes: o.like_count ?? null,
      comments: o.comment_count ?? null,
      shares: o.reshare_count ?? null,
      publishedAt: o.taken_at ? new Date(o.taken_at * 1000).toISOString() : null,
    });
    return false;
  });
  return [...items.values()];
}

/** Public embed page of a single post: the only place metrics show without a login. */
export function parseEmbed(html: string, url: string): Item {
  const num = (re: RegExp) => { const m = html.match(re); return m ? parseCount(m[1]) : null; };
  const str = (re: RegExp) => {
    const m = html.match(re);
    if (!m) return undefined;
    try { return JSON.parse(`"${m[1].replace(/\\\\/g, '\\')}"`) as string; } catch { return m[1]; }
  };
  const username = str(/\\?"username\\?":\\?"([A-Za-z0-9._]+)\\?"/) ?? html.match(/class="Username"[^>]*>([^<]+)</)?.[1];
  const caption = str(/\\?"edge_media_to_caption\\?":\{\\?"edges\\?":\[\{\\?"node\\?":\{\\?"text\\?":\\?"((?:[^"\\]|\\.)*?)\\?"\}/);
  const views = num(/\\?"video_(?:view|play)_count\\?":(\d+)/);
  return {
    url,
    title: (caption ?? '').trim().slice(0, 300) || 'Instagram post',
    type: views !== null || /\\?"is_video\\?":true/.test(html) || url.includes('/reel/') ? 'video' : 'image',
    author: username ? `@${username}` : undefined,
    authorUrl: username ? `${ORIGIN}/${username}/` : undefined,
    thumbnail: html.match(/class="EmbeddedMediaImage"[^>]*src="([^"]+)"/)?.[1]?.replace(/&amp;/g, '&'),
    views,
    likes: num(/\\?"edge_(?:liked_by|media_preview_like)\\?":\{\\?"count\\?":(\d+)/) ?? num(/([\d,.]+\s?[KMB]?)\s+likes/i),
    comments: num(/\\?"edge_media_to_(?:parent_)?comment\\?":\{\\?"count\\?":(\d+)/) ?? num(/view all ([\d,.]+\s?[KMB]?) comments/i),
    publishedAt: (() => { const t = html.match(/\\?"taken_at_timestamp\\?":(\d+)/); return t ? new Date(Number(t[1]) * 1000).toISOString() : null; })(),
  };
}

export const instagram: Scraper = async (keyword, ctx) => {
  const tag = toTag(keyword);
  if (!tag) return [];
  const session = new Session();
  let wall: ScrapeError | undefined;

  // 1) the hashtag payload — Instagram serves it to anonymous visitors only some of the time
  try {
    const res = await request(`${ORIGIN}/api/v1/tags/web_info/?tag_name=${encodeURIComponent(tag)}`, {
      session,
      retries: 1,
      headers: { accept: '*/*', 'x-ig-app-id': APP_ID, 'x-requested-with': 'XMLHttpRequest', referer: `${ORIGIN}/explore/tags/${tag}/` },
    });
    const items = parseTagInfo(res.json());
    if (items.length) return items;
  } catch (e) {
    if (!(e instanceof ScrapeError)) wall = new ScrapeError('login_required', 'Instagram hashtag page needs a login');
    else wall = e;
    ctx.log(`instagram tag payload unavailable: ${wall.message}`);
  }

  // 2) public post links via web search, metrics from each post's public embed page
  const links = await discover(`site:instagram.com "#${tag}"`, /https:\/\/www\.instagram\.com\/(?:p|reel)\/[A-Za-z0-9_-]{5,}/g, ctx.limit, ctx.log);
  ctx.log(`instagram discovery found ${links.length} links`);
  const out: Item[] = [];
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(2, links.length) }, async () => {
    while (cursor < links.length) {
      const url = links[cursor++] + '/';
      try {
        const html = (await request(`${url}embed/captioned/`, { session, retries: 1 })).body;
        out.push(parseEmbed(html, url));
      } catch {
        out.push({ url, title: 'Instagram post', type: url.includes('/reel/') ? 'video' : 'image' });
      }
    }
  }));
  if (!out.length) {
    throw new ScrapeError('login_required', wall?.message ?? 'Instagram shows hashtag results only to logged-in users and no public links were found');
  }
  return out;
};
