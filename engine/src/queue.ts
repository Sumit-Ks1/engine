import { appendFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { config, PLATFORMS, type Platform } from './config.js';
import * as lanes from './lanes.js';
import { claimNextLookup, finishLookup, hasHandle, queueProfiles, setHandle, claimNext, claimNextProfile, completeJob, completeProfile, failJob, failProfile, getCompany, getKeyword, handleIs, jobExists, requeueStale, type HandleRow, type Job } from './db.js';
import { windowStart } from './insights.js';
import { PROFILE_PLATFORMS, classify, demoProfile, discoverHandles, profileScrapers, type ProfilePlatform } from './scrapers/profiles.js';
import { rank, scrapers } from './scrapers/index.js';
import { CancelledError, ScrapeError } from './types.js';

const running = new Map<string, Platform>();
let stopped = false;
let log: (msg: string) => void = () => {};
/** Failures only, one line each, so problems are easy to find. */
const errorLog = config.dbPath === ':memory:' ? null : join(dirname(config.dbPath), 'errors.log');
const recordError = (line: string) => { if (errorLog) { try { appendFileSync(errorLog, `${new Date().toISOString()} ${line}\n`); } catch { /* disk issue */ } } };

async function run(job: Job) {
  const kw = getKeyword(job.keyword_id);
  if (!kw) return;
  const label = `[${job.platform}] "${kw.term}"`;
  const started = Date.now();
  lanes.started(job.platform);
  // a removed keyword has no row any more: its queued jobs are gone, and work in progress stops at the next step
  const cancelled = () => !jobExists(job.keyword_id, job.platform);
  try {
    const items = await scrapers[job.platform](kw.term, { limit: config.resultLimit, log: (m) => log(`${label} ${m}`), cancelled });
    if (cancelled()) throw new CancelledError();
    const ranked = rank(items.filter((it) => /^https:\/\//.test(it.url)), config.resultLimit);
    completeJob(job, ranked);
    lanes.finished(job.platform);
    log(`${label} done: ${ranked.length} results in ${Date.now() - started}ms`);
  } catch (e) {
    if (e instanceof CancelledError || cancelled()) {
      lanes.finished(job.platform);
      log(`${label} stopped: keyword was removed`);
      return;
    }
    const err = e instanceof ScrapeError ? e : new ScrapeError('parse', (e as Error).message || String(e));
    // a login wall will not go away by retrying; everything else gets backed-off retries
    const account = lanes.ACCOUNT_PLATFORMS.includes(job.platform);
    const retry = err.kind !== 'login_required' && !(account && err.kind === 'blocked') && job.attempts + 1 < config.maxAttempts;
    failJob(job, err.message.slice(0, 500), err.kind, retry ? Date.now() + 60_000 * 2 ** job.attempts : null);
    lanes.finished(job.platform, err.kind, err.message);
    log(`${label} ${retry ? 'will retry' : 'failed'} (${err.kind}): ${err.message}`);
    recordError(`${label} ${err.kind}: ${err.message}`);
  }
}

/** Reads one company's official handle on one platform for the brand analysis. */
async function runProfile(row: HandleRow) {
  const label = `[profile ${row.platform}] ${getCompany(row.company_id)?.name ?? row.company_id} (${row.handle})`;
  const started = Date.now();
  const platform = row.platform as ProfilePlatform;
  lanes.started(row.platform);
  // the handle was removed or changed while it was being read
  const cancelled = () => !handleIs(row.company_id, row.platform, row.handle);
  const since = windowStart();
  try {
    const scraper = config.demoMode ? demoProfile : profileScrapers[platform];
    const { posts, meta } = await scraper(row.handle, { log: (m) => log(`${label} ${m}`), cancelled, since });
    if (cancelled()) throw new CancelledError();
    const kept = posts.filter((p) => /^https:\/\//.test(p.url) && p.publishedAt && Date.parse(p.publishedAt) >= since).map((p) => classify(p, platform));
    completeProfile(row, kept, meta);
    lanes.finished(row.platform);
    log(`${label} done: ${kept.length} posts in ${Date.now() - started}ms`);
  } catch (e) {
    if (e instanceof CancelledError || cancelled()) { lanes.finished(row.platform); log(`${label} stopped: handle was removed`); return; }
    const err = e instanceof ScrapeError ? e : new ScrapeError('parse', (e as Error).message || String(e));
    failProfile(row, err.message.slice(0, 500), err.kind);
    lanes.finished(row.platform, err.kind, err.message);
    log(`${label} failed (${err.kind}): ${err.message}`);
    recordError(`${label} ${err.kind}: ${err.message}`);
  }
}

const LABELS: Record<ProfilePlatform, string> = { youtube: 'YouTube', instagram: 'Instagram', twitter: 'X' };
let lookupRunning = false;

/** Reads a company's official accounts off its own website, then queues them for collection. */
async function runLookup(c: { id: number; name: string; website: string }) {
  const label = `[handles] ${c.name} (${c.website})`;
  try {
    const found = config.demoMode
      ? Object.fromEntries(PROFILE_PLATFORMS.map((p) => [p, p === 'youtube' ? `@sample${c.id}` : `sample${c.id}`]))
      : await discoverHandles(c.website, { cancelled: () => !getCompany(c.id) });
    const added: string[] = [];
    const missing: string[] = [];
    for (const p of PROFILE_PLATFORMS) {
      if (hasHandle(c.id, p)) continue; // a handle that is already saved is never replaced
      const handle = (found as Partial<Record<ProfilePlatform, string>>)[p];
      if (handle) { setHandle(c.id, p, handle, 'auto'); added.push(`${LABELS[p]} ${handle}`); } else missing.push(LABELS[p]);
    }
    if (added.length) queueProfiles(c.id);
    finishLookup(c.id, 'done', [added.length ? `Found on the website: ${added.join(', ')}.` : '', missing.length ? `No ${missing.join(' or ')} link on the website.` : ''].filter(Boolean).join(' '));
    log(`${label} found: ${added.join(', ') || 'nothing new'}${missing.length ? ` | not linked: ${missing.join(', ')}` : ''}`);
  } catch (e) {
    if (e instanceof CancelledError) return;
    finishLookup(c.id, 'failed', `The website could not be read: ${(e as Error).message}`);
    log(`${label} failed: ${(e as Error).message}`);
    recordError(`${label} ${(e as Error).message}`);
  }
}

function pump() {
  if (stopped) return;
  if (!lookupRunning) {
    const lookup = claimNextLookup();
    if (lookup) {
      lookupRunning = true;
      void runLookup(lookup).finally(() => { lookupRunning = false; pump(); });
    }
  }
  while (running.size < config.concurrency) {
    const counts = new Map<Platform, number>();
    for (const p of running.values()) counts.set(p, (counts.get(p) ?? 0) + 1);
    const busy = [...new Set([...[...counts].filter(([, n]) => n >= config.perPlatformConcurrency).map(([p]) => p), ...lanes.unavailable()])];
    // a brand-analysis run is started by a person, so it goes ahead of background keyword work
    const profile = claimNextProfile(busy);
    if (profile) {
      const key = `profile:${profile.company_id}:${profile.platform}`;
      running.set(key, profile.platform);
      void runProfile(profile).finally(() => { running.delete(key); pump(); });
      continue;
    }
    const job = claimNext(busy);
    if (!job) return;
    const key = `${job.keyword_id}:${job.platform}`;
    running.set(key, job.platform);
    void run(job).finally(() => { running.delete(key); pump(); });
  }
}

export function startQueue(logger: (msg: string) => void) {
  log = logger;
  stopped = false;
  const timers = [
    setInterval(pump, 2000),
    setInterval(() => {
      if (config.refreshHours <= 0) return; // automatic refresh is off unless explicitly enabled
      for (const p of PLATFORMS) {
        const n = requeueStale(p, Date.now() - config.refreshHours * 36e5);
        if (n) log(`scheduler: re-queued ${n} stale ${p} jobs`);
      }
    }, 60_000),
  ];
  pump();
  return {
    kick: pump,
    async stop() {
      stopped = true;
      timers.forEach(clearInterval);
      const deadline = Date.now() + 20_000;
      while (running.size && Date.now() < deadline) await new Promise((r) => setTimeout(r, 200));
    },
  };
}
