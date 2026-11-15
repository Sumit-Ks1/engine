import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { config, PLATFORMS, type Platform } from './config.js';
import type { Item } from './types.js';

if (config.dbPath !== ':memory:') mkdirSync(dirname(config.dbPath), { recursive: true });
export const db = new DatabaseSync(config.dbPath);
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;
  PRAGMA busy_timeout = 5000;
  CREATE TABLE IF NOT EXISTS keywords (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    term TEXT NOT NULL,
    term_key TEXT NOT NULL UNIQUE,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS jobs (
    keyword_id INTEGER NOT NULL REFERENCES keywords(id) ON DELETE CASCADE,
    platform TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'queued',      -- queued | running | done | failed
    priority INTEGER NOT NULL DEFAULT 0,
    attempts INTEGER NOT NULL DEFAULT 0,
    run_after INTEGER NOT NULL DEFAULT 0,
    queued_at INTEGER NOT NULL,
    finished_at INTEGER,
    fetched_at INTEGER,                         -- last time results were stored
    result_count INTEGER NOT NULL DEFAULT 0,
    error TEXT,
    error_kind TEXT,
    PRIMARY KEY (keyword_id, platform)
  );
  CREATE INDEX IF NOT EXISTS jobs_pick ON jobs(status, priority DESC, queued_at);
  CREATE TABLE IF NOT EXISTS results (
    keyword_id INTEGER NOT NULL REFERENCES keywords(id) ON DELETE CASCADE,
    platform TEXT NOT NULL,
    rank INTEGER NOT NULL,
    data TEXT NOT NULL,
    PRIMARY KEY (keyword_id, platform, rank)
  );
  CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS companies (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    name_key TEXT NOT NULL UNIQUE,
    created_at INTEGER NOT NULL
  );
  -- A company is only a folder. A keyword is collected once even if several companies list it.
  CREATE TABLE IF NOT EXISTS company_keywords (
    company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    keyword_id INTEGER NOT NULL REFERENCES keywords(id) ON DELETE CASCADE,
    position INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (company_id, keyword_id)
  );
  CREATE INDEX IF NOT EXISTS company_keywords_kw ON company_keywords(keyword_id);
`);
// jobs interrupted by a restart go back in the queue
db.prepare(`UPDATE jobs SET status = 'queued' WHERE status = 'running'`).run();

export const kvGet = (k: string) => (db.prepare(`SELECT v FROM kv WHERE k = ?`).get(k) as { v: string } | undefined)?.v || undefined;
export const kvSet = (k: string, v: string) => { db.prepare(`INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v`).run(k, v); };

export interface Job {
  keyword_id: number; platform: Platform; status: 'queued' | 'running' | 'done' | 'failed';
  priority: number; attempts: number; run_after: number; queued_at: number;
  finished_at: number | null; fetched_at: number | null; result_count: number;
  error: string | null; error_kind: string | null;
}
export interface Keyword { id: number; term: string; created_at: number }

const tx = <T>(fn: () => T): T => {
  db.exec('BEGIN IMMEDIATE');
  try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; }
};

const DEFAULT_COMPANIES = ['Flo Mattress', 'The Sleep Company', 'Sleepyhead', 'WakeFit', 'Duroflex', 'Sleepycat', 'Sunday', 'Peps', 'Springfit', 'Century Mattress', 'Sleepwell', 'Kurlon'];
const insCompany = db.prepare(`INSERT INTO companies (name, name_key, created_at) VALUES (?, ?, ?) ON CONFLICT(name_key) DO NOTHING`);
const insKeyword = db.prepare(`INSERT INTO keywords (term, term_key, created_at) VALUES (?, ?, ?) ON CONFLICT(term_key) DO NOTHING`);
const insJob = db.prepare(`INSERT INTO jobs (keyword_id, platform, queued_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING`);
const insLink = db.prepare(`INSERT INTO company_keywords (company_id, keyword_id, position) VALUES (?, ?, ?) ON CONFLICT DO NOTHING`);

// first run: create the starting company list; keywords from before companies existed go under "General"
if (!db.prepare(`SELECT v FROM kv WHERE k = 'companies_seeded'`).get()) {
  tx(() => {
    const now = Date.now();
    for (const name of DEFAULT_COMPANIES) insCompany.run(name, name.toLowerCase(), now);
    const orphans = db.prepare(`SELECT id FROM keywords WHERE id NOT IN (SELECT keyword_id FROM company_keywords) ORDER BY id`).all() as { id: number }[];
    if (orphans.length) {
      insCompany.run('General', 'general', now);
      const general = (db.prepare(`SELECT id FROM companies WHERE name_key = 'general'`).get() as { id: number }).id;
      orphans.forEach((o, i) => insLink.run(general, o.id, i));
    }
    db.prepare(`INSERT INTO kv (k, v) VALUES ('companies_seeded', '1')`).run();
  });
}

export interface Company { id: number; name: string; created_at: number }

export function listCompanies() {
  return db.prepare(`
    SELECT c.id, c.name, c.created_at,
      (SELECT COUNT(*) FROM company_keywords ck WHERE ck.company_id = c.id) AS keywords,
      (SELECT COUNT(*) FROM jobs j JOIN company_keywords ck ON ck.keyword_id = j.keyword_id WHERE ck.company_id = c.id) AS jobs,
      (SELECT COUNT(*) FROM jobs j JOIN company_keywords ck ON ck.keyword_id = j.keyword_id WHERE ck.company_id = c.id AND j.status IN ('done', 'failed')) AS finished,
      (SELECT COUNT(*) FROM jobs j JOIN company_keywords ck ON ck.keyword_id = j.keyword_id WHERE ck.company_id = c.id AND j.status = 'failed') AS failed
    FROM companies c ORDER BY c.id`).all() as unknown as (Company & { keywords: number; jobs: number; finished: number; failed: number })[];
}

export const getCompany = (id: number) => db.prepare(`SELECT id, name, created_at FROM companies WHERE id = ?`).get(id) as unknown as Company | undefined;

export function addCompany(name: string): Company | null {
  const r = insCompany.run(name, name.toLowerCase(), Date.now());
  return r.changes ? getCompany(Number(r.lastInsertRowid))! : null;
}

const dropOrphanKeywords = () => db.prepare(`DELETE FROM keywords WHERE id NOT IN (SELECT keyword_id FROM company_keywords)`).run();

export function deleteCompany(id: number) {
  return tx(() => {
    const ok = db.prepare(`DELETE FROM companies WHERE id = ?`).run(id).changes > 0;
    if (ok) dropOrphanKeywords();
    return ok;
  });
}

/** Adds keywords to a company. A keyword another company already has is linked, not collected twice. */
export function addKeywords(companyId: number, terms: string[]): { added: number; duplicates: number } {
  return tx(() => {
    let added = 0;
    const now = Date.now();
    let position = (db.prepare(`SELECT COALESCE(MAX(position), -1) AS p FROM company_keywords WHERE company_id = ?`).get(companyId) as { p: number }).p;
    const find = db.prepare(`SELECT id FROM keywords WHERE term_key = ?`);
    for (const term of terms) {
      const r = insKeyword.run(term, term.toLowerCase(), now);
      const keywordId = r.changes ? Number(r.lastInsertRowid) : (find.get(term.toLowerCase()) as { id: number }).id;
      if (r.changes) for (const p of PLATFORMS) insJob.run(keywordId, p, now);
      if (insLink.run(companyId, keywordId, ++position).changes) added++;
    }
    return { added, duplicates: terms.length - added };
  });
}

export function removeKeyword(companyId: number, keywordId: number) {
  return tx(() => {
    const ok = db.prepare(`DELETE FROM company_keywords WHERE company_id = ? AND keyword_id = ?`).run(companyId, keywordId).changes > 0;
    if (ok) dropOrphanKeywords();
    return ok;
  });
}

export function listKeywords(companyId: number, search: string, limit: number, offset: number) {
  const like = `%${search.toLowerCase().replace(/[\\%_]/g, '\\$&')}%`;
  const where = `FROM keywords k JOIN company_keywords ck ON ck.keyword_id = k.id WHERE ck.company_id = ? AND k.term_key LIKE ? ESCAPE '\\'`;
  const total = (db.prepare(`SELECT COUNT(*) AS n ${where}`).get(companyId, like) as { n: number }).n;
  const rows = db.prepare(`SELECT k.id, k.term, k.created_at ${where} ORDER BY ck.position, k.id LIMIT ? OFFSET ?`).all(companyId, like, limit, offset) as unknown as Keyword[];
  const jobsFor = db.prepare(`SELECT platform, status, result_count, fetched_at, error_kind FROM jobs WHERE keyword_id = ?`);
  return {
    total,
    keywords: rows.map((k) => ({
      ...k,
      platforms: Object.fromEntries((jobsFor.all(k.id) as any[]).map((j) => [j.platform, { status: j.status, count: j.result_count, fetchedAt: j.fetched_at, errorKind: j.error_kind }])),
    })),
  };
}

export const getKeyword = (id: number) => db.prepare(`SELECT id, term, created_at FROM keywords WHERE id = ?`).get(id) as unknown as Keyword | undefined;
export const getJobs = (keywordId: number) => db.prepare(`SELECT * FROM jobs WHERE keyword_id = ?`).all(keywordId) as unknown as Job[];

export function getResults(keywordId: number, platform: Platform): Item[] {
  const rows = db.prepare(`SELECT data FROM results WHERE keyword_id = ? AND platform = ? ORDER BY rank`).all(keywordId, platform) as { data: string }[];
  return rows.map((r) => JSON.parse(r.data));
}

/** Puts a job at the front of the queue (user asked for it). Running jobs are left alone. */
export function requeue(keywordId: number, platform?: Platform) {
  const now = Date.now();
  return Number(db.prepare(
    `UPDATE jobs SET status = 'queued', priority = 10, attempts = 0, run_after = 0, queued_at = ?
     WHERE keyword_id = ? AND status != 'running' AND (? IS NULL OR platform = ?)`,
  ).run(now, keywordId, platform ?? null, platform ?? null).changes);
}

/** Re-queues everything whose last run is older than the refresh interval. */
export function requeueStale(platform: Platform, olderThan: number) {
  return Number(db.prepare(
    `UPDATE jobs SET status = 'queued', priority = 0, attempts = 0, run_after = 0, queued_at = ?
     WHERE platform = ? AND status IN ('done', 'failed') AND finished_at < ?`,
  ).run(Date.now(), platform, olderThan).changes);
}

/** Failed jobs of one platform go back in the queue (used when a paused platform resumes). */
export function requeueFailed(platform: Platform) {
  return Number(db.prepare(`UPDATE jobs SET status = 'queued', attempts = 0, run_after = 0, queued_at = ? WHERE platform = ? AND status = 'failed'`).run(Date.now(), platform).changes);
}

export function claimNext(busyPlatforms: Platform[]): Job | undefined {
  return tx(() => {
    const skip = busyPlatforms.length ? `AND platform NOT IN (${busyPlatforms.map(() => '?').join(',')})` : '';
    const job = db.prepare(
      `SELECT * FROM jobs WHERE status = 'queued' AND run_after <= ? ${skip} ORDER BY priority DESC, queued_at, keyword_id LIMIT 1`,
    ).get(Date.now(), ...busyPlatforms) as unknown as Job | undefined;
    if (job) db.prepare(`UPDATE jobs SET status = 'running' WHERE keyword_id = ? AND platform = ?`).run(job.keyword_id, job.platform);
    return job;
  });
}

export function completeJob(job: Job, items: Item[]) {
  tx(() => {
    const now = Date.now();
    // an empty run never wipes results we already have
    if (items.length) {
      db.prepare(`DELETE FROM results WHERE keyword_id = ? AND platform = ?`).run(job.keyword_id, job.platform);
      const ins = db.prepare(`INSERT INTO results (keyword_id, platform, rank, data) VALUES (?, ?, ?, ?)`);
      items.forEach((it, i) => ins.run(job.keyword_id, job.platform, i + 1, JSON.stringify(it)));
      db.prepare(`UPDATE jobs SET result_count = ?, fetched_at = ? WHERE keyword_id = ? AND platform = ?`).run(items.length, now, job.keyword_id, job.platform);
    }
    db.prepare(
      `UPDATE jobs SET status = 'done', priority = 0, attempts = 0, finished_at = ?, error = ?, error_kind = NULL WHERE keyword_id = ? AND platform = ?`,
    ).run(now, items.length ? null : 'No results found for this keyword', job.keyword_id, job.platform);
  });
}

export function failJob(job: Job, error: string, kind: string, retryAt: number | null) {
  if (retryAt) {
    db.prepare(`UPDATE jobs SET status = 'queued', attempts = attempts + 1, run_after = ?, error = ?, error_kind = ? WHERE keyword_id = ? AND platform = ?`)
      .run(retryAt, error, kind, job.keyword_id, job.platform);
  } else {
    db.prepare(`UPDATE jobs SET status = 'failed', priority = 0, attempts = attempts + 1, finished_at = ?, error = ?, error_kind = ? WHERE keyword_id = ? AND platform = ?`)
      .run(Date.now(), error, kind, job.keyword_id, job.platform);
  }
}

export function stats() {
  const byStatus = Object.fromEntries((db.prepare(`SELECT status, COUNT(*) AS n FROM jobs GROUP BY status`).all() as any[]).map((r) => [r.status, r.n]));
  const keywords = (db.prepare(`SELECT COUNT(*) AS n FROM keywords`).get() as { n: number }).n;
  const companies = (db.prepare(`SELECT COUNT(*) AS n FROM companies`).get() as { n: number }).n;
  return { companies, keywords, jobs: { queued: 0, running: 0, done: 0, failed: 0, ...byStatus } };
}
