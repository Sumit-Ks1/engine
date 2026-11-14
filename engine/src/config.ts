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
  /** Minimum gap between two requests to the same host (jitter is added). */
  hostMinIntervalMs: int('HOST_MIN_INTERVAL_MS', 1200),
  requestTimeoutMs: int('REQUEST_TIMEOUT_MS', 25000),
  requestRetries: int('REQUEST_RETRIES', 3),
  /** Region / language used for regional result pages. */
  region: (env.REGION || 'IN').toUpperCase(),
  lang: (env.LANG_CODE || 'en').toLowerCase(),
  /** How many top YouTube videos get an extra page fetch for likes/comments. */
  youtubeEnrichTop: int('YOUTUBE_ENRICH_TOP', 30),
  /** Rotating egress: plain proxies and/or AWS API Gateway endpoints per host. */
  proxyUrls: (env.PROXY_URLS || '').split(',').map((s) => s.trim()).filter(Boolean),
  gateways: loadGateways(),
  /** Generates clearly-labelled sample data instead of scraping. Never enable in production. */
  demoMode: env.DEMO_MODE === '1',
};
