import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseNewsRss } from '../src/scrapers/google.js';
import { unwrapLinks } from '../src/scrapers/discovery.js';
import { parseEmbed, parseTagInfo } from '../src/scrapers/instagram.js';
import { parsePins } from '../src/scrapers/pinterest.js';
import { parseListing } from '../src/scrapers/reddit.js';
import { embedToken, parseTweet } from '../src/scrapers/twitter.js';
import { parseSearch, parseWatch, searchParams } from '../src/scrapers/youtube.js';
import { rank } from '../src/scrapers/index.js';
import { extractJsonAfter, normalizeKeyword, parseCount, relativeToIso, toTag } from '../src/util.js';

test('parseCount', () => {
  assert.equal(parseCount('1,234,567 views'), 1234567);
  assert.equal(parseCount('1.2M views'), 1200000);
  assert.equal(parseCount('3.4K'), 3400);
  assert.equal(parseCount('2.5 lakh views'), 250000);
  assert.equal(parseCount('1.1 crore'), 11000000);
  assert.equal(parseCount('No views'), 0);
  assert.equal(parseCount('abc'), null);
});

test('relativeToIso / keywords', () => {
  const now = Date.UTC(2026, 0, 15);
  assert.equal(relativeToIso('Streamed 2 weeks ago', now), new Date(Date.UTC(2026, 0, 1)).toISOString());
  assert.equal(normalizeKeyword('  ##Skin   Care '), 'Skin Care');
  assert.equal(normalizeKeyword(''), null);
  assert.equal(toTag('Skin Care!'), 'skincare');
});

test('extractJsonAfter handles braces inside strings', () => {
  const html = `<script>var ytInitialData = {"a":"}{\\"","b":{"c":1}};</script>`;
  assert.deepEqual(extractJsonAfter(html, 'ytInitialData'), { a: '}{"', b: { c: 1 } });
});

test('youtube search params + parsing', () => {
  assert.equal(searchParams(4), 'CAMSBAgEEAE=');
  assert.equal(searchParams(), 'CAMSAhAB');
  const data = { contents: { x: [
    { videoRenderer: {
      videoId: 'abc123', title: { runs: [{ text: 'Big video' }] },
      ownerText: { runs: [{ text: 'Chan', navigationEndpoint: { browseEndpoint: { canonicalBaseUrl: '/@chan' } } }] },
      viewCountText: { simpleText: '12,345,678 views' }, publishedTimeText: { simpleText: '3 days ago' },
      lengthText: { simpleText: '10:01' }, thumbnail: { thumbnails: [{ url: 's.jpg' }, { url: 'l.jpg' }] },
      navigationEndpoint: { commandMetadata: { webCommandMetadata: { url: '/watch?v=abc123' } } },
    } },
    { shortsLockupViewModel: { onTap: { innertubeCommand: { reelWatchEndpoint: { videoId: 'sh1' } } }, overlayMetadata: { primaryText: { content: 'Short one' }, secondaryText: { content: '4.5M views' } } } },
    { continuationItemRenderer: { continuationEndpoint: { continuationCommand: { token: 'TOKEN' } } } },
  ] } };
  const { items, continuation } = parseSearch(data);
  assert.equal(continuation, 'TOKEN');
  assert.equal(items.length, 2);
  assert.deepEqual([items[0].url, items[0].views, items[0].author, items[0].thumbnail, items[0].type], ['https://www.youtube.com/watch?v=abc123', 12345678, 'Chan', 'l.jpg', 'video']);
  assert.deepEqual([items[1].url, items[1].views, items[1].type], ['https://www.youtube.com/shorts/sh1', 4500000, 'short']);
  assert.deepEqual(parseWatch('..."likeCount":"98765"... "commentCount":{"simpleText":"1.2K"}'), { likes: 98765, comments: 1200 });
});

test('reddit listing', () => {
  const { items, after } = parseListing({ data: { after: 't3_x', children: [
    { kind: 't3', data: { permalink: '/r/a/comments/1/t/', title: 'A &amp; B', score: 5400, num_comments: 321, author: 'bob', created_utc: 1760000000, is_video: true, subreddit_name_prefixed: 'r/a', num_crossposts: 4 } },
    { kind: 't5', data: {} },
  ] } });
  assert.equal(after, 't3_x');
  assert.equal(items.length, 1);
  assert.deepEqual([items[0].url, items[0].title, items[0].likes, items[0].comments, items[0].type], ['https://www.reddit.com/r/a/comments/1/t/', 'A & B', 5400, 321, 'video']);
});

