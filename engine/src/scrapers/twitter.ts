import { request } from '../http/client.js';
import { ScrapeError, type Item, type Scraper } from '../types.js';
import { discover } from './discovery.js';

/** Token the public embed endpoint expects; derived from the post id exactly as the embed widget does. */
export const embedToken = (id: string) => ((Number(id) / 1e15) * Math.PI).toString(36).replace(/(0+|\.)/g, '');

export function parseTweet(t: any): Item | null {
  if (!t?.id_str || !t.user?.screen_name || t.__typename === 'TweetTombstone') return null;
  const media = t.mediaDetails?.[0];
  const isVideo = !!t.video || media?.type === 'video' || media?.type === 'animated_gif';
  return {
    url: `https://x.com/${t.user.screen_name}/status/${t.id_str}`,
    title: String(t.text ?? '').replace(/\s+/g, ' ').trim().slice(0, 300) || 'Post',
    type: isVideo ? 'video' : media ? 'image' : 'post',
    author: `@${t.user.screen_name}`,
    authorUrl: `https://x.com/${t.user.screen_name}`,
    thumbnail: media?.media_url_https ?? t.video?.poster ?? t.user.profile_image_url_https,
    views: typeof t.video?.viewCount === 'number' ? t.video.viewCount : null,
    likes: typeof t.favorite_count === 'number' ? t.favorite_count : null,
    comments: typeof t.conversation_count === 'number' ? t.conversation_count : null,
    shares: typeof t.retweet_count === 'number' ? t.retweet_count : null,
    publishedAt: t.created_at ? new Date(t.created_at).toISOString() : null,
    extra: { verified: !!(t.user.is_blue_verified || t.user.verified) },
  };
}

/**
 * X search is closed to anonymous visitors, so public post links are discovered via
 * web search and each post's numbers are read from X's public embed endpoint.
 */
export const twitter: Scraper = async (keyword, ctx) => {
  const links = await discover(
    `(site:x.com OR site:twitter.com) "${keyword}" inurl:status`,
    /https:\/\/(?:www\.|mobile\.)?(?:x|twitter)\.com\/[A-Za-z0-9_]{1,15}\/status\/\d{6,20}/g,
    ctx.limit * 2,
    ctx.log,
  );
  const ids = [...new Set(links.map((l) => l.match(/status\/(\d+)/)![1]))].slice(0, ctx.limit);
  ctx.log(`twitter discovery found ${ids.length} posts`);
  if (!ids.length) throw new ScrapeError('login_required', 'X search needs a login and no public post links were found for this keyword');

  const out: Item[] = [];
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(3, ids.length) }, async () => {
    while (cursor < ids.length) {
      const id = ids[cursor++];
      try {
        const q = new URLSearchParams({ id, token: embedToken(id), lang: 'en' });
        const res = await request(`https://cdn.syndication.twimg.com/tweet-result?${q}`, { retries: 1, headers: { accept: 'application/json', origin: 'https://platform.twitter.com', referer: 'https://platform.twitter.com/' } });
        const item = parseTweet(res.json());
        if (item) out.push(item);
      } catch { /* deleted / protected post */ }
    }
  }));
  if (!out.length) throw new ScrapeError('blocked', 'X post details could not be loaded');
  return out;
};
