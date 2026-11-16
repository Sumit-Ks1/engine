import { capture } from '../browser.js';
import { config, type Platform } from '../config.js';
import { Session } from '../http/client.js';
import { ScrapeError, type Item } from '../types.js';
import { parseCount, sleep, walk } from '../util.js';
import { GRID, INFO, codeOf, hasNumbers, parseMedia, shortcodeToId } from './instagram.js';
import { parseTimeline } from './twitter.js';
import { fillDetails, parseSearch } from './youtube.js';

/** Platforms on which brands run official accounts that can be read post by post. */
export const PROFILE_PLATFORMS = ['youtube', 'instagram', 'twitter'] as const satisfies readonly Platform[];
export type ProfilePlatform = (typeof PROFILE_PLATFORMS)[number];

export type Format = 'video' | 'short' | 'image' | 'text';
export type Category = 'organic' | 'collaboration' | 'promoted_est';
export interface ProfilePost extends Item { format: Format; category: Category }
export interface ProfileResult { posts: Item[]; meta: { name?: string; followers?: number | null } }
export interface ProfileContext { log: (m: string) => void; cancelled: () => boolean; since: number }
type ProfileScraper = (handle: string, ctx: ProfileContext) => Promise<ProfileResult>;

/** Accepts a handle or a profile link and returns the canonical handle (null when unusable). */
export function normalizeHandle(platform: ProfilePlatform, raw: unknown): string | null {
  let s = String(raw ?? '').trim();
  if (!s) return null;
  if (/^https?:\/\//i.test(s) || /^(www\.)?(instagram|youtube|x|twitter)\.com\//i.test(s)) {
    try { s = new URL(/^https?:/i.test(s) ? s : `https://${s}`).pathname; } catch { return null; }
  }
  const parts = s.split('/').filter(Boolean);
  if (!parts.length) return null;
  if (platform === 'youtube') {
    const [a, b] = parts;
    if (/^(channel|c|user)$/.test(a) && b && /^[\w.-]{1,80}$/.test(b)) return `${a}/${b}`;
    const h = a.replace(/^@/, '');
    return /^[\w.-]{2,60}$/.test(h) ? `@${h}` : null;
  }
  const h = parts[0].replace(/^@/, '');
  return (platform === 'instagram' ? /^[A-Za-z0-9._]{1,30}$/ : /^[A-Za-z0-9_]{1,15}$/).test(h) ? h : null;
}

const SKIP: Record<ProfilePlatform, RegExp> = {
  // links that are posts, share buttons, embed scripts or site sections rather than an account
  instagram: /^(p|reel|reels|tv|explore|accounts|share|sharer|stories|direct|about|developer|legal|embed|embed\.js|static|oauth)$/i,
  youtube: /^(watch|embed|playlist|results|shorts|share|feed|hashtag|live|t|about|premium|gaming|music|redirect|iframe_api|player_api|s|yts|api|v|e|oembed|subscription_center|supported_browsers|howyoutubeworks|creators|ads|intl|account|kids|tv|signin|generate_204)$/i,
  twitter: /^(intent|share|home|hashtag|search|i|login|signup|explore|privacy|tos|settings|widgets\.js|oauth|statuses)$/i,
};

/**
 * Finds a brand's own account links in the HTML of its website (footer icons, "follow us"
 * links, structured data). The handle linked most often wins; share buttons are ignored.
 */
