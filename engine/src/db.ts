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

const insKeyword = db.prepare(`INSERT INTO keywords (term, term_key, created_at) VALUES (?, ?, ?) ON CONFLICT(term_key) DO NOTHING`);
const insJob = db.prepare(`INSERT INTO jobs (keyword_id, platform, queued_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING`);

export function addKeywords(terms: string[]): { added: number; duplicates: number } {
  return tx(() => {
    let added = 0;
    const now = Date.now();
    for (const term of terms) {
      const r = insKeyword.run(term, term.toLowerCase(), now);
      if (!r.changes) continue;
      added++;
      for (const p of PLATFORMS) insJob.run(Number(r.lastInsertRowid), p, now);
    }
    return { added, duplicates: terms.length - added };
  });
}

export function listKeywords(search: string, limit: number, offset: number) {
  const like = `%${search.toLowerCase().replace(/[\\%_]/g, '\\$&')}%`;
  const total = (db.prepare(`SELECT COUNT(*) AS n FROM keywords WHERE term_key LIKE ? ESCAPE '\\'`).get(like) as { n: number }).n;
  const rows = db.prepare(`SELECT id, term, created_at FROM keywords WHERE term_key LIKE ? ESCAPE '\\' ORDER BY term_key LIMIT ? OFFSET ?`).all(like, limit, offset) as unknown as Keyword[];
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
export const deleteKeyword = (id: number) => db.prepare(`DELETE FROM keywords WHERE id = ?`).run(id).changes > 0;
export const deleteAllKeywords = () => Number(db.prepare(`DELETE FROM keywords`).run().changes);
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
  return { keywords, jobs: { queued: 0, running: 0, done: 0, failed: 0, ...byStatus } };
}
