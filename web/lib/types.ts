export const PLATFORMS = [
  { id: 'youtube', label: 'YouTube' },
  { id: 'instagram', label: 'Instagram' },
  { id: 'twitter', label: 'X / Twitter' },
  { id: 'reddit', label: 'Reddit' },
  { id: 'pinterest', label: 'Pinterest' },
  { id: 'google', label: 'Google' },
] as const;
export type PlatformId = (typeof PLATFORMS)[number]['id'];

export interface PlatformState {
  status: 'queued' | 'running' | 'done' | 'failed';
  count: number;
  fetchedAt: number | null;
  error?: string | null;
  errorKind?: string | null;
}
export interface KeywordRow { id: number; term: string; created_at: number; platforms: Partial<Record<PlatformId, PlatformState>> }
export interface Item {
  url: string; title: string; type: string; author?: string; authorUrl?: string; thumbnail?: string;
  views?: number | null; likes?: number | null; comments?: number | null; shares?: number | null;
  publishedAt?: string | null; extra?: Record<string, string | number | boolean | null>;
}

/** Column headings differ per platform; null hides the column. */
export const METRICS: Record<PlatformId, { views: string | null; likes: string | null; comments: string | null; shares: string | null }> = {
  youtube: { views: 'Views', likes: 'Likes', comments: 'Comments', shares: null },
  instagram: { views: 'Plays', likes: 'Likes', comments: 'Comments', shares: null },
  twitter: { views: 'Video views', likes: 'Likes', comments: 'Replies', shares: null },
  reddit: { views: null, likes: 'Upvotes', comments: 'Comments', shares: 'Crossposts' },
  pinterest: { views: null, likes: 'Reactions', comments: 'Comments', shares: 'Saves' },
  google: { views: null, likes: null, comments: null, shares: null },
};