test('google news rss', () => {
  const xml = `<rss><channel><item><title>Story one - The Paper</title><link>https://news.google.com/rss/articles/abc?oc=5</link><pubDate>Mon, 09 Nov 2026 10:00:00 GMT</pubDate><description>&lt;ol&gt;&lt;li&gt;a&lt;/li&gt;&lt;li&gt;b&lt;/li&gt;&lt;/ol&gt;</description><source url="https://paper.example">The Paper</source></item></channel></rss>`;
  const [it] = parseNewsRss(xml);
  assert.deepEqual([it.title, it.author, it.url, it.publishedAt, it.extra?.coverage], ['Story one', 'The Paper', 'https://news.google.com/rss/articles/abc?oc=5', '2026-11-09T10:00:00.000Z', 2]);
});

test('pinterest pins', () => {
  const { items, bookmark } = parsePins({ resource_response: { bookmark: 'BM', data: { results: [
    { id: '99', type: 'pin', grid_title: 'Pin title', images: { '474x': { url: 'i.jpg' } }, pinner: { username: 'amy', full_name: 'Amy' }, reaction_counts: { '1': 40, '5': 2 }, comment_count: 3, aggregated_pin_data: { aggregated_stats: { saves: 1200 } }, is_promoted: true },
    { id: '5', type: 'story' },
  ] } } });
  assert.equal(bookmark, 'BM');
  assert.equal(items.length, 1);
  assert.deepEqual([items[0].url, items[0].likes, items[0].shares, items[0].type], ['https://www.pinterest.com/pin/99/', 42, 1200, 'ad']);
  assert.equal(parsePins({ resource_response: { bookmark: '-end-', data: { results: [] } } }).bookmark, null);
});

test('instagram payload + embed', () => {
  const items = parseTagInfo({ data: { top: { sections: [{ layout_content: { medias: [{ media: { code: 'Cxyz', like_count: 1000, comment_count: 20, play_count: 50000, media_type: 2, product_type: 'clips', user: { username: 'joe' }, caption: { text: 'hello #tag' }, taken_at: 1760000000 } }] } }] } } });
  assert.deepEqual([items[0].url, items[0].views, items[0].likes, items[0].type, items[0].author], ['https://www.instagram.com/reel/Cxyz/', 50000, 1000, 'video', '@joe']);
  const html = `<script>x({\\"shortcode_media\\":{\\"owner\\":{\\"username\\":\\"joe.k\\"},\\"video_view_count\\":7777,\\"edge_liked_by\\":{\\"count\\":345},\\"edge_media_to_comment\\":{\\"count\\":12},\\"taken_at_timestamp\\":1760000000}})</script>`;
  const e = parseEmbed(html, 'https://www.instagram.com/p/Cxyz/');
  assert.deepEqual([e.views, e.likes, e.comments, e.author, e.type], [7777, 345, 12, '@joe.k', 'video']);
  assert.equal(parseEmbed('<a class="Username">amy</a> <span>1,234 likes</span>', 'https://www.instagram.com/p/C1/').likes, 1234);
});

test('twitter embed data + link discovery', () => {
  assert.match(embedToken('1846987139428634858'), /^[a-z0-9]+$/);
  const it = parseTweet({ id_str: '123456789', text: 'hi\nthere', user: { screen_name: 'ann' }, favorite_count: 900, conversation_count: 30, created_at: '2026-11-01T00:00:00.000Z', mediaDetails: [{ type: 'photo', media_url_https: 'p.jpg' }] })!;
  assert.deepEqual([it.url, it.title, it.likes, it.comments, it.type], ['https://x.com/ann/status/123456789', 'hi there', 900, 30, 'image']);
  assert.equal(parseTweet({ __typename: 'TweetTombstone' }), null);
  const ddg = `<a href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fx.com%2Fann%2Fstatus%2F123456789&amp;rut=1">`;
  const bing = `<a href="https://www.bing.com/ck/a?!&&p=1&u=a1${Buffer.from('https://www.instagram.com/reel/Cabc12/').toString('base64url')}&ntb=1">`;
  const text = unwrapLinks(ddg + bing);
  assert.ok(text.includes('https://x.com/ann/status/123456789'));
  assert.ok(text.includes('https://www.instagram.com/reel/Cabc12/'));
});

test('rank orders by traction and caps the list', () => {
  const r = rank([{ url: 'a', title: 'a', type: 'post', likes: 1 }, { url: 'b', title: 'b', type: 'video', views: 5e6 }, { url: 'c', title: 'c', type: 'post' }], 2);
  assert.deepEqual(r.map((x) => x.url), ['b', 'a']);
});
