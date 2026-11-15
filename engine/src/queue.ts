import { appendFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { config, PLATFORMS, type Platform } from './config.js';
import * as lanes from './lanes.js';
import { claimNext, completeJob, failJob, getKeyword, requeueStale, type Job } from './db.js';
import { rank, scrapers } from './scrapers/index.js';
import { ScrapeError } from './types.js';

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
  try {
    const items = await scrapers[job.platform](kw.term, { limit: config.resultLimit, log: (m) => log(`${label} ${m}`) });
    const ranked = rank(items.filter((it) => /^https:\/\//.test(it.url)), config.resultLimit);
    completeJob(job, ranked);
    lanes.finished(job.platform);
    log(`${label} done: ${ranked.length} results in ${Date.now() - started}ms`);
  } catch (e) {
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

function pump() {
  if (stopped) return;
  while (running.size < config.concurrency) {
    const counts = new Map<Platform, number>();
    for (const p of running.values()) counts.set(p, (counts.get(p) ?? 0) + 1);
    const busy = [...new Set([...[...counts].filter(([, n]) => n >= config.perPlatformConcurrency).map(([p]) => p), ...lanes.unavailable()])];
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
      for (const p of PLATFORMS) {
        const n = requeueStale(p, Date.now() - (config.refreshHoursFor[p] ?? config.refreshHours) * 36e5);
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
