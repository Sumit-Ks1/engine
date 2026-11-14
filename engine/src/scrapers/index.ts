import { config, type Platform } from '../config.js';
import type { Item, Scraper } from '../types.js';
import { google } from './google.js';
import { instagram } from './instagram.js';
import { pinterest } from './pinterest.js';
import { reddit } from './reddit.js';
import { twitter } from './twitter.js';
import { youtube } from './youtube.js';

const real: Record<Platform, Scraper> = { youtube, instagram, twitter, reddit, pinterest, google };

/** Sample data for UI work without network access. Enabled only with DEMO_MODE=1. */
const demo: Scraper = async (keyword, ctx) => {
  await new Promise((r) => setTimeout(r, 400 + Math.random() * 1200));
  return Array.from({ length: ctx.limit }, (_, i): Item => {
    const views = Math.round(9e6 / (i + 1) ** 0.8 + Math.random() * 5e4);
    return {
      url: `https://example.com/sample/${encodeURIComponent(keyword)}/${i + 1}`,
      title: `[SAMPLE] ${keyword} — sample entry ${i + 1}`,
      type: (['video', 'short', 'image', 'post'] as const)[i % 4],
      author: `sample_creator_${(i % 17) + 1}`,
      views,
      likes: Math.round(views * 0.04),
      comments: Math.round(views * 0.003),
      shares: Math.round(views * 0.006),
      publishedAt: new Date(Date.now() - i * 36e5 * 7).toISOString(),
    };
  });
};

export const scrapers: Record<Platform, Scraper> = config.demoMode
  ? { youtube: demo, instagram: demo, twitter: demo, reddit: demo, pinterest: demo, google: demo }
  : real;

/** Single traction score used to rank a platform's results. */
export function score(it: Item): number {
  return (it.views ?? 0) + (it.likes ?? 0) * 20 + (it.comments ?? 0) * 40 + (it.shares ?? 0) * 40;
}

/** Ranks by traction; items without any numbers keep the platform's own order after the rest. */
export function rank(items: Item[], limit: number): Item[] {
  return items
    .map((it, i) => ({ it, i, s: score(it) }))
    .sort((a, b) => b.s - a.s || a.i - b.i)
    .slice(0, limit)
    .map((x) => x.it);
}
