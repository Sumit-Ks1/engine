import { config, type Platform } from './config.js';
import { claimNext, completeJob, failJob, getKeyword, requeueStale, type Job } from './db.js';
import { rank, scrapers } from './scrapers/index.js';
import { ScrapeError } from './types.js';

const running = new Map<string, Platform>();
let stopped = false;
let log: (msg: string) => void = () => {};

async function run(job: Job) {
  const kw = getKeyword(job.keyword_id);
  if (!kw) return;
  const label = `[${job.platform}] "${kw.term}"`;
  const started = Date.now();
  try {
    const items = await scrapers[job.platform](kw.term, { limit: config.resultLimit, log: (m) => log(`${label} ${m}`) });
    const ranked = rank(items.filter((it) => /^https:\/\//.test(it.url)), config.resultLimit);
    completeJob(job, ranked);
    log(`${label} done: ${ranked.length} results in ${Date.now() - started}ms`);
  } catch (e) {
    const err = e instanceof ScrapeError ? e : new ScrapeError('parse', (e as Error).message || String(e));
    // a login wall will not go away by retrying; everything else gets backed-off retries
    const retry = err.kind !== 'login_required' && job.attempts + 1 < config.maxAttempts;
    failJob(job, err.message.slice(0, 500), err.kind, retry ? Date.now() + 60_000 * 2 ** job.attempts : null);
    log(`${label} ${retry ? 'will retry' : 'failed'} (${err.kind}): ${err.message}`);
  }
}

function pump() {
  if (stopped) return;
  while (running.size < config.concurrency) {
    const counts = new Map<Platform, number>();
    for (const p of running.values()) counts.set(p, (counts.get(p) ?? 0) + 1);
    const busy = [...counts].filter(([, n]) => n >= config.perPlatformConcurrency).map(([p]) => p);
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
      const n = requeueStale(Date.now() - config.refreshHours * 36e5);
      if (n) log(`scheduler: re-queued ${n} stale jobs`);
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
