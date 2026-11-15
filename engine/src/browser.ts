import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium, type BrowserContext, type Page } from 'playwright-core';
import { config } from './config.js';
import { ScrapeError } from './types.js';
import { sleep } from './util.js';

/**
 * One real browser with a saved profile. The profile holds the sign-ins created with
 * `npm run login`, so signed-in platforms see the same browser, on the same network,
 * every time — and no cookie ever has to be copied by hand.
 */
let ctx: Promise<BrowserContext> | null = null;

export function launchOptions(headless: boolean) {
  return {
    headless,
    ...(config.browser.path ? { executablePath: config.browser.path } : { channel: config.browser.channel }),
    viewport: { width: 1366, height: 850 },
    locale: `${config.lang}-${config.region}`,
    args: ['--disable-blink-features=AutomationControlled', '--no-first-run', '--no-default-browser-check',
      ...(process.platform === 'linux' ? ['--no-sandbox'] : [])],
  };
}

export const profileDir = () => {
  const dir = resolve(config.browser.profileDir);
  mkdirSync(dir, { recursive: true });
  return dir;
};

function context(): Promise<BrowserContext> {
  if (!ctx) {
    ctx = chromium.launchPersistentContext(profileDir(), launchOptions(config.browser.headless)).then((c) => {
      c.on('close', () => { ctx = null; });
      return c;
    }, (e: Error) => {
      ctx = null;
      const hint = /ProcessSingleton|profile.*in use|already running/i.test(e.message)
        ? 'the browser profile is in use (close the sign-in window first)'
        : /executable doesn.t exist|not found|install/i.test(e.message)
          ? `no ${config.browser.channel} browser found on this machine (set BROWSER_CHANNEL=msedge or BROWSER_PATH)`
          : e.message.split('\n')[0];
      throw new ScrapeError('network', `Browser could not start: ${hint}`);
    });
  }
  return ctx;
}

export async function closeBrowser() {
  const c = await ctx?.catch(() => null);
  await c?.close().catch(() => undefined);
}

const rand = (min: number, max: number) => min + Math.random() * (max - min);

export interface CaptureOptions {
  url: string;
  /** Which network responses to keep (JSON bodies only). */
  match: (url: string) => boolean;
  /** Stop scrolling once this returns true. */
  enough: (payloads: unknown[]) => boolean;
  maxScrolls: number;
  /** Final URLs that mean "not signed in". */
  loginWall?: RegExp;
  /** Final URLs / page text that mean the account is being challenged or limited. */
  challenge?: RegExp;
  /** Also collect JSON embedded in the page itself. */
  embedded?: boolean;
  /** Extra data read from the page (runs in the page). */
  evaluate?: string;
}

/**
 * Opens a page like a person would, scrolls it, and returns every JSON payload the site's
 * own code loaded. Parsers then read the payloads, so nothing depends on endpoint details.
 */
export async function capture(opts: CaptureOptions): Promise<unknown[]> {
  const c = await context();
  const page: Page = await c.newPage();
  const payloads: unknown[] = [];
  const pending = new Set<Promise<void>>();
  let limited = false;
  page.on('response', (res) => {
    const url = res.url();
    if (!opts.match(url)) return;
    if (res.status() === 429) { limited = true; return; }
    if (!(res.headers()['content-type'] ?? '').includes('json')) return;
    const p = res.json().then((j) => { payloads.push(j); }, () => undefined).finally(() => pending.delete(p));
    pending.add(p);
  });
  try {
    await page.goto(opts.url, { waitUntil: 'domcontentloaded', timeout: 45_000 }).catch((e: Error) => {
      throw new ScrapeError('network', `Page did not load: ${e.message.split('\n')[0]}`);
    });
    await sleep(rand(2500, 4500));
    const check = () => {
      const url = page.url();
      if (opts.loginWall?.test(url)) throw new ScrapeError('login_required', 'Not signed in. Stop the engine, run "npm run login", sign in, then start the engine again.');
      if (opts.challenge?.test(url)) throw new ScrapeError('blocked', 'The platform is asking this account to verify itself. Open the site in the sign-in window and complete the check.');
    };
    check();
    if (opts.embedded) {
      const blobs = await page.evaluate(() => [...document.querySelectorAll('script[type="application/json"]')].map((s) => s.textContent ?? '')).catch(() => [] as string[]);
      for (const b of blobs) { try { payloads.push(JSON.parse(b)); } catch { /* not JSON */ } }
    }
    if (opts.evaluate) {
      const extra = await page.evaluate(opts.evaluate).catch(() => null);
      if (extra) payloads.push(extra);
    }
    let idle = 0;
    for (let i = 0; i < opts.maxScrolls && !opts.enough(payloads) && !limited; i++) {
      const before = payloads.length;
      await page.mouse.move(rand(300, 900), rand(200, 600));
      await page.mouse.wheel(0, rand(1800, 3200));
      await sleep(rand(1600, 3400));
      await Promise.all(pending);
      check();
      idle = payloads.length === before ? idle + 1 : 0;
      if (idle >= 3) break;
    }
    await Promise.all(pending);
    if (limited && !payloads.length) throw new ScrapeError('blocked', 'The platform is rate-limiting this account.');
    return payloads;
  } finally {
    await page.close().catch(() => undefined);
  }
}

/** JSON request made by the signed-in browser itself (same cookies, same network identity). */
export async function browserJson(url: string): Promise<{ status: number; json: any }> {
  const c = await context();
  const res = await c.request.get(url, { headers: { accept: 'application/json' }, timeout: 30_000 }).catch((e: Error) => {
    throw new ScrapeError('network', e.message.split('\n')[0]);
  });
  let json: any = null;
  try { json = await res.json(); } catch { /* html error page */ }
  return { status: res.status(), json };
}
