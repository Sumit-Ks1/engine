export type ItemType = 'video' | 'short' | 'image' | 'post' | 'article' | 'search' | 'ad';

export interface Item {
  url: string;
  title: string;
  type: ItemType;
  author?: string;
  authorUrl?: string;
  thumbnail?: string;
  views?: number | null;
  likes?: number | null;
  comments?: number | null;
  shares?: number | null;
  publishedAt?: string | null;
  /** Platform specific extras (duration, subreddit, source, ...). */
  extra?: Record<string, string | number | boolean | null>;
}

export type ErrorKind = 'blocked' | 'login_required' | 'network' | 'parse';

export class ScrapeError extends Error {
  constructor(public kind: ErrorKind, message: string) {
    super(message);
    this.name = 'ScrapeError';
  }
}

export interface ScrapeContext {
  limit: number;
  log: (msg: string) => void;
  /** True once the keyword has been removed: stop working on it. */
  cancelled: () => boolean;
}

/** Thrown to abandon a job whose keyword was removed while it was being collected. */
export class CancelledError extends Error {
  constructor() { super('keyword was removed'); this.name = 'CancelledError'; }
}

export type Scraper = (keyword: string, ctx: ScrapeContext) => Promise<Item[]>;
