import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
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

export function launchOptions(headless: boolean, onScreen = config.browser.visible) {
  // a normal window parked off-screen: looks like an ordinary browser to the sites, stays out of the way
  const windowArgs = headless ? [] : [
    // always state the position: Chrome otherwise reopens wherever the window last was, which may be off-screen
    `--window-position=${onScreen ? '60,40' : '-2400,-2400'}`, `--window-size=${onScreen ? '1200,760' : '1366,900'}`,
    '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding', '--disable-background-timer-throttling',
  ];
  return {
    headless,
    ...(config.browser.path ? { executablePath: config.browser.path } : { channel: config.browser.channel }),
    viewport: { width: 1366, height: 850 },
    locale: `${config.lang}-${config.region}`,
    args: ['--disable-blink-features=AutomationControlled', '--no-first-run', '--no-default-browser-check',
      '--hide-crash-restore-bubble', '--disable-session-crashed-bubble', ...windowArgs,
      ...(process.platform === 'linux' ? ['--no-sandbox'] : [])],
  };
}

export const profileDir = () => {
  const dir = resolve(config.browser.profileDir);
  mkdirSync(dir, { recursive: true });
  return dir;
};

/**
 * If the engine was stopped while the browser was open, Chrome remembers an unclean exit and
 * offers to "Restore pages". Marking the profile as cleanly closed prevents that prompt.
 */
export function markCleanExit() {
  const file = join(profileDir(), 'Default', 'Preferences');
  if (!existsSync(file)) return;
  try {
    const prefs = JSON.parse(readFileSync(file, 'utf8'));
    prefs.profile = { ...prefs.profile, exit_type: 'Normal', exited_cleanly: true };
    writeFileSync(file, JSON.stringify(prefs));
  } catch { /* unreadable preferences: Chrome rebuilds them */ }
}

let users = 0;
let idleTimer: NodeJS.Timeout | null = null;

/** Runs work in the browser, and closes the browser once nothing has used it for a while. */
async function withBrowser<T>(fn: (c: BrowserContext) => Promise<T>): Promise<T> {
  if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
  users++;
  try {
    return await fn(await context());
  } finally {
    if (--users === 0) {
      idleTimer = setTimeout(() => { idleTimer = null; if (!users) void closeBrowser(); }, config.browser.idleSeconds * 1000);
      idleTimer.unref();
    }
  }
}

