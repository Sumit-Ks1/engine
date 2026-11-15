import { config, type Platform } from './config.js';
import { kvGet, kvSet } from './db.js';

/**
 * Guard rails for platforms that run on a signed-in account: slow pacing between keywords,
 * a daily cap, and a pause the moment the platform pushes back.
 */
export const ACCOUNT_PLATFORMS: Platform[] = ['instagram', 'twitter', 'reddit'];
const isAccount = (p: Platform) => ACCOUNT_PLATFORMS.includes(p);

interface Pause { until: number; reason: string; kind: 'login' | 'cooldown' }
const nextAt = new Map<Platform, number>();
const pauses = new Map<Platform, Pause>();

// rate-limit pauses survive a restart; "sign in again" pauses clear on restart, since signing in needs one
for (const p of ACCOUNT_PLATFORMS) {
  const saved = kvGet(`pause:${p}`);
  if (saved) { try { const v = JSON.parse(saved) as Pause; if (v.until > Date.now()) pauses.set(p, v); } catch { /* ignore */ } }
}

const day = () => new Date().toISOString().slice(0, 10);
const usedToday = (p: Platform) => Number(kvGet(`count:${p}:${day()}`) ?? 0);

export function pauseOf(p: Platform): Pause | null {
  const v = pauses.get(p);
  if (v && v.until <= Date.now()) { pauses.delete(p); return null; }
  if (v) return v;
  const cap = config.accountDailyCap[p];
  if (cap && usedToday(p) >= cap) return { until: Date.parse(`${day()}T23:59:59Z`), reason: `Daily limit of ${cap} keywords reached. Collection continues tomorrow.`, kind: 'cooldown' };
  return null;
}

/** Platforms that must not start a job right now. */
export function unavailable(): Platform[] {
  const now = Date.now();
  return ACCOUNT_PLATFORMS.filter((p) => pauseOf(p) || (nextAt.get(p) ?? 0) > now);
}

export function started(p: Platform) {
  if (isAccount(p)) kvSet(`count:${p}:${day()}`, String(usedToday(p) + 1));
}

export function finished(p: Platform, errorKind?: string, message?: string) {
  if (!isAccount(p)) return;
  const gap = (config.accountGapSeconds[p] ?? 30) * 1000;
  nextAt.set(p, Date.now() + gap * (0.6 + Math.random() * 0.8));
  if (errorKind === 'login_required') {
    pauses.set(p, { until: Number.MAX_SAFE_INTEGER, reason: message ?? 'Not signed in.', kind: 'login' });
  } else if (errorKind === 'blocked') {
    const v: Pause = { until: Date.now() + config.accountCooldownHours * 36e5, reason: message ?? 'The platform pushed back.', kind: 'cooldown' };
    pauses.set(p, v);
    kvSet(`pause:${p}`, JSON.stringify(v));
  }
}

export function resume(p: Platform) {
  pauses.delete(p);
  kvSet(`pause:${p}`, '');
}

export function laneStatus() {
  return Object.fromEntries(ACCOUNT_PLATFORMS.map((p) => {
    const v = pauseOf(p);
    return [p, { paused: !!v, kind: v?.kind ?? null, reason: v?.reason ?? null, until: v && v.until < Number.MAX_SAFE_INTEGER ? v.until : null, usedToday: usedToday(p), dailyCap: config.accountDailyCap[p] ?? null }];
  }));
}
