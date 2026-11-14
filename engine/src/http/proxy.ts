import { ProxyAgent, type Dispatcher } from 'undici';
import { config } from '../config.js';

export interface Route {
  id: string;
  /** Plain forward proxy. */
  dispatcher?: Dispatcher;
  /** AWS API Gateway base URL that forwards to the target host. */
  gatewayBase?: string;
}

interface Health { fails: number; cooldownUntil: number }

/**
 * Rotates egress routes per target host. A route that gets blocked is put on an
 * exponentially growing cool-down so traffic moves to healthy addresses.
 */
export class RoutePool {
  private proxies: Route[];
  private gateways = new Map<string, Route[]>();
  private health = new Map<string, Health>();
  private cursor = new Map<string, number>();
  private direct: Route = { id: 'direct' };

  constructor(proxyUrls = config.proxyUrls, gateways = config.gateways) {
    this.proxies = proxyUrls.map((url, i) => ({
      id: `proxy#${i}`,
      dispatcher: new ProxyAgent({ uri: url, connectTimeout: 15000 }),
    }));
    for (const [host, bases] of Object.entries(gateways)) {
      this.gateways.set(host, bases.map((b, i) => ({ id: `gw:${host}#${i}`, gatewayBase: b })));
    }
  }

  get size() {
    return this.proxies.length + [...this.gateways.values()].reduce((n, g) => n + g.length, 0);
  }

  pick(host: string, exclude: Set<string> = new Set()): Route {
    const candidates = this.gateways.get(host.toLowerCase()) ?? this.proxies;
    if (!candidates.length) return this.direct;
    const now = Date.now();
    const start = this.cursor.get(host) ?? Math.floor(Math.random() * candidates.length);
    let fallback: Route | undefined;
    let soonest = Infinity;
    for (let i = 0; i < candidates.length; i++) {
      const r = candidates[(start + i) % candidates.length];
      const until = this.health.get(`${host}|${r.id}`)?.cooldownUntil ?? 0;
      if (until <= now && !exclude.has(r.id)) {
        this.cursor.set(host, (start + i + 1) % candidates.length);
        return r;
      }
      if (until < soonest && !exclude.has(r.id)) { soonest = until; fallback = r; }
    }
    // everything is cooling down: use the route that recovers first
    return fallback ?? candidates[start % candidates.length];
  }

  report(host: string, route: Route, ok: boolean) {
    if (route.id === 'direct') return;
    const key = `${host}|${route.id}`;
    if (ok) { this.health.delete(key); return; }
    const h = this.health.get(key) ?? { fails: 0, cooldownUntil: 0 };
    h.fails++;
    h.cooldownUntil = Date.now() + Math.min(30 * 60_000, 15_000 * 2 ** (h.fails - 1));
    this.health.set(key, h);
  }

  stats() {
    const now = Date.now();
    const cooling = [...this.health.values()].filter((h) => h.cooldownUntil > now).length;
    return { routes: this.size, cooling, mode: this.gateways.size ? 'aws-gateway' : this.proxies.length ? 'proxy' : 'direct' };
  }
}

export const routes = new RoutePool();
