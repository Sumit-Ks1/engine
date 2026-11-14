import type { NextRequest } from 'next/server';
import { engine } from '@/lib/engine';

export function GET(req: NextRequest) {
  const q = req.nextUrl.searchParams;
  const params = new URLSearchParams({ search: q.get('search') ?? '', page: q.get('page') ?? '1', limit: '50' });
  return engine(`/keywords?${params}`);
}

export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => ({}))) as { text?: unknown };
  const terms = String(body.text ?? '').split(/[\n,;]+/).map((s) => s.trim()).filter(Boolean).slice(0, 5000);
  return engine('/keywords', { method: 'POST', body: { terms } });
}

export const DELETE = () => engine('/keywords', { method: 'DELETE' });
