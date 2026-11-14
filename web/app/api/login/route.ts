import { createHash, timingSafeEqual } from 'node:crypto';
import { NextResponse, type NextRequest } from 'next/server';
import { COOKIE, MAX_AGE, createSession } from '@/lib/session';

const attempts = new Map<string, { n: number; reset: number }>();
const sha = (s: string) => createHash('sha256').update(s).digest();

export async function POST(req: NextRequest) {
  const expected = process.env.DASHBOARD_PASSWORD;
  if (!expected || expected.length < 10) {
    return NextResponse.json({ error: 'DASHBOARD_PASSWORD is not configured (minimum 10 characters).' }, { status: 500 });
  }
  const ip = req.headers.get('x-forwarded-for')?.split(',')[0].trim() || 'local';
  const now = Date.now();
  const a = attempts.get(ip);
  if (a && a.reset > now && a.n >= 8) {
    return NextResponse.json({ error: 'Too many attempts. Try again in a few minutes.' }, { status: 429 });
  }
  const { password } = (await req.json().catch(() => ({}))) as { password?: unknown };
  if (typeof password !== 'string' || !timingSafeEqual(sha(password), sha(expected))) {
    attempts.set(ip, a && a.reset > now ? { n: a.n + 1, reset: a.reset } : { n: 1, reset: now + 10 * 60_000 });
    if (attempts.size > 5000) attempts.clear();
    return NextResponse.json({ error: 'Wrong password.' }, { status: 401 });
  }
  attempts.delete(ip);
  const res = NextResponse.json({ ok: true });
  res.cookies.set(COOKIE, await createSession(), {
    httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production', path: '/', maxAge: MAX_AGE,
  });
  return res;
}
