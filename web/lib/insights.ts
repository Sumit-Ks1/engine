export type ProfilePlatform = 'youtube' | 'instagram' | 'twitter';
export const PROFILE_PLATFORMS: { id: ProfilePlatform; label: string }[] = [
  { id: 'youtube', label: 'YouTube' }, { id: 'instagram', label: 'Instagram' }, { id: 'twitter', label: 'X / Twitter' },
];

export interface HandleState { handle: string; url: string; status: 'idle' | 'queued' | 'running' | 'done' | 'failed'; fetchedAt: number | null; error: string | null; errorKind: string | null; followers: number | null; name: string | null }
export interface CompanyInfo { id: number; name: string; handles: Partial<Record<ProfilePlatform, HandleState>> }
export interface Row { companyId: number; platform: ProfilePlatform; month: string; format: string; category: string; posts: number; views: number; likes: number; comments: number; shares: number }
export interface Summary { demo?: boolean; months: string[]; companies: CompanyInfo[]; rows: Row[] }
export interface Post {
  companyId: number; platform: ProfilePlatform; url: string; title: string; thumbnail?: string; author?: string;
  views?: number | null; likes?: number | null; comments?: number | null; shares?: number | null; publishedAt: string;
  format: string; category: string; extra?: Record<string, string | number | boolean | null>;
}

/** Fixed order = fixed colour slot; a format or category never changes colour. */
export const FORMATS = [
  { id: 'video', label: 'Video', color: 'var(--series-1)' },
  { id: 'short', label: 'Short / Reel', color: 'var(--series-2)' },
  { id: 'image', label: 'Image', color: 'var(--series-3)' },
  { id: 'text', label: 'Text post', color: 'var(--series-4)' },
];
export const CATEGORIES = [
  { id: 'organic', label: 'Own post', color: 'var(--series-1)' },
  { id: 'collaboration', label: 'Collaboration', color: 'var(--series-2)' },
  { id: 'promoted_est', label: 'Likely promoted (estimate)', color: 'var(--series-3)' },
];

export const METRICS = [
  { id: 'posts', label: 'Posts' },
  { id: 'views', label: 'Views' },
  { id: 'likes', label: 'Likes' },
  { id: 'comments', label: 'Comments' },
  { id: 'engagement', label: 'Engagement (likes + comments + shares)' },
  { id: 'collaboration', label: 'Collaboration posts' },
  { id: 'promoted_est', label: 'Likely promoted posts (estimate)' },
] as const;
export type MetricId = (typeof METRICS)[number]['id'];
export const metricLabel = (id: MetricId) => METRICS.find((m) => m.id === id)!.label.replace(/ \(likes.*\)$/, '');

export function value(r: Row, metric: MetricId): number {
  switch (metric) {
    case 'posts': return r.posts;
    case 'views': return r.views;
    case 'likes': return r.likes;
    case 'comments': return r.comments;
    case 'engagement': return r.likes + r.comments + r.shares;
    default: return r.category === metric ? r.posts : 0;
  }
}

export const sum = (rows: Row[], metric: MetricId) => rows.reduce((n, r) => n + value(r, metric), 0);
export const byMonth = (rows: Row[], months: string[], metric: MetricId) => months.map((m) => sum(rows.filter((r) => r.month === m), metric));

const compactFmt = new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 });
const fullFmt = new Intl.NumberFormat('en-IN');
export const compact = (n: number) => (Math.abs(n) < 10000 ? fullFmt.format(Math.round(n)) : compactFmt.format(n));
export const full = (n: number) => fullFmt.format(Math.round(n));
export const monthShort = (m: string) => new Date(`${m}-01T00:00:00Z`).toLocaleDateString('en', { month: 'short', timeZone: 'UTC' });
export const monthLong = (m: string) => new Date(`${m}-01T00:00:00Z`).toLocaleDateString('en', { month: 'long', year: 'numeric', timeZone: 'UTC' });
export const pct = (part: number, whole: number) => (whole ? `${((part / whole) * 100).toFixed(part / whole < 0.1 ? 1 : 0)}%` : '—');
