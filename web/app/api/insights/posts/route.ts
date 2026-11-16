import type { NextRequest } from 'next/server';
import { engine } from '@/lib/engine';

const ALLOWED = ['company', 'platform', 'month', 'format', 'category', 'sort', 'page'];

export function GET(req: NextRequest) {
  const q = new URLSearchParams();
  for (const key of ALLOWED) {
    const v = req.nextUrl.searchParams.get(key);
    if (v && /^[\w-]{1,24}$/.test(v)) q.set(key, v);
  }
  return engine(`/insights/posts?${q}`);
}
