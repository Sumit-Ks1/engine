import { request } from '../http/client.js';
import { decodeEntities } from '../util.js';

/** Unwraps the redirect links search engines put around result URLs. */
export function unwrapLinks(html: string): string {
  let out = decodeEntities(html);
  out = out.replace(/uddg=([^&"'\s]+)/g, (_, enc: string) => {
    try { return ` ${decodeURIComponent(enc)} `; } catch { return ' '; }
  });
  out = out.replace(/[?&]u=a1([A-Za-z0-9_-]+)/g, (_, b64: string) => {
    try { return ` ${Buffer.from(b64, 'base64url').toString('utf8')} `; } catch { return ' '; }
  });
  return out;
}

/**
 * Finds public post links for login-walled platforms through ordinary web search
 * result pages. Returns every match of `pattern` (deduplicated, in rank order).
 */
export async function discover(query: string, pattern: RegExp, want: number, log: (m: string) => void): Promise<string[]> {
  const found = new Set<string>();
  const collect = (html: string) => {
    const before = found.size;
    for (const m of unwrapLinks(html).matchAll(pattern)) found.add(m[0]);
    return found.size - before;
  };
  const engines: Array<(page: number) => Promise<string>> = [
    async (page) => (await request(`https://www.bing.com/search?${new URLSearchParams({ q: query, count: '50', first: String(page * 50 + 1) })}`, { retries: 1 })).body,
    async (page) => (await request('https://html.duckduckgo.com/html/', {
      method: 'POST', retries: 1,
      headers: { 'content-type': 'application/x-www-form-urlencoded', origin: 'https://html.duckduckgo.com', referer: 'https://html.duckduckgo.com/' },
      body: new URLSearchParams({ q: query, s: String(page * 30), dc: String(page * 30 + 1) }).toString(),
    })).body,
  ];
  let answered = false;
  let lastErr: unknown;
  for (const [i, engine] of engines.entries()) {
    for (let page = 0; page < 4 && found.size < want; page++) {
      try {
        const html = await engine(page);
        answered = true;
        if (!collect(html)) break;
      } catch (e) {
        lastErr = e;
        log(`discovery engine#${i} page=${page} failed: ${(e as Error).message}`);
        break;
      }
    }
    if (found.size >= want) break;
  }
  // no search page could be loaded at all: that is a block / outage, not "nothing public exists"
  if (!answered && lastErr) throw lastErr;
  return [...found].slice(0, want);
}
