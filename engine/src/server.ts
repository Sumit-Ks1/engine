import { createHash, timingSafeEqual } from 'node:crypto';
import Fastify from 'fastify';
import { config, PLATFORMS, type Platform } from './config.js';
import * as store from './db.js';
import { routes } from './http/proxy.js';
import { startQueue } from './queue.js';
import { normalizeKeyword } from './util.js';

if (!config.apiKey || config.apiKey.length < 24) {
  console.error('ENGINE_API_KEY must be set to a random string of at least 24 characters.');
  process.exit(1);
}

const app = Fastify({ logger: { level: 'info' }, bodyLimit: 1024 * 1024 });
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

app.get('/stats', async () => ({ ...store.stats(), egress: routes.stats(), refreshHours: config.refreshHours, demo: config.demoMode }));

app.get('/keywords', async (req) => {
  const q = req.query as Record<string, string>;
  const limit = Math.min(200, Math.max(1, Number(q.limit) || 50));
  const page = Math.max(1, Number(q.page) || 1);
  return { page, limit, ...store.listKeywords(String(q.search ?? '').slice(0, 100), limit, (page - 1) * limit) };
});

app.post('/keywords', async (req, reply) => {
  const terms = (req.body as { terms?: unknown })?.terms;
  if (!Array.isArray(terms) || terms.length > 5000) return reply.code(400).send({ error: 'terms must be an array of at most 5000 keywords' });
  const clean = new Map<string, string>();
  let invalid = 0;
  for (const t of terms) {
    const k = normalizeKeyword(t);
    if (k) clean.set(k.toLowerCase(), k); else invalid++;
  }
  const result = store.addKeywords([...clean.values()]);
  queue.kick();
  return { ...result, duplicates: result.duplicates + (terms.length - invalid - clean.size), invalid };
});

app.delete('/keywords', async () => ({ deleted: store.deleteAllKeywords() }));

app.delete('/keywords/:id', async (req, reply) => {
  const id = idOf((req.params as any).id);
  if (!id || !store.deleteKeyword(id)) return reply.code(404).send({ error: 'not found' });
  return { ok: true };
});

app.get('/keywords/:id', async (req, reply) => {
  const id = idOf((req.params as any).id);
  const keyword = id && store.getKeyword(id);
  if (!keyword) return reply.code(404).send({ error: 'not found' });
  const jobs = store.getJobs(keyword.id);
  const platform = platformOf((req.query as any).platform);
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

const shutdown = async () => {
  app.log.info('shutting down');
  await app.close();
  await queue.stop();
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
