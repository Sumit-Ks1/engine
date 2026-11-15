import { capture } from '../browser.js';
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

async function viaHttp(keyword: string, session: Session, want: number, log: (m: string) => void): Promise<Item[]> {
  const seen = new Map<string, Item>();
  const add = (list: Item[]) => { for (const it of list) if (it.title && !seen.has(it.url)) seen.set(it.url, it); };
  let firstError: unknown;
  // freshest window first so the list is "trending" rather than all-time classics; the last pass has no filter at all
  for (const sp of [searchParams(4), searchParams(5), searchParams(), '']) {
    if (seen.size >= want) break;
    try {
      const q = new URLSearchParams({ search_query: keyword, hl: 'en', gl: config.region });
      if (sp) q.set('sp', sp);
      const page = await request(`${ORIGIN}/results?${q}`, { session });
      const data = extractJsonAfter(page.body, 'ytInitialData');
      if (!data) throw new ScrapeError('parse', 'YouTube results page had no data payload (consent or bot check page)');
      let { items, continuation } = parseSearch(data);
      add(items);
      const version = page.body.match(/"INNERTUBE_CLIENT_VERSION":"([^"]+)"/)?.[1] ?? '2.20241201.00.00';
      const visitor = page.body.match(/"VISITOR_DATA":"([^"]+)"/)?.[1];
      for (let p = 0; p < 8 && continuation && seen.size < want; p++) {
        const more = await request(`${ORIGIN}/youtubei/v1/search?prettyPrint=false`, {
          session, method: 'POST', retries: 1,
          headers: {
            'content-type': 'application/json', accept: '*/*', origin: ORIGIN, referer: page.url,
            'x-youtube-client-name': '1', 'x-youtube-client-version': version, ...(visitor ? { 'x-goog-visitor-id': visitor } : {}),
          },
          body: JSON.stringify({ context: { client: { clientName: 'WEB', clientVersion: version, hl: 'en', gl: config.region, visitorData: visitor } }, continuation }),
        });
        const parsed = parseSearch(more.json());
        if (!parsed.items.length) break;
        add(parsed.items);
        continuation = parsed.continuation;
      }
    } catch (e) {
      // one bad page must not throw away what the other passes found
      firstError ??= e;
      log(`youtube pass sp=${sp || 'none'} stopped: ${(e as Error).message}`);
    }
    log(`youtube sp=${sp || 'none'} total=${seen.size}`);
  }
  if (!seen.size && firstError) throw firstError;
  return [...seen.values()];
}

/** Same search through the real browser, used when plain requests are turned away. */
async function viaBrowser(keyword: string, want: number): Promise<Item[]> {
  const seen = new Map<string, Item>();
  for (const sp of [searchParams(4), searchParams()]) {
    const { payloads } = await capture({
      url: `${ORIGIN}/results?${new URLSearchParams({ search_query: keyword, sp, hl: 'en', gl: config.region })}`,
      match: (u) => u.includes('/youtubei/v1/search'),
      enough: (p) => parseSearch(p).items.length >= want,
      maxScrolls: 12,
      evaluate: 'window.ytInitialData',
      challenge: /google\.com\/sorry|consent\.youtube\.com/,
    });
    for (const it of parseSearch(payloads).items) if (it.title && !seen.has(it.url)) seen.set(it.url, it);
    if (seen.size >= want) break;
  }
  return [...seen.values()];
}

export const youtube: Scraper = async (keyword, ctx) => {
  const session = new Session();
  // skips the consent interstitial
  session.setCookie('youtube.com', 'SOCS', 'CAI');
  session.setCookie('youtube.com', 'CONSENT', 'YES+1');
  let pool: Item[] = [];
  let httpError: unknown;
  try { pool = await viaHttp(keyword, session, config.poolSize, ctx.log); } catch (e) { httpError = e; }
  if (pool.length < 20) {
    ctx.log(`youtube switching to browser (${httpError ? (httpError as Error).message : `only ${pool.length} results`})`);
    try {
      const extra = await viaBrowser(keyword, config.poolSize);
      const urls = new Set(pool.map((p) => p.url));
      pool.push(...extra.filter((e) => !urls.has(e.url)));
    } catch (e) {
      if (!pool.length) throw new ScrapeError((e as ScrapeError).kind ?? 'network', `Requests: ${(httpError as Error)?.message ?? 'no results'} | Browser: ${(e as Error).message}`);
    }
  }

  const top = pool.sort((a, b) => (b.views ?? 0) - (a.views ?? 0)).slice(0, ctx.limit);
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
