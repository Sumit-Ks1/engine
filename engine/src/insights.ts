import { config, type Platform } from './config.js';
import * as store from './db.js';
import { PROFILE_PLATFORMS, profileUrl, type ProfilePlatform } from './scrapers/profiles.js';

/** Start of the analysis window: the first day of the month, `profileMonths - 1` months back. */
export function windowStart(now = new Date()): number {
  return Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - (config.profileMonths - 1), 1);
}

export function months(now = new Date()): string[] {
  return Array.from({ length: config.profileMonths }, (_, i) => {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - (config.profileMonths - 1) + i, 1));
    return d.toISOString().slice(0, 7);
  });
}

/**
 * Everything the comparison pages need, as one small table: a row per company, platform,
 * month, format and category with summed numbers. The pages slice it however they like.
 */
export function summary() {
  const since = windowStart();
  const cube = new Map<string, { companyId: number; platform: Platform; month: string; format: string; category: string; posts: number; views: number; likes: number; comments: number; shares: number }>();
  for (const p of store.profilePosts(null, null, since)) {
    const month = p.publishedAt!.slice(0, 7);
    const key = `${p.companyId}|${p.platform}|${month}|${p.format}|${p.category}`;
    const row = cube.get(key) ?? { companyId: p.companyId, platform: p.platform, month, format: p.format, category: p.category, posts: 0, views: 0, likes: 0, comments: 0, shares: 0 };
    row.posts++;
    row.views += p.views ?? 0;
    row.likes += p.likes ?? 0;
    row.comments += p.comments ?? 0;
    row.shares += p.shares ?? 0;
    cube.set(key, row);
  }
  const handles = store.listHandles();
  return {
    demo: config.demoMode,
    months: months(),
    platforms: PROFILE_PLATFORMS,
    companies: store.listCompanies().map((c) => ({
      id: c.id,
      name: c.name,
      handles: Object.fromEntries(handles.filter((h) => h.company_id === c.id).map((h) => {
        let meta: { name?: string; followers?: number | null } = {};
        try { meta = JSON.parse(h.meta); } catch { /* keep empty */ }
        return [h.platform, {
          handle: h.handle, url: profileUrl(h.platform as ProfilePlatform, h.handle), status: h.status,
          fetchedAt: h.fetched_at, error: h.error, errorKind: h.error_kind, followers: meta.followers ?? null, name: meta.name ?? null,
        }];
      })),
    })),
    rows: [...cube.values()],
  };
}

const SORTS = ['publishedAt', 'views', 'likes', 'comments', 'shares'] as const;

/** The posts behind the numbers, filtered and sorted, a page at a time. */
export function posts(q: { company?: number | null; platform?: Platform | null; month?: string; format?: string; category?: string; sort?: string; page?: number }) {
  let list = store.profilePosts(q.company ?? null, q.platform ?? null, windowStart());
  if (q.month) list = list.filter((p) => p.publishedAt!.startsWith(q.month!));
  if (q.format) list = list.filter((p) => p.format === q.format);
  if (q.category) list = list.filter((p) => p.category === q.category);
  const sort = (SORTS as readonly string[]).includes(q.sort ?? '') ? (q.sort as (typeof SORTS)[number]) : 'views';
  const value = (p: (typeof list)[number]) => (sort === 'publishedAt' ? Date.parse(p.publishedAt!) : p[sort] ?? -1);
  list.sort((a, b) => value(b) - value(a));
  const limit = 50;
  const page = Math.max(1, q.page ?? 1);
  return { total: list.length, page, limit, posts: list.slice((page - 1) * limit, page * limit) };
}