export function extractHandles(html: string): Partial<Record<ProfilePlatform, string>> {
  const counts: Record<ProfilePlatform, Map<string, { handle: string; n: number }>> = { youtube: new Map(), instagram: new Map(), twitter: new Map() };
  const text = html.replace(/\\\//g, '/').replace(/&amp;/g, '&');
  for (const m of text.matchAll(/https?:\/\/(?:www\.|m\.|mobile\.)?(instagram\.com|youtube\.com|twitter\.com|x\.com)\/([^"'\s<>\\)]+)/gi)) {
    const platform: ProfilePlatform = /instagram/i.test(m[1]) ? 'instagram' : /youtube/i.test(m[1]) ? 'youtube' : 'twitter';
    const path = m[2].split(/[?#]/)[0];
    const first = path.split('/')[0];
    if (!first || SKIP[platform].test(first)) continue;
    const handle = normalizeHandle(platform, path);
    if (!handle) continue;
    const key = handle.toLowerCase();
    const cur = counts[platform].get(key) ?? { handle, n: 0 };
    cur.n++;
    counts[platform].set(key, cur);
  }
  const out: Partial<Record<ProfilePlatform, string>> = {};
  for (const p of PROFILE_PLATFORMS) {
    const best = [...counts[p].values()].sort((a, b) => b.n - a.n)[0];
    if (best) out[p] = best.handle;
  }
  return out;
}

/** Pages of a brand site that usually carry its "follow us" links when the home page does not. */
const FALLBACK_PAGES = ['/pages/contact-us', '/contact-us', '/pages/about-us', '/about-us'];

async function readLinks(url: string, cancelled: () => boolean): Promise<Partial<Record<ProfilePlatform, string>>> {
  let found: Partial<Record<ProfilePlatform, string>> = {};
  await capture({
    cancelled,
    url,
    match: () => false,
    enough: () => false,
    maxScrolls: 3,
    onPage: async (page, phase) => {
      if (phase === 'loaded') await page.evaluate('window.scrollTo(0, document.body.scrollHeight)').catch(() => undefined); // footers often load late
      if (phase !== 'done') return;
      const html = (await page.evaluate('document.documentElement.outerHTML').catch(() => '')) as string;
      found = extractHandles(html);
    },
  });
  return found;
}

/** The same address with or without "www.", for sites that only answer on one of them. */
export function alternateHost(website: string): string | null {
  try {
    const u = new URL(website);
    u.hostname = u.hostname.startsWith('www.') ? u.hostname.slice(4) : `www.${u.hostname}`;
    return u.toString();
  } catch { return null; }
}

/**
 * Opens a brand's website in the browser and reads its official account links. If the address
 * does not load, the www / non-www twin is tried; if the home page lacks a platform, a few
 * contact / about pages are checked as well.
 */
export async function discoverHandles(website: string, ctx: { cancelled: () => boolean }): Promise<{ handles: Partial<Record<ProfilePlatform, string>>; site: string }> {
  let site = website;
  let handles: Partial<Record<ProfilePlatform, string>>;
  try {
    handles = await readLinks(site, ctx.cancelled);
  } catch (e) {
    const alt = e instanceof ScrapeError && e.kind === 'network' ? alternateHost(website) : null;
    if (!alt) throw e;
    site = alt;
    handles = await readLinks(site, ctx.cancelled);
  }
  for (const path of FALLBACK_PAGES) {
    if (PROFILE_PLATFORMS.every((p) => handles[p]) || ctx.cancelled()) break;
    const more = await readLinks(new URL(path, site).toString(), ctx.cancelled).catch(() => ({} as Partial<Record<ProfilePlatform, string>>));
    handles = { ...more, ...handles };
  }
  return { handles, site };
}

export const profileUrl = (platform: ProfilePlatform, handle: string) =>
  platform === 'youtube' ? `https://www.youtube.com/${handle}` : platform === 'instagram' ? `https://www.instagram.com/${handle}/` : `https://x.com/${handle}`;

const time = (it: Item) => (it.publishedAt ? Date.parse(it.publishedAt) : NaN);
/** Feeds are newest-first, so a few posts older than the window mean the window is covered (pinned posts aside). */
const reachedWindow = (items: Item[], since: number) => items.filter((it) => time(it) < since).length >= 4;

/**
 * Sorts a post into what kind of thing it is.
 * - collaboration: the platform itself marks it (Instagram co-author or paid-partnership label, YouTube paid-promotion flag).
 * - promoted_est: an ESTIMATE. Reach far beyond the engagement it earned is the footprint of paid promotion,
 *   which platforms do not label on a profile.
 * - organic: everything else.
 */
export function classify(it: Item, platform: ProfilePlatform): ProfilePost {
  const format: Format = platform === 'instagram' ? ((it.extra?.format as Format) ?? (it.type === 'video' ? 'video' : 'image'))
    : it.type === 'short' ? 'short' : it.type === 'video' ? 'video' : it.type === 'image' ? 'image' : platform === 'youtube' ? 'video' : 'text';
  const views = it.views ?? 0;
  const engagement = (it.likes ?? 0) + (it.comments ?? 0) + (it.shares ?? 0);
  const marked = !!it.extra?.collabWith || !!it.extra?.paidPartnership || !!it.extra?.paidPromotion;
  const category: Category = marked ? 'collaboration' : views >= 100_000 && it.likes != null && engagement / views < 0.002 ? 'promoted_est' : 'organic';
  return { ...it, format, category };
}

const instagram: ProfileScraper = async (handle, ctx) => {
  const origin = 'https://www.instagram.com';
  const details = new Map<string, Item>();
  const tiles = new Set<string>();
  let followers: number | null = null;
  let name: string | undefined;
  const mine = (it: Item) => it.author?.toLowerCase() === `@${handle.toLowerCase()}` || String(it.extra?.collabWith ?? '').toLowerCase().split(',').includes(handle.toLowerCase());
  const absorb = (payloads: unknown) => {
    for (const it of parseMedia(payloads)) if (mine(it) && !hasNumbers(details.get(codeOf(it.url)))) details.set(codeOf(it.url), it);
    walk(payloads, (o) => {
      if (typeof o.username === 'string' && o.username.toLowerCase() === handle.toLowerCase()) {
        const f = o.follower_count ?? o.edge_followed_by?.count;
        if (typeof f === 'number') { followers = f; name = o.full_name || name; }
      }
    });
  };
  // the grid has every post; the reels tab is where play counts are shown
  for (const path of [`/${handle}/`, `/${handle}/reels/`]) {
    const { payloads } = await capture({
      cancelled: ctx.cancelled,
      url: origin + path,
      match: (u) => u.startsWith(origin) && /\/(api\/v1|graphql)\//.test(u),
      enough: (p) => { absorb(p); return reachedWindow([...details.values()], ctx.since) || details.size >= config.profileMaxPosts; },
      maxScrolls: 70,
      embedded: true,
      loginWall: /\/accounts\/(login|signup|emailsignup)/,
      challenge: /\/challenge\/|\/accounts\/suspended/,
      thin: () => details.size < 3,
      debugName: `profile-instagram-${handle}`,
      onPage: async (page, phase) => {
        if (phase === 'loaded' && /Sorry, this page isn't available|Page Not Found/i.test(await page.title().catch(() => ''))) {
          throw new ScrapeError('parse', `Instagram has no account named "${handle}".`);
        }
        for (const t of ((await page.evaluate(GRID).catch(() => [])) as { code: string }[])) tiles.add(t.code);
        if (phase !== 'done' || path.endsWith('/reels/')) return;
        // tiles the page showed without numbers or a date are looked up one by one, gently
        const missing = [...tiles].filter((c) => !hasNumbers(details.get(c)) || !details.get(c)?.publishedAt).slice(0, config.profileEnrichTop);
        let failures = 0;
        for (const code of missing) {
          if (ctx.cancelled()) break;
          const info: any = await page.evaluate(INFO(shortcodeToId(code))).catch(() => ({ __status: 0 }));
          if (info?.__status !== undefined) {
            if (info.__status === 429 || info.__status === 401 || ++failures >= 3) { ctx.log(`instagram detail lookups stopped (status ${info.__status})`); break; }
          } else {
            for (const it of parseMedia(info)) if (mine(it)) details.set(codeOf(it.url), it);
          }
          await sleep(900 + Math.random() * 1600);
        }
      },
    });
    absorb(payloads);
    ctx.log(`instagram ${path} posts=${details.size}`);
  }
  return { posts: [...details.values()], meta: { name, followers } };
};

const twitter: ProfileScraper = async (handle, ctx) => {
  const all: unknown[] = [];
  const own = (p: unknown[]) => parseTimeline(p).filter((it) => it.author?.toLowerCase() === `@${handle.toLowerCase()}`);
  const { payloads } = await capture({
    cancelled: ctx.cancelled,
    url: `https://x.com/${handle}`,
    match: (u) => /\/(UserTweets|UserTweetsAndReplies|UserMedia|UserByScreenName)\b/.test(u),
    enough: (p) => reachedWindow(own(p), ctx.since) || own(p).length >= config.profileMaxPosts,
    maxScrolls: 90,
    loginWall: /\/i\/flow\/login|\/login(\?|$)/,
    challenge: /\/account\/access|\/i\/flow\/(?!login)/,
    thin: (p) => own(p).length < 3,
    debugName: `profile-twitter-${handle}`,
  });
  all.push(...payloads);
  let followers: number | null = null;
  let name: string | undefined;
  walk(all, (o) => {
    const screen = o.core?.screen_name ?? o.legacy?.screen_name;
    if (typeof screen === 'string' && screen.toLowerCase() === handle.toLowerCase() && typeof o.legacy?.followers_count === 'number') {
      followers = o.legacy.followers_count; name = o.core?.name ?? o.legacy?.name ?? name;
    }
  });
  const posts = own(all);
  ctx.log(`twitter @${handle} posts=${posts.length}`);
  return { posts, meta: { name, followers } };
};

const youtube: ProfileScraper = async (handle, ctx) => {
  const base = `https://www.youtube.com/${handle}`;
  const seen = new Map<string, Item>();
  let followers: number | null = null;
  let name: string | undefined;
  const yearOld = (items: Item[]) => items.filter((it) => /\b(1[2-9] months|years?) ago/i.test(String(it.extra?.published ?? ''))).length >= 4;
  for (const tab of ['videos', 'shorts', 'streams']) {
    const { payloads } = await capture({
      cancelled: ctx.cancelled,
      url: `${base}/${tab}?hl=en`,
      match: (u) => u.includes('/youtubei/v1/browse'),
      enough: (p) => { const items = parseSearch(p).items; return yearOld(items) || items.length >= config.profileMaxPosts; },
      // shorts tiles carry no date, so that tab is read to a fixed depth
      maxScrolls: tab === 'shorts' ? 14 : 45,
      evaluate: 'window.ytInitialData',
      challenge: /google\.com\/sorry|consent\.youtube\.com/,
    }).catch((e) => { if (tab === 'videos') throw e; return { payloads: [] as unknown[] }; });
    const blob = JSON.stringify(payloads[0] ?? '');
    const subs = blob.match(/"([\d.,]+\s?[KMB]?) subscribers"/);
    if (subs) followers = parseCount(subs[1]);
    name ??= blob.match(/"channelMetadataRenderer":\{"title":"([^"]+)"/)?.[1];
    for (const it of parseSearch(payloads).items) {
      if (!it.title || seen.has(it.url)) continue;
      if (tab === 'shorts') it.type = 'short';
      seen.set(it.url, it);
    }
    ctx.log(`youtube ${handle}/${tab} total=${seen.size}`);
  }
  if (!seen.size) throw new ScrapeError('parse', `No videos could be read from youtube.com/${handle}. Check the handle.`);
  // listing dates are approximate ("3 months ago"); each video page gives the exact date, likes and comments
  const candidates = [...seen.values()].filter((it) => !it.publishedAt || Date.parse(it.publishedAt) >= ctx.since - 45 * 864e5).slice(0, config.profileMaxPosts);
  await fillDetails(candidates, new Session(), `${base}/videos?hl=en`, ctx);
  for (const it of candidates) { it.author = name ?? handle; it.authorUrl = base; }
  return { posts: candidates, meta: { name, followers } };
};

export const profileScrapers: Record<ProfilePlatform, ProfileScraper> = { youtube, instagram, twitter };

/** Sample posts for UI work without network access. Enabled only with DEMO_MODE=1. */
export const demoProfile: ProfileScraper = async (handle, ctx) => {
  await sleep(300 + Math.random() * 900);
  let seed = [...handle].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7);
  const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
  const n = 60 + Math.floor(rnd() * 140);
  const reach = 2e4 + rnd() * 4e5;
  const posts: Item[] = Array.from({ length: n }, (_, i) => {
    const type = (['video', 'short', 'image', 'post'] as const)[Math.floor(rnd() * 4)];
    const boosted = rnd() < 0.08;
    const views = Math.round(reach * (0.1 + rnd() * rnd() * 4) * (boosted ? 25 : 1));
    return {
      url: `https://example.com/sample/${handle}/${i + 1}`,
      title: `[SAMPLE] ${handle} post ${i + 1}`,
      type,
      author: `@${handle}`,
      views,
      likes: Math.round(views * (boosted ? 0.0006 : 0.02 + rnd() * 0.05)),
      comments: Math.round(views * (boosted ? 0.0001 : 0.002 + rnd() * 0.004)),
      shares: Math.round(views * 0.003 * rnd()),
      publishedAt: new Date(ctx.since + rnd() * (Date.now() - ctx.since)).toISOString(),
      extra: { collabWith: rnd() < 0.12 ? `creator_${Math.floor(rnd() * 20)}` : '', format: type === 'post' ? 'image' : type },
    };
  });
  return { posts, meta: { name: handle, followers: Math.round(reach * 3) } };
};
