import { createHash, timingSafeEqual } from 'node:crypto';
import Fastify from 'fastify';
import { config, PLATFORMS, type Platform } from './config.js';
import * as store from './db.js';
import { closeBrowser } from './browser.js';
import { routes } from './http/proxy.js';
import * as lanes from './lanes.js';
import * as insights from './insights.js';
import { startQueue } from './queue.js';
import { PROFILE_PLATFORMS, normalizeHandle } from './scrapers/profiles.js';
import { normalizeKeyword } from './util.js';

if (!config.apiKey || config.apiKey.length < 24) {
  console.error('ENGINE_API_KEY must be set to a random string of at least 24 characters.');
  process.exit(1);
}

const app = Fastify({ logger: { level: 'info' }, disableRequestLogging: true, bodyLimit: 1024 * 1024 });
// jobs that failed while a platform was signed out or resting get another go after a restart
for (const p of lanes.ACCOUNT_PLATFORMS) if (!lanes.pauseOf(p)) store.requeueFailed(p);
const queue = startQueue((msg) => app.log.info(msg));

const digest = (s: string) => createHash('sha256').update(s).digest();
const expected = digest(config.apiKey);
app.addHook('onRequest', async (req, reply) => {
  if (req.url === '/health') return;
  const key = req.headers['x-api-key'];
  if (typeof key !== 'string' || !timingSafeEqual(digest(key), expected)) {
    return reply.code(401).send({ error: 'unauthorized' });
  }
});

const idOf = (v: unknown) => {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
};
const platformOf = (v: unknown): Platform | null => (PLATFORMS as readonly string[]).includes(v as string) ? (v as Platform) : null;

app.get('/health', async () => ({ ok: true }));

app.get('/stats', async () => ({ ...store.stats(), egress: routes.stats(), accounts: lanes.laneStatus(), refreshHours: config.refreshHours, demo: config.demoMode }));

app.get('/companies', async () => ({ companies: store.listCompanies() }));

app.post('/companies', async (req, reply) => {
  const name = String((req.body as { name?: unknown })?.name ?? '').normalize('NFKC').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!name || name.length > 60) return reply.code(400).send({ error: 'Enter a company name of up to 60 characters.' });
  const company = store.addCompany(name);
  if (!company) return reply.code(409).send({ error: 'That company is already in the list.' });
  return { company };
});

app.delete('/companies/:id', async (req, reply) => {
  const id = idOf((req.params as any).id);
  if (!id || !store.deleteCompany(id)) return reply.code(404).send({ error: 'not found' });
  return { ok: true };
});

app.get('/companies/:id/keywords', async (req, reply) => {
  const id = idOf((req.params as any).id);
  const company = id && store.getCompany(id);
  if (!company) return reply.code(404).send({ error: 'not found' });
  const q = req.query as Record<string, string>;
  const limit = Math.min(200, Math.max(1, Number(q.limit) || 50));
  const page = Math.max(1, Number(q.page) || 1);
  return { company, page, limit, ...store.listKeywords(company.id, String(q.search ?? '').slice(0, 100), limit, (page - 1) * limit) };
});

app.post('/companies/:id/keywords', async (req, reply) => {
  const id = idOf((req.params as any).id);
  if (!id || !store.getCompany(id)) return reply.code(404).send({ error: 'not found' });
  // each entry is a keyword for all platforms ("term") or for chosen ones ({ term, platforms })
  const terms = (req.body as { terms?: unknown })?.terms;
  if (!Array.isArray(terms) || terms.length > 5000) return reply.code(400).send({ error: 'terms must be an array of at most 5000 keywords' });
  const clean = new Map<string, Set<Platform>>();
  let invalid = 0;
  for (const t of terms) {
    const obj = t && typeof t === 'object' ? (t as { term?: unknown; platforms?: unknown }) : null;
    const k = normalizeKeyword(obj ? obj.term : t);
    const wanted = obj && Array.isArray(obj.platforms) ? obj.platforms.map(platformOf).filter((p): p is Platform => p !== null) : [...PLATFORMS];
    if (!k || !wanted.length) { invalid++; continue; }
    const set = clean.get(k) ?? new Set<Platform>();
    wanted.forEach((p) => set.add(p));
    clean.set(k, set);
  }
  const result = store.addKeywords(id, [...clean].map(([term, set]) => ({ term, platforms: [...set] })));
  queue.kick();
  return { ...result, duplicates: result.duplicates + (terms.length - invalid - clean.size), invalid };
});

app.post('/companies/:id/keywords/remove', async (req, reply) => {
  const id = idOf((req.params as any).id);
  if (!id || !store.getCompany(id)) return reply.code(404).send({ error: 'not found' });
  const body = (req.body ?? {}) as { ids?: unknown; all?: unknown };
  if (body.all === true) return { removed: store.removeKeywords(id, null) };
  const ids = Array.isArray(body.ids) ? body.ids.map(idOf).filter((n): n is number => n !== null) : [];
  if (!ids.length || ids.length > 5000) return reply.code(400).send({ error: 'Choose at least one keyword.' });
  return { removed: store.removeKeywords(id, ids) };
});

