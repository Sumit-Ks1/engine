import { readFileSync, existsSync } from 'node:fs';

const env = process.env;
const int = (k: string, d: number) => {
  const v = Number(env[k]);
  return Number.isFinite(v) && env[k] !== undefined && env[k] !== '' ? v : d;
};

export const PLATFORMS = ['youtube', 'instagram', 'twitter', 'reddit', 'pinterest', 'google'] as const;
export type Platform = (typeof PLATFORMS)[number];

function loadGateways(): Record<string, string[]> {
  const file = env.AWS_GATEWAYS_FILE;
  if (!file || !existsSync(file)) return {};
  const raw = JSON.parse(readFileSync(file, 'utf8')) as Record<string, string[]>;
  const out: Record<string, string[]> = {};
  for (const [host, urls] of Object.entries(raw)) out[host.toLowerCase()] = urls.map((u) => u.replace(/\/+$/, ''));
  return out;
}

export const config = {
  port: int('PORT', 4000),
  host: env.HOST || '127.0.0.1',
  apiKey: env.ENGINE_API_KEY || '',
  dbPath: env.DB_PATH || './data/engine.db',
  /** Results kept per keyword + platform. */
  resultLimit: int('RESULT_LIMIT', 100),
  /** Total scrape jobs running at once, and per platform. */
  concurrency: int('CONCURRENCY', 4),
  perPlatformConcurrency: int('PER_PLATFORM_CONCURRENCY', 1),
  maxAttempts: int('MAX_ATTEMPTS', 3),
  refreshHours: int('REFRESH_HOURS', 12),
  /** Signed-in platforms are paced slowly, so Instagram refreshes less often. */
  refreshHoursFor: {
    instagram: int('REFRESH_HOURS_INSTAGRAM', 48),
    twitter: int('REFRESH_HOURS_TWITTER', 24),
    reddit: int('REFRESH_HOURS_REDDIT', 24),
  } as Partial<Record<Platform, number>>,
  /** Seconds between two keywords on a signed-in platform (randomised +-40%). */
  accountGapSeconds: {
    instagram: int('GAP_SECONDS_INSTAGRAM', 60),
    twitter: int('GAP_SECONDS_TWITTER', 40),
    reddit: int('GAP_SECONDS_REDDIT', 12),
  } as Partial<Record<Platform, number>>,
  /** Keywords per day on a signed-in platform. */
  accountDailyCap: {
    instagram: int('DAILY_CAP_INSTAGRAM', 700),
    twitter: int('DAILY_CAP_TWITTER', 900),
    reddit: int('DAILY_CAP_REDDIT', 2000),
  } as Partial<Record<Platform, number>>,
  /** Hours a signed-in platform rests after it rate-limits or challenges the session. */
  accountCooldownHours: int('ACCOUNT_COOLDOWN_HOURS', 6),
  /** Candidates gathered per keyword before ranking down to resultLimit. */
  poolSize: int('POOL_SIZE', 300),
  browser: {
    profileDir: env.PROFILE_DIR || './data/browser-profile',
    /** Installed browser to drive: chrome | msedge. Ignored when BROWSER_PATH is set. */
    channel: env.BROWSER_CHANNEL || 'chrome',
    path: env.BROWSER_PATH || '',
    /** Hidden mode identifies itself as automated and gets blocked, so a normal window is the default. */
    headless: env.BROWSER_HEADLESS === '1',
    /** Keep the working window on screen instead of parking it off-screen. */
    visible: env.BROWSER_VISIBLE === '1',
  },
  /** Minimum gap between two requests to the same host (jitter is added). */
  hostMinIntervalMs: int('HOST_MIN_INTERVAL_MS', 1200),
  requestTimeoutMs: int('REQUEST_TIMEOUT_MS', 25000),
  requestRetries: int('REQUEST_RETRIES', 3),
  /** Region / language used for regional result pages. */
  region: (env.REGION || 'IN').toUpperCase(),
  lang: (env.LANG_CODE || 'en').toLowerCase(),
  /** How many top YouTube videos get an extra page fetch for likes/comments. */
  youtubeEnrichTop: int('YOUTUBE_ENRICH_TOP', 30),
  /** How many Instagram posts per keyword get an extra lookup when the results grid carries no numbers. */
  instagramEnrichTop: int('INSTAGRAM_ENRICH_TOP', 40),
  /** Rotating egress: plain proxies and/or AWS API Gateway endpoints per host. */
  proxyUrls: (env.PROXY_URLS || '').split(',').map((s) => s.trim()).filter(Boolean),
  gateways: loadGateways(),
  /** Optional Reddit developer app (reddit.com/prefs/apps, type "script"). When set, Reddit uses the official API. */
  reddit: { clientId: env.REDDIT_CLIENT_ID || '', clientSecret: env.REDDIT_CLIENT_SECRET || '' },
  /** Generates clearly-labelled sample data instead of scraping. Never enable in production. */
  demoMode: env.DEMO_MODE === '1',
};
