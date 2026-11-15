import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseNewsRss, parseRelated } from '../src/scrapers/google.js';
import { mentions, parseMedia, shortcodeToId } from '../src/scrapers/instagram.js';
import { looseJson } from '../src/browser.js';
import { parsePins } from '../src/scrapers/pinterest.js';
import { parseListing } from '../src/scrapers/reddit.js';
import { parseTimeline } from '../src/scrapers/twitter.js';
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
  assert.deepEqual(extractJsonAfter(`window["ytInitialData"] = {"z":2};`, 'ytInitialData'), { z: 2 });
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

test('instagram media from any payload shape', () => {
  const media = { code: 'Cxyz12', like_count: 1000, comment_count: 20, play_count: 50000, media_type: 2, product_type: 'clips', user: { username: 'joe' }, caption: { text: 'hello #tag' }, taken_at: 1760000000 };
  const items = parseMedia([
    { data: { top: { sections: [{ layout_content: { medias: [{ media }] } }] } } },
    { data: { xdt_search: { edges: [{ node: { code: 'Cimg77', media_type: 1, like_count: 5, owner: { username: 'amy' } } }, { node: media }] } } },
    { unrelated: { code: 'x' } },
  ]);
  assert.equal(items.length, 2);
  assert.deepEqual([items[0].url, items[0].views, items[0].likes, items[0].type, items[0].author], ['https://www.instagram.com/reel/Cxyz12/', 50000, 1000, 'video', '@joe']);
  assert.deepEqual([items[1].url, items[1].type, items[1].author], ['https://www.instagram.com/p/Cimg77/', 'image', '@amy']);
});

test('instagram keeps only posts that use the keyword', () => {
  const post = (title: string, author = '@someone') => ({ url: 'u', title, type: 'image' as const, author });
  assert.ok(mentions(post('Best mattress ever #WakeFit #sleep'), 'wakefit'));
  assert.ok(mentions(post('New launch', '@wakefit.co'), 'wakefit'));
  assert.ok(mentions(post('my #HomeDecor ideas'), 'home decor'));
  assert.ok(mentions(post('simple home decor tips'), 'Home Decor'));
  assert.ok(!mentions(post('Big developments for Karnataka', '@narendramodi'), 'wakefit'));
  assert.equal(shortcodeToId('B'), '1');
  assert.equal(shortcodeToId('BA'), '64');
  assert.match(shortcodeToId('DCabcdEFGhi'), /^\d{15,20}$/);
  assert.deepEqual(looseJson('for (;;);{"a":1}'), { a: 1 });
  assert.equal(looseJson('<html>nope</html>'), undefined);
});

test('x search timeline', () => {
  const tweet = (id: string, extra: object = {}) => ({ __typename: 'Tweet', rest_id: id, views: { count: '120000' },
    core: { user_results: { result: { legacy: { screen_name: 'ann' } } } },
    legacy: { full_text: 'hi there https://t.co/abc', favorite_count: 900, reply_count: 30, retweet_count: 10, quote_count: 2, created_at: 'Sun Nov 01 00:00:00 +0000 2026', extended_entities: { media: [{ type: 'video', media_url_https: 'p.jpg' }] }, ...extra } });
  const items = parseTimeline([{ data: { entries: [
    { content: { itemContent: { tweet_results: { result: tweet('111') } } } },
    { content: { itemContent: { tweet_results: { result: tweet('222') }, promotedMetadata: {} } } },
    { content: { itemContent: { tweet_results: { result: tweet('333', { retweeted_status_result: { result: tweet('111') } }) } } } },
  ] } }]);
  assert.deepEqual(items.map((i) => [i.url, i.type]), [['https://x.com/ann/status/111', 'video'], ['https://x.com/ann/status/222', 'ad']]);
  assert.deepEqual([items[0].title, items[0].views, items[0].likes, items[0].comments, items[0].shares], ['hi there', 120000, 900, 30, 12]);
});

test('google trends related searches: rising first', () => {
  const items = parseRelated({ default: { rankedList: [
    { rankedKeyword: [{ query: 'skincare routine', value: 100, formattedValue: '100', link: '/trends/explore?q=a' }] },
    { rankedKeyword: [{ query: 'new serum', value: 5200, formattedValue: 'Breakout' }, { query: 'glass skin', value: 250, formattedValue: '+250%' }] },
  ] } });
  assert.deepEqual(items.map((i) => [i.title, i.extra?.signal]), [['new serum', 'Breakout (+5000%)'], ['glass skin', '+250% growth'], ['skincare routine', '100/100 interest']]);
  assert.equal(items[0].url, 'https://www.google.com/search?q=new%20serum');
});

test('rank orders by traction and caps the list', () => {
  const r = rank([{ url: 'a', title: 'a', type: 'post', likes: 1 }, { url: 'b', title: 'b', type: 'video', views: 5e6 }, { url: 'c', title: 'c', type: 'post' }], 2);
  assert.deepEqual(r.map((x) => x.url), ['b', 'a']);
});