app.delete('/companies/:id/keywords/:kid', async (req, reply) => {
  const id = idOf((req.params as any).id);
  const kid = idOf((req.params as any).kid);
  if (!id || !kid || !store.removeKeyword(id, kid)) return reply.code(404).send({ error: 'not found' });
  return { ok: true };
});

app.get('/keywords/:id', async (req, reply) => {
  const id = idOf((req.params as any).id);
  const keyword = id && store.getKeyword(id);
  if (!keyword) return reply.code(404).send({ error: 'not found' });
  // seen from a company, a keyword shows only the platforms that company asked for
  const companyId = idOf((req.query as any).c);
  const wanted = companyId ? store.linkedPlatforms(companyId, keyword.id) : null;
  const jobs = store.getJobs(keyword.id).filter((j) => !wanted || wanted.includes(j.platform));
  const asked = platformOf((req.query as any).platform);
  const platform = asked && jobs.some((j) => j.platform === asked) ? asked : null;
  return {
    keyword,
    platforms: Object.fromEntries(jobs.map((j) => [j.platform, {
      status: j.status, count: j.result_count, fetchedAt: j.fetched_at, error: j.error, errorKind: j.error_kind,
    }])),
    items: platform ? store.getResults(keyword.id, platform) : undefined,
  };
});

app.post('/keywords/:id/refresh', async (req, reply) => {
  const id = idOf((req.params as any).id);
  if (!id || !store.getKeyword(id)) return reply.code(404).send({ error: 'not found' });
  const raw = (req.body as any)?.platform;
  const platform = platformOf(raw);
  if (raw !== undefined && raw !== null && !platform) return reply.code(400).send({ error: 'unknown platform' });
  const queued = store.requeue(id, platform ?? undefined);
  queue.kick();
  return { queued };
});

// ---- brand analysis -------------------------------------------------------

app.get('/insights/summary', async () => insights.summary());

app.put('/companies/:id/handles', async (req, reply) => {
  const id = idOf((req.params as any).id);
  if (!id || !store.getCompany(id)) return reply.code(404).send({ error: 'not found' });
  const body = (req.body ?? {}) as Record<string, unknown>;
  const invalid: string[] = [];
  if ('website' in body) {
    const raw = String(body.website ?? '').trim();
    let site = '';
    if (raw) {
      try {
        const u = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
        // only ordinary public web addresses: the engine's browser will open this
        if (!/^https?:$/.test(u.protocol) || !/^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(u.hostname) || /^\d+(\.\d+){3}$/.test(u.hostname) || /(^|\.)(localhost|local|internal)$/i.test(u.hostname)) throw new Error('bad');
        site = `${u.protocol}//${u.hostname}${u.pathname}`;
      } catch { invalid.push('website'); }
    }
    if (!invalid.length) store.setWebsite(id, site);
  }
  for (const platform of PROFILE_PLATFORMS) {
    if (!(platform in body)) continue;
    const raw = String(body[platform] ?? '').trim();
    const handle = raw ? normalizeHandle(platform, raw) : null;
    if (raw && !handle) { invalid.push(platform); continue; }
    store.setHandle(id, platform, handle);
  }
  if (invalid.length) return reply.code(400).send({ error: `Could not read the handle for: ${invalid.join(', ')}. Paste the profile link or the handle.` });
  return { ok: true };
});

app.post('/insights/run', async (req) => {
  const companyId = idOf((req.body as any)?.companyId);
  // by default only what is missing or failed is collected; `all` re-reads accounts that already have data
  const all = (req.body as any)?.all === true;
  // companies still missing a handle get their website read first; what is found is queued automatically
  const lookups = store.queueLookups(companyId, PROFILE_PLATFORMS.length);
  const queued = store.queueProfiles(companyId, !all);
  queue.kick();
  return { queued, lookups };
});

app.post('/insights/stop', async () => ({ stopped: store.cancelProfiles() + store.cancelLookups() }));

app.get('/insights/posts', async (req) => {
  const q = req.query as Record<string, string>;
  return insights.posts({
    company: idOf(q.company), platform: platformOf(q.platform),
    month: /^\d{4}-\d{2}$/.test(q.month ?? '') ? q.month : undefined,
    format: /^[a-z_]{1,20}$/.test(q.format ?? '') ? q.format : undefined,
    category: /^[a-z_]{1,20}$/.test(q.category ?? '') ? q.category : undefined,
    sort: q.sort, page: Number(q.page) || 1,
  });
});

app.post('/accounts/:platform/resume', async (req, reply) => {
  const platform = platformOf((req.params as any).platform);
  if (!platform || !lanes.ACCOUNT_PLATFORMS.includes(platform)) return reply.code(400).send({ error: 'unknown platform' });
  lanes.resume(platform);
  const queued = store.requeueFailed(platform);
  queue.kick();
  return { queued };
});

const shutdown = async () => {
  app.log.info('shutting down');
  await app.close();
  await queue.stop();
  await closeBrowser();
  store.db.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

app.listen({ port: config.port, host: config.host }).then(() => {
  const egress = routes.stats();
  app.log.info(`egress mode: ${egress.mode} (${egress.routes} routes)${config.demoMode ? ' — DEMO MODE: sample data only' : ''}`);
  if (egress.mode === 'direct') app.log.warn('No rotating egress configured: all requests leave from this machine\'s own IP.');
});