function context(): Promise<BrowserContext> {
  if (!ctx) {
    markCleanExit();
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
  ctx = null;
  await c?.close().catch(() => undefined);
}

/** Parses a JSON body even when it carries an anti-hijacking prefix such as `for (;;);`. */
export function looseJson(body: string): unknown {
  const start = body.search(/[{[]/);
  if (start < 0 || start > 20) return undefined;
  try { return JSON.parse(body.slice(start)); } catch { return undefined; }
}

/** Saves what the browser was showing, so a thin result can be diagnosed from one file. */
export async function saveDebug(page: Page, name: string, info: Record<string, unknown>): Promise<string | null> {
  if (config.dbPath === ':memory:') return null;
  try {
    const dir = join(dirname(resolve(config.dbPath)), 'debug');
    mkdirSync(dir, { recursive: true });
    const base = join(dir, name.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 60));
    await page.screenshot({ path: `${base}.png`, timeout: 10_000 }).catch(() => undefined);
    writeFileSync(`${base}.json`, JSON.stringify({ at: new Date().toISOString(), url: page.url(), title: await page.title().catch(() => ''), ...info }, null, 2));
    return `${base}.png`;
  } catch { return null; }
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
  /** Called with the live page after it loads, after every scroll, and once at the end. */
  onPage?: (page: Page, phase: 'loaded' | 'scrolled' | 'done') => Promise<void>;
  /** When this returns true at the end, a screenshot and summary are saved under data/debug. */
  thin?: (payloads: unknown[]) => boolean;
  debugName?: string;
  /** Page the visit appears to come from. */
  referer?: string;
}

export interface Captured { payloads: unknown[]; finalUrl: string; responses: string[] }

/**
 * Opens a page like a person would, scrolls it, and returns every JSON payload the site's
 * own code loaded. Parsers then read the payloads, so nothing depends on endpoint details.
 */
export function capture(opts: CaptureOptions): Promise<Captured> {
  return withBrowser((c) => captureIn(c, opts));
}

async function captureIn(c: BrowserContext, opts: CaptureOptions): Promise<Captured> {
  const page: Page = await c.newPage();
  const payloads: unknown[] = [];
  const responses: string[] = [];
  const pending = new Set<Promise<void>>();
  let limited = false;
  page.on('response', (res) => {
    const url = res.url();
    if (!opts.match(url)) return;
    if (responses.length < 200) responses.push(`${res.status()} ${url.slice(0, 160)}`);
    if (res.status() === 429) { limited = true; return; }
    // some sites label JSON as text/javascript and prefix it with a guard, so go by content, not by label
    const p = res.text().then((t) => { const j = looseJson(t); if (j !== undefined) payloads.push(j); }, () => undefined).finally(() => pending.delete(p));
    pending.add(p);
  });
  try {
    await page.goto(opts.url, { waitUntil: 'domcontentloaded', timeout: 45_000, referer: opts.referer }).catch((e: Error) => {
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
    try { await opts.onPage?.(page, 'loaded'); } catch (e) {
      if (opts.debugName) await saveDebug(page, opts.debugName, { error: (e as Error).message });
      throw e;
    }
    let idle = 0;
    for (let i = 0; i < opts.maxScrolls && !opts.enough(payloads) && !limited; i++) {
      const before = payloads.length;
      await page.mouse.move(rand(300, 900), rand(200, 600));
      await page.mouse.wheel(0, rand(1800, 3200));
      await sleep(rand(1600, 3400));
      await Promise.all(pending);
      check();
      await opts.onPage?.(page, 'scrolled');
      idle = payloads.length === before ? idle + 1 : 0;
      if (idle >= 3) break;
    }
    await Promise.all(pending);
    if (limited && !payloads.length) throw new ScrapeError('blocked', 'The platform is rate-limiting this account.');
    await opts.onPage?.(page, 'done');
    if (opts.debugName && opts.thin?.(payloads)) await saveDebug(page, opts.debugName, { payloads: payloads.length, responses });
    return { payloads, finalUrl: page.url(), responses };
  } finally {
    await page.close().catch(() => undefined);
  }
}

/**
 * Opens a JSON address as a normal page visit in the signed-in browser, exactly as if it
 * had been typed into the address bar, and returns what the site answered.
 */
export function visitJson(url: string, loginWall?: RegExp, debugName?: string): Promise<{ status: number; json: any; snippet: string }> {
  return withBrowser(async (c) => {
  const page = await c.newPage();
  try {
    const res = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 }).catch((e: Error) => {
      throw new ScrapeError('network', `Page did not load: ${e.message.split('\n')[0]}`);
    });
    if (loginWall?.test(page.url())) throw new ScrapeError('login_required', 'Not signed in.');
    const body = (await res?.text().catch(() => '')) || (await page.evaluate(() => document.body?.innerText ?? '').catch(() => ''));
    const json = looseJson(body) ?? null;
    if (!json && debugName) await saveDebug(page, debugName, { status: res?.status() ?? 0 });
    return { status: res?.status() ?? 0, json, snippet: body.replace(/<(style|script)[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 160) };
  } finally {
    await page.close().catch(() => undefined);
  }
  });
}

/** Whether the saved profile holds a given sign-in cookie. */
export function hasCookie(url: string, name: string): Promise<boolean> {
  return withBrowser(async (c) => (await c.cookies(url)).some((k) => k.name === name && !!k.value));
}
