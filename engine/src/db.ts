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
  -- Brand analysis: one official handle per company and platform, its collection state, and its posts.
  CREATE TABLE IF NOT EXISTS handles (
    company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    platform TEXT NOT NULL,
    handle TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'idle',        -- idle | queued | running | done | failed
    queued_at INTEGER,
    fetched_at INTEGER,
    error TEXT,
    error_kind TEXT,
    meta TEXT NOT NULL DEFAULT '{}',
    PRIMARY KEY (company_id, platform)
  );
  CREATE TABLE IF NOT EXISTS profile_posts (
    company_id INTEGER NOT NULL,
    platform TEXT NOT NULL,
    url TEXT NOT NULL,
    published_at INTEGER,
    data TEXT NOT NULL,
    PRIMARY KEY (company_id, platform, url),
    FOREIGN KEY (company_id, platform) REFERENCES handles(company_id, platform) ON DELETE CASCADE
  );
`);
// jobs interrupted by a restart go back in the queue
db.prepare(`UPDATE jobs SET status = 'queued' WHERE status = 'running'`).run();
db.prepare(`UPDATE handles SET status = 'queued' WHERE status = 'running'`).run();

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

// brand analysis: each company's own website (where its official accounts are read from) and the lookup state
{
  const cols = (table: string) => (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name);
  if (!cols('companies').includes('website')) {
    db.exec(`ALTER TABLE companies ADD COLUMN website TEXT NOT NULL DEFAULT '';
             ALTER TABLE companies ADD COLUMN lookup_state TEXT NOT NULL DEFAULT '';
             ALTER TABLE companies ADD COLUMN lookup_note TEXT NOT NULL DEFAULT '';`);
  }
  if (!cols('handles').includes('source')) db.exec(`ALTER TABLE handles ADD COLUMN source TEXT NOT NULL DEFAULT 'manual'`);
  db.prepare(`UPDATE companies SET lookup_state = 'queued' WHERE lookup_state = 'running'`).run();
}

// which platforms a company wants for a keyword ('' = all six)
if (!(db.prepare(`PRAGMA table_info(company_keywords)`).all() as { name: string }[]).some((c) => c.name === 'platforms')) {
  db.exec(`ALTER TABLE company_keywords ADD COLUMN platforms TEXT NOT NULL DEFAULT ''`);
}
const encodePlatforms = (list: Platform[]) => { const set = PLATFORMS.filter((p) => list.includes(p)); return set.length === PLATFORMS.length ? '' : set.join(','); };
const decodePlatforms = (v: string): Platform[] => (v ? PLATFORMS.filter((p) => v.split(',').includes(p)) : [...PLATFORMS]);

// keywords are case sensitive ("Wakefit" and "wakefit" are two keywords); older databases stored a lowercased key
if (!db.prepare(`SELECT v FROM kv WHERE k = 'keywords_case_sensitive'`).get()) {
  db.exec(`UPDATE keywords SET term_key = term; INSERT INTO kv (k, v) VALUES ('keywords_case_sensitive', '1');`);
}

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

// websites of the starting companies; filled in once, editable afterwards
const DEFAULT_WEBSITES: Record<string, string> = {
  'flo mattress': 'https://www.flomattress.com/', 'the sleep company': 'https://thesleepcompany.in/', sleepyhead: 'https://mysleepyhead.com/',
  wakefit: 'https://www.wakefit.co/', duroflex: 'https://www.duroflexworld.com/', sleepycat: 'https://sleepycat.in/', sunday: 'https://sundayrest.com/',
  peps: 'https://pepsindia.com/', springfit: 'https://www.springfit.com/', 'century mattress': 'https://www.centuryindia.com/',
  sleepwell: 'https://mysleepwell.com/', kurlon: 'https://www.kurlon.com/',
};
if (!db.prepare(`SELECT v FROM kv WHERE k = 'websites_seeded'`).get()) {
  const set = db.prepare(`UPDATE companies SET website = ? WHERE name_key = ? AND website = ''`);
  for (const [key, site] of Object.entries(DEFAULT_WEBSITES)) set.run(site, key);
  db.prepare(`INSERT INTO kv (k, v) VALUES ('websites_seeded', '1')`).run();
}

export interface Company { id: number; name: string; created_at: number }

export function listCompanies() {
  const companies = db.prepare(`SELECT id, name, created_at, website, lookup_state, lookup_note FROM companies ORDER BY id`).all() as unknown as (Company & { website: string; lookup_state: string; lookup_note: string })[];
  const rows = db.prepare(`
    SELECT ck.company_id, ck.keyword_id, ck.platforms, j.platform, j.status
    FROM company_keywords ck LEFT JOIN jobs j ON j.keyword_id = ck.keyword_id`).all() as { company_id: number; keyword_id: number; platforms: string; platform: Platform | null; status: string }[];
  const agg = new Map<number, { keywords: Set<number>; jobs: number; finished: number; failed: number }>();
  for (const r of rows) {
    const a = agg.get(r.company_id) ?? { keywords: new Set<number>(), jobs: 0, finished: 0, failed: 0 };
    agg.set(r.company_id, a);
    a.keywords.add(r.keyword_id);
    // only the platforms this company asked for count towards its progress
    if (!r.platform || !decodePlatforms(r.platforms).includes(r.platform)) continue;
    a.jobs++;
    if (r.status === 'done' || r.status === 'failed') a.finished++;
    if (r.status === 'failed') a.failed++;
  }
  return companies.map((c) => {
    const a = agg.get(c.id);
    return { ...c, keywords: a?.keywords.size ?? 0, jobs: a?.jobs ?? 0, finished: a?.finished ?? 0, failed: a?.failed ?? 0 };
  });
}

export const getCompany = (id: number) => db.prepare(`SELECT id, name, created_at FROM companies WHERE id = ?`).get(id) as unknown as Company | undefined;

export function addCompany(name: string): Company | null {
  const r = insCompany.run(name, name.toLowerCase(), Date.now());
  return r.changes ? getCompany(Number(r.lastInsertRowid))! : null;
}

/**
 * After links are removed: keywords nobody lists are deleted, and platforms nobody asks for
 * any more are dropped from the keywords that remain.
 */
function cleanUp(keywordIds: number[]) {
  db.prepare(`DELETE FROM keywords WHERE id NOT IN (SELECT keyword_id FROM company_keywords)`).run();
  const links = db.prepare(`SELECT platforms FROM company_keywords WHERE keyword_id = ?`);
  for (const id of keywordIds) {
    const wanted = new Set((links.all(id) as { platforms: string }[]).flatMap((l) => decodePlatforms(l.platforms)));
    if (!wanted.size || wanted.size === PLATFORMS.length) continue;
    for (const p of PLATFORMS) {
      if (wanted.has(p)) continue;
      db.prepare(`DELETE FROM jobs WHERE keyword_id = ? AND platform = ?`).run(id, p);
      db.prepare(`DELETE FROM results WHERE keyword_id = ? AND platform = ?`).run(id, p);
    }
  }
}
const keywordIdsOf = (companyId: number) => (db.prepare(`SELECT keyword_id FROM company_keywords WHERE company_id = ?`).all(companyId) as { keyword_id: number }[]).map((r) => r.keyword_id);

export function deleteCompany(id: number) {
  return tx(() => {
    const ids = keywordIdsOf(id);
    const ok = db.prepare(`DELETE FROM companies WHERE id = ?`).run(id).changes > 0;
    if (ok) cleanUp(ids);
    return ok;
  });
}

export interface KeywordEntry { term: string; platforms: Platform[] }

/**
 * Adds keywords to a company, each for the platforms given. A keyword another company already
 * has is linked, not collected twice; only platforms not yet collected for it are queued.
 */
export function addKeywords(companyId: number, entries: KeywordEntry[]): { added: number; duplicates: number } {
  return tx(() => {
    let added = 0;
    const now = Date.now();
    let position = (db.prepare(`SELECT COALESCE(MAX(position), -1) AS p FROM company_keywords WHERE company_id = ?`).get(companyId) as { p: number }).p;
    const find = db.prepare(`SELECT id FROM keywords WHERE term_key = ?`);
    const link = db.prepare(`SELECT platforms FROM company_keywords WHERE company_id = ? AND keyword_id = ?`);
    const setLink = db.prepare(`UPDATE company_keywords SET platforms = ? WHERE company_id = ? AND keyword_id = ?`);
    for (const { term, platforms } of entries) {
      const r = insKeyword.run(term, term, now);
      const keywordId = r.changes ? Number(r.lastInsertRowid) : (find.get(term) as { id: number }).id;
      for (const p of platforms) insJob.run(keywordId, p, now);
      const existing = link.get(companyId, keywordId) as { platforms: string } | undefined;
      if (!existing) {
        insLink.run(companyId, keywordId, ++position);
        setLink.run(encodePlatforms(platforms), companyId, keywordId);
        added++;
      } else {
        // already listed: adding it for more platforms widens it
        const merged = encodePlatforms([...decodePlatforms(existing.platforms), ...platforms]);
        if (merged !== existing.platforms) { setLink.run(merged, companyId, keywordId); added++; }
      }
    }
    return { added, duplicates: entries.length - added };
  });
}

export function removeKeyword(companyId: number, keywordId: number) {
  return tx(() => {
    const ok = db.prepare(`DELETE FROM company_keywords WHERE company_id = ? AND keyword_id = ?`).run(companyId, keywordId).changes > 0;
    if (ok) cleanUp([keywordId]);
    return ok;
  });
}

/** Removes several keywords from a company at once; `ids = null` removes every keyword of the company. */
export function removeKeywords(companyId: number, ids: number[] | null): number {
  return tx(() => {
    const target = ids ?? keywordIdsOf(companyId);
    let removed = 0;
    const del = db.prepare(`DELETE FROM company_keywords WHERE company_id = ? AND keyword_id = ?`);
    for (const id of target) removed += Number(del.run(companyId, id).changes);
    if (removed) cleanUp(target);
    return removed;
  });
}

/** Platforms a company asked for on a keyword (null when the company does not list it). */
export function linkedPlatforms(companyId: number, keywordId: number): Platform[] | null {
  const row = db.prepare(`SELECT platforms FROM company_keywords WHERE company_id = ? AND keyword_id = ?`).get(companyId, keywordId) as { platforms: string } | undefined;
  return row ? decodePlatforms(row.platforms) : null;
}

export const jobExists = (keywordId: number, platform: Platform) => !!db.prepare(`SELECT 1 FROM jobs WHERE keyword_id = ? AND platform = ?`).get(keywordId, platform);

export function listKeywords(companyId: number, search: string, limit: number, offset: number) {
  const like = `%${search.replace(/[\\%_]/g, '\\$&')}%`;
  const where = `FROM keywords k JOIN company_keywords ck ON ck.keyword_id = k.id WHERE ck.company_id = ? AND k.term LIKE ? ESCAPE '\\'`;
  const total = (db.prepare(`SELECT COUNT(*) AS n ${where}`).get(companyId, like) as { n: number }).n;
  const rows = db.prepare(`SELECT k.id, k.term, k.created_at, ck.platforms AS wanted ${where} ORDER BY ck.position, k.id LIMIT ? OFFSET ?`).all(companyId, like, limit, offset) as unknown as (Keyword & { wanted: string })[];
  const jobsFor = db.prepare(`SELECT platform, status, result_count, fetched_at, error_kind FROM jobs WHERE keyword_id = ?`);
  return {
    total,
    keywords: rows.map(({ wanted, ...k }) => ({
      ...k,
      platforms: Object.fromEntries((jobsFor.all(k.id) as any[]).filter((j) => decodePlatforms(wanted).includes(j.platform)).map((j) => [j.platform, { status: j.status, count: j.result_count, fetchedAt: j.fetched_at, errorKind: j.error_kind }])),
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

// ---------------------------------------------------------------- brand analysis

export interface HandleRow {
  company_id: number; platform: Platform; handle: string; status: 'idle' | 'queued' | 'running' | 'done' | 'failed';
  queued_at: number | null; fetched_at: number | null; error: string | null; error_kind: string | null; meta: string;
}

export const listHandles = () => db.prepare(`SELECT * FROM handles ORDER BY company_id, platform`).all() as unknown as HandleRow[];

/** Sets (or, with an empty value, clears) a company's handle on a platform. A changed handle drops the old posts. */
export function setHandle(companyId: number, platform: Platform, handle: string | null, source: 'manual' | 'auto' = 'manual') {
  tx(() => {
    const cur = db.prepare(`SELECT handle FROM handles WHERE company_id = ? AND platform = ?`).get(companyId, platform) as { handle: string } | undefined;
    if (cur?.handle === handle) return;
    db.prepare(`DELETE FROM handles WHERE company_id = ? AND platform = ?`).run(companyId, platform);
    if (handle) db.prepare(`INSERT INTO handles (company_id, platform, handle, source) VALUES (?, ?, ?, ?)`).run(companyId, platform, handle, source);
  });
}

/** Queues collection for every saved handle (of one company, or all). Handles already running are left alone. */
export function queueProfiles(companyId: number | null) {
  return Number(db.prepare(`UPDATE handles SET status = 'queued', queued_at = ?, error = NULL, error_kind = NULL WHERE status != 'running' AND (? IS NULL OR company_id = ?)`)
    .run(Date.now(), companyId, companyId).changes);
}

export function cancelProfiles() {
  return Number(db.prepare(`UPDATE handles SET status = CASE WHEN fetched_at IS NULL THEN 'idle' ELSE 'done' END WHERE status = 'queued'`).run().changes);
}

export function claimNextProfile(busyPlatforms: Platform[]): HandleRow | undefined {
  return tx(() => {
    const skip = busyPlatforms.length ? `AND platform NOT IN (${busyPlatforms.map(() => '?').join(',')})` : '';
    const row = db.prepare(`SELECT * FROM handles WHERE status = 'queued' ${skip} ORDER BY queued_at, company_id LIMIT 1`).get(...busyPlatforms) as unknown as HandleRow | undefined;
    if (row) db.prepare(`UPDATE handles SET status = 'running' WHERE company_id = ? AND platform = ?`).run(row.company_id, row.platform);
    return row;
  });
}

export const handleIs = (companyId: number, platform: Platform, handle: string) =>
  !!db.prepare(`SELECT 1 FROM handles WHERE company_id = ? AND platform = ? AND handle = ?`).get(companyId, platform, handle);

export function completeProfile(row: HandleRow, posts: (Item & { format: string; category: string })[], meta: object) {
  tx(() => {
    // a run that read nothing never wipes what an earlier run stored
    if (posts.length) {
      db.prepare(`DELETE FROM profile_posts WHERE company_id = ? AND platform = ?`).run(row.company_id, row.platform);
      const ins = db.prepare(`INSERT OR REPLACE INTO profile_posts (company_id, platform, url, published_at, data) VALUES (?, ?, ?, ?, ?)`);
      for (const p of posts) ins.run(row.company_id, row.platform, p.url, p.publishedAt ? Date.parse(p.publishedAt) : null, JSON.stringify(p));
    }
    db.prepare(`UPDATE handles SET status = 'done', fetched_at = ?, error = ?, error_kind = NULL, meta = ? WHERE company_id = ? AND platform = ?`)
      .run(Date.now(), posts.length ? null : 'No posts from the last months were found on this account.', JSON.stringify(meta), row.company_id, row.platform);
  });
}

export function failProfile(row: HandleRow, error: string, kind: string) {
  db.prepare(`UPDATE handles SET status = 'failed', error = ?, error_kind = ? WHERE company_id = ? AND platform = ?`).run(error, kind, row.company_id, row.platform);
}

export function profilePosts(companyId: number | null, platform: Platform | null, since: number) {
  const rows = db.prepare(`SELECT company_id, platform, data FROM profile_posts WHERE (? IS NULL OR company_id = ?) AND (? IS NULL OR platform = ?) AND published_at >= ?`)
    .all(companyId, companyId, platform, platform, since) as { company_id: number; platform: Platform; data: string }[];
  return rows.map((r) => ({ companyId: r.company_id, platform: r.platform, ...(JSON.parse(r.data) as Item & { format: string; category: string }) }));
}

export function setWebsite(companyId: number, website: string) {
  db.prepare(`UPDATE companies SET website = ?, lookup_state = '', lookup_note = '' WHERE id = ? AND website != ?`).run(website, companyId, website);
}

/** Queues a website lookup for companies that have a website but are missing a handle on some platform. */
export function queueLookups(companyId: number | null, platformCount: number) {
  return Number(db.prepare(
    `UPDATE companies SET lookup_state = 'queued' WHERE website != '' AND lookup_state != 'running' AND (? IS NULL OR id = ?)
       AND (SELECT COUNT(*) FROM handles h WHERE h.company_id = companies.id) < ?`,
  ).run(companyId, companyId, platformCount).changes);
}

export function claimNextLookup(): { id: number; name: string; website: string } | undefined {
  return tx(() => {
    const row = db.prepare(`SELECT id, name, website FROM companies WHERE lookup_state = 'queued' ORDER BY id LIMIT 1`).get() as { id: number; name: string; website: string } | undefined;
    if (row) db.prepare(`UPDATE companies SET lookup_state = 'running' WHERE id = ?`).run(row.id);
    return row;
  });
}

export function finishLookup(companyId: number, state: 'done' | 'failed', note: string) {
  db.prepare(`UPDATE companies SET lookup_state = ?, lookup_note = ? WHERE id = ?`).run(state, note.slice(0, 300), companyId);
}

export const hasHandle = (companyId: number, platform: Platform) => !!db.prepare(`SELECT 1 FROM handles WHERE company_id = ? AND platform = ?`).get(companyId, platform);

export function cancelLookups() {
  return Number(db.prepare(`UPDATE companies SET lookup_state = '' WHERE lookup_state = 'queued'`).run().changes);
}
