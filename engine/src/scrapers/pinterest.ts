import { config } from '../config.js';
import { request, Session } from '../http/client.js';
import { ScrapeError, type Item, type Scraper } from '../types.js';

const ORIGIN = 'https://www.pinterest.com';

export function parsePins(json: any): { items: Item[]; bookmark: string | null } {
  const rr = json?.resource_response;
  const results: any[] = Array.isArray(rr?.data?.results) ? rr.data.results : Array.isArray(rr?.data) ? rr.data : [];
  const items: Item[] = [];
  for (const p of results) {
    if (!p?.id || (p.type && p.type !== 'pin')) continue;
    const reactions = p.reaction_counts ? Object.values(p.reaction_counts as Record<string, number>).reduce((a, b) => a + (Number(b) || 0), 0) : null;
    const stats = p.aggregated_pin_data?.aggregated_stats;
    const isVideo = !!p.videos || !!p.story_pin_data?.pages?.some((pg: any) => pg?.blocks?.some((b: any) => b?.video));
    const img = p.images?.['474x'] ?? p.images?.['236x'] ?? p.images?.orig;
    const created = p.created_at ? new Date(p.created_at) : null;
    items.push({
      url: `${ORIGIN}/pin/${p.id}/`,
      title: (p.grid_title || p.title || p.description || p.seo_alt_text || 'Pin').trim().slice(0, 300),
      type: p.is_promoted ? 'ad' : isVideo ? 'video' : 'image',
      author: p.pinner?.full_name || p.pinner?.username,
      authorUrl: p.pinner?.username ? `${ORIGIN}/${p.pinner.username}/` : undefined,
      thumbnail: img?.url,
      likes: reactions,
      comments: typeof p.comment_count === 'number' ? p.comment_count : null,
      shares: typeof stats?.saves === 'number' ? stats.saves : typeof p.repin_count === 'number' ? p.repin_count : null,
      publishedAt: created && !Number.isNaN(created.getTime()) ? created.toISOString() : null,
      extra: { board: p.board?.name ?? null, link: p.link ?? null, domain: p.domain ?? null },
    });
  }
  const bm = rr?.bookmark ?? json?.resource?.options?.bookmarks?.[0] ?? null;
  return { items, bookmark: bm && bm !== '-end-' ? bm : null };
}

export const pinterest: Scraper = async (keyword, ctx) => {
  const session = new Session();
  const sourceUrl = `/search/pins/?q=${encodeURIComponent(keyword)}&rs=typed`;
  // the landing page hands out the anonymous session cookies the data endpoint expects
  await request(ORIGIN + sourceUrl, { session, passStatuses: [403] }).catch(() => undefined);

  const seen = new Map<string, Item>();
  let bookmark: string | null = null;
  // Pinterest has no "most saved" sort, so a deep pool is gathered and ranked afterwards
  for (let page = 0; page < 16 && seen.size < config.poolSize && !ctx.cancelled(); page++) {
    const data = {
      options: { query: keyword, scope: 'pins', rs: 'typed', page_size: 25, redux_normalize_feed: true, bookmarks: bookmark ? [bookmark] : [] },
      context: {},
    };
    const q = new URLSearchParams({ source_url: sourceUrl, data: JSON.stringify(data), _: String(Date.now()) });
    const headers: Record<string, string> = {
      accept: 'application/json, text/javascript, */*, q=0.01',
      'x-requested-with': 'XMLHttpRequest',
      'x-pinterest-appstate': 'active',
      'x-pinterest-pws-handler': 'www/search/[scope].js',
      'x-pinterest-source-url': sourceUrl,
      referer: ORIGIN + sourceUrl,
    };
    const csrf = session.getCookie('pinterest.com', 'csrftoken');
    if (csrf) headers['x-csrftoken'] = csrf;
    let json: any;
    try {
      const res = await request(`${ORIGIN}/resource/BaseSearchResource/get/?${q}`, { session, headers });
      json = res.json();
    } catch (e) {
      if (seen.size) break; // keep what the earlier pages returned
      throw e instanceof ScrapeError ? e : new ScrapeError('blocked', 'Pinterest returned a non-JSON page');
    }
    const parsed = parsePins(json);
    for (const it of parsed.items) if (!seen.has(it.url)) seen.set(it.url, it);
    ctx.log(`pinterest page=${page} total=${seen.size}`);
    bookmark = parsed.bookmark;
    if (!bookmark || !parsed.items.length) break;
  }
  return [...seen.values()];
};
