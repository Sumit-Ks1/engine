import { fetch } from 'undici';
import { config } from '../config.js';
import { ScrapeError } from '../types.js';
import { sleep } from '../util.js';
import { routes, type Route } from './proxy.js';

/** Coherent desktop browser header sets; one is picked per scrape session. */
const PROFILES = [
  {
    'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    'sec-ch-ua': '"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"',
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"Windows"',
  },
  {
    'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    'sec-ch-ua': '"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"',
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"macOS"',
  },
  { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:133.0) Gecko/20100101 Firefox/133.0' },
  { 'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15' },
] as const;

/** One logical browsing session: stable headers + cookie jar. */
export class Session {
  readonly profile: Record<string, string> = PROFILES[Math.floor(Math.random() * PROFILES.length)];
  private cookies = new Map<string, Map<string, string>>();

  setCookie(host: string, name: string, value: string) {
    const site = siteOf(host);
    if (!this.cookies.has(site)) this.cookies.set(site, new Map());
    this.cookies.get(site)!.set(name, value);
  }
  getCookie(host: string, name: string) {
    return this.cookies.get(siteOf(host))?.get(name);
  }
  header(host: string) {
    const jar = this.cookies.get(siteOf(host));
    return jar?.size ? [...jar].map(([k, v]) => `${k}=${v}`).join('; ') : undefined;
  }
  absorb(host: string, setCookies: string[]) {
    for (const line of setCookies) {
      const pair = line.split(';', 1)[0];
      const eq = pair.indexOf('=');
      if (eq > 0) this.setCookie(host, pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
    }
  }
}

const siteOf = (host: string) => host.toLowerCase().split('.').slice(-2).join('.');

/** Serialises requests per host with a minimum gap, so bursts never hit one site. */
const hostQueue = new Map<string, Promise<void>>();
function throttle(host: string): Promise<void> {
  const prev = hostQueue.get(host) ?? Promise.resolve();
  const gap = config.hostMinIntervalMs * (0.7 + Math.random() * 0.8);
  const ready = prev.then(() => sleep(gap));
  hostQueue.set(host, ready);
  return prev;
}

export interface RequestOptions {
  session?: Session;
  method?: 'GET' | 'POST';
  headers?: Record<string, string>;
  body?: string;
  retries?: number;
  /** Statuses returned to the caller instead of being treated as failures. */
  passStatuses?: number[];
}

export interface Response {
  status: number;
  url: string;
  body: string;
  json<T = any>(): T;
}

const randomIp = () => `${11 + Math.floor(Math.random() * 180)}.${Math.floor(Math.random() * 255)}.${Math.floor(Math.random() * 255)}.${1 + Math.floor(Math.random() * 253)}`;
const LOGIN_RE = /\/accounts\/login|\/i\/flow\/login|\/login\/?(\?|$)/i;

async function once(url: URL, route: Route, opts: RequestOptions, session: Session) {
  const headers: Record<string, string> = {
    accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'accept-language': `${config.lang}-${config.region},${config.lang};q=0.9,en;q=0.8`,
    'accept-encoding': 'gzip, deflate, br',
    'upgrade-insecure-requests': '1',
    ...session.profile,
    ...opts.headers,
  };
  const cookie = session.header(url.hostname);
  if (cookie) headers.cookie = cookie;

  let target = url.toString();
  if (route.gatewayBase) {
    target = route.gatewayBase + url.pathname + url.search;
    headers['x-my-x-forwarded-for'] = randomIp();
  }
  const res = await fetch(target, {
    method: opts.method ?? 'GET',
    headers,
    body: opts.body,
    dispatcher: route.dispatcher,
    redirect: 'manual',
    signal: AbortSignal.timeout(config.requestTimeoutMs),
  });
  session.absorb(url.hostname, res.headers.getSetCookie());
  return res;
}

/**
 * Fetches a URL through the rotating route pool. Blocks (403/429/5xx) and network
 * errors move to another route with back-off; login walls fail fast.
 */
export async function request(rawUrl: string, opts: RequestOptions = {}): Promise<Response> {
  const session = opts.session ?? new Session();
  const retries = opts.retries ?? config.requestRetries;
  const tried = new Set<string>();
  let url = new URL(rawUrl);
  let lastErr: ScrapeError = new ScrapeError('network', 'request not attempted');

  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt) await sleep(Math.min(20_000, 1500 * 2 ** (attempt - 1)) * (0.6 + Math.random() * 0.8));
    const host = url.hostname;
    const route = routes.pick(host, tried);
    tried.add(route.id);
    try {
      let res: Awaited<ReturnType<typeof once>> | undefined;
      let method = opts.method;
      let body = opts.body;
      for (let hop = 0; hop < 6; hop++) {
        await throttle(url.hostname);
        // a redirect to another host must not reuse a gateway bound to the first one
        const hopRoute = url.hostname === host ? route : routes.pick(url.hostname);
        res = await once(url, hopRoute, { ...opts, method, body }, session);
        const loc = res.headers.get('location');
        if (res.status < 300 || res.status >= 400 || !loc) break;
        await res.body?.cancel();
        const next = new URL(loc, url);
        if (LOGIN_RE.test(next.pathname + next.search)) {
          throw new ScrapeError('login_required', `${host} redirected to a login page`);
        }
        url = next;
        if (res.status !== 307 && res.status !== 308) { method = 'GET'; body = undefined; }
      }
      const status = res!.status;
      const text = await res!.text();
      if (status >= 200 && status < 300 || opts.passStatuses?.includes(status)) {
        routes.report(host, route, true);
        return { status, url: url.toString(), body: text, json: () => JSON.parse(text) };
      }
      if (status === 401) throw new ScrapeError('login_required', `${host} answered 401 (login required)`);
      if (status === 404 || status === 410) throw new ScrapeError('parse', `${host} answered ${status}`);
      routes.report(host, route, false);
      lastErr = new ScrapeError('blocked', `${host} answered ${status} via ${route.id}`);
    } catch (e) {
      if (e instanceof ScrapeError) {
        if (e.kind === 'login_required' || e.kind === 'parse') throw e;
        lastErr = e;
      } else {
        routes.report(host, route, false);
        const err = e as Error & { cause?: Error };
        lastErr = new ScrapeError('network', `${host}: ${err.cause?.message || err.message} via ${route.id}`);
      }
    }
  }
  throw lastErr;
}
