import { config } from '../config.js';
import { request, Session } from '../http/client.js';
import { ScrapeError, type Item, type Scraper } from '../types.js';
import { extractJsonAfter, parseCount, relativeToIso, text, walk } from '../util.js';

const ORIGIN = 'https://www.youtube.com';

/** Search filter token: sort by view count, videos only, optional upload window (3 week, 4 month, 5 year). */
export function searchParams(window?: 3 | 4 | 5): string {
  const filter = window ? [0x08, window, 0x10, 0x01] : [0x10, 0x01];
  return Buffer.from([0x08, 0x03, 0x12, filter.length, ...filter]).toString('base64');
}

export function parseSearch(data: unknown): { items: Item[]; continuation: string | null } {
  const items: Item[] = [];
  let continuation: string | null = null;
  walk(data, (o) => {
    const v = o.videoRenderer;
    if (v?.videoId) {
      const path: string = v.navigationEndpoint?.commandMetadata?.webCommandMetadata?.url ?? '';
      const isShort = path.startsWith('/shorts/');
      const thumbs = v.thumbnail?.thumbnails ?? [];
      const owner = v.ownerText?.runs?.[0] ?? v.longBylineText?.runs?.[0];
      const base = owner?.navigationEndpoint?.browseEndpoint?.canonicalBaseUrl;
      const published = text(v.publishedTimeText);
      items.push({
        url: isShort ? `${ORIGIN}/shorts/${v.videoId}` : `${ORIGIN}/watch?v=${v.videoId}`,
        title: text(v.title),
        type: isShort ? 'short' : 'video',
        author: owner?.text,
        authorUrl: base ? ORIGIN + base : undefined,
        thumbnail: thumbs[thumbs.length - 1]?.url,
        views: parseCount(text(v.viewCountText) || text(v.shortViewCountText)),
        publishedAt: relativeToIso(published),
        extra: { duration: text(v.lengthText) || null, published: published || null, videoId: v.videoId },
      });
      return false;
    }
    const s = o.shortsLockupViewModel;
    if (s) {
      const id = s.onTap?.innertubeCommand?.reelWatchEndpoint?.videoId;
      if (id) {
        items.push({
          url: `${ORIGIN}/shorts/${id}`,
          title: text(s.overlayMetadata?.primaryText),
          type: 'short',
          thumbnail: s.thumbnail?.sources?.[0]?.url ?? s.onTap?.innertubeCommand?.reelWatchEndpoint?.thumbnail?.thumbnails?.[0]?.url,
          views: parseCount(text(s.overlayMetadata?.secondaryText)),
          extra: { videoId: id },
        });
      }
      return false;
    }
    const token = o.continuationItemRenderer?.continuationEndpoint?.continuationCommand?.token;
    if (token) continuation = token;
  });
  return { items, continuation };
}

/** Likes / comments are only present on the video page itself. */
export function parseWatch(html: string): { likes: number | null; comments: number | null } {
  const like = html.match(/"likeCount":"(\d+)"/) ?? html.match(/"accessibilityText":"([\d,.]+\s?[KMB]?) likes"/i)
    ?? html.match(/like this video along with ([\d,]+) other/i);
  const comment = html.match(/"commentCount":\{"simpleText":"([^"]+)"/)
    ?? html.match(/"commentsEntryPointHeaderRenderer".{0,400}?"commentCount":\{"simpleText":"([^"]+)"/s)
    ?? html.match(/"contextualInfo":\{"runs":\[\{"text":"([\d,.]+\s?[KMB]?)"\}\]\}/);
  return { likes: like ? parseCount(like[1]) : null, comments: comment ? parseCount(comment[1]) : null };
}

export const youtube: Scraper = async (keyword, ctx) => {
  const session = new Session();
  // skips the EU consent interstitial
  session.setCookie('youtube.com', 'SOCS', 'CAI');
  session.setCookie('youtube.com', 'CONSENT', 'YES+1');
  const seen = new Map<string, Item>();
  const add = (list: Item[]) => { for (const it of list) if (it.title && !seen.has(it.url)) seen.set(it.url, it); };

  // freshest window first so the list is "trending" rather than all-time classics
  for (const window of [4, 5, undefined] as const) {
    if (seen.size >= ctx.limit) break;
    const q = new URLSearchParams({ search_query: keyword, sp: searchParams(window), hl: config.lang, gl: config.region });
    const page = await request(`${ORIGIN}/results?${q}`, { session });
    const data = extractJsonAfter(page.body, 'ytInitialData');
    if (!data) throw new ScrapeError('parse', 'YouTube results page had no data payload (consent or bot check page)');
    let { items, continuation } = parseSearch(data);
    add(items);
    const version = page.body.match(/"INNERTUBE_CLIENT_VERSION":"([^"]+)"/)?.[1] ?? '2.20241201.00.00';
    for (let p = 0; p < 6 && continuation && seen.size < ctx.limit; p++) {
      const more = await request(`${ORIGIN}/youtubei/v1/search?prettyPrint=false`, {
        session,
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: '*/*', origin: ORIGIN, referer: page.url, 'x-youtube-client-name': '1', 'x-youtube-client-version': version },
        body: JSON.stringify({
          context: { client: { clientName: 'WEB', clientVersion: version, hl: config.lang, gl: config.region } },
          continuation,
        }),
      });
      const parsed = parseSearch(more.json());
      if (!parsed.items.length) break;
      add(parsed.items);
      continuation = parsed.continuation;
    }
    ctx.log(`youtube window=${window ?? 'all'} total=${seen.size}`);
  }

  const top = [...seen.values()].sort((a, b) => (b.views ?? 0) - (a.views ?? 0)).slice(0, ctx.limit);
  const enrich = top.slice(0, config.youtubeEnrichTop);
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(3, enrich.length) }, async () => {
    while (cursor < enrich.length) {
      const it = enrich[cursor++];
      try {
        const html = (await request(`${ORIGIN}/watch?v=${it.extra!.videoId}&hl=en`, { session, retries: 1 })).body;
        Object.assign(it, parseWatch(html));
      } catch { /* metrics stay empty for this video */ }
    }
  }));
  return top;
};
