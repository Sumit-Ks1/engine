import type { NextRequest } from 'next/server';
import { engine } from '@/lib/engine';
import { safeId } from '@/lib/ids';

type Ctx = { params: Promise<{ id: string }> };

export async function GET(req: NextRequest, { params }: Ctx) {
  const q = req.nextUrl.searchParams;
  const qs = new URLSearchParams({ search: q.get('search') ?? '', page: q.get('page') ?? '1', limit: '50' });
  return engine(`/companies/${safeId((await params).id)}/keywords?${qs}`);
}

export async function POST(req: NextRequest, { params }: Ctx) {
  const body = (await req.json().catch(() => ({}))) as { text?: unknown };
  const terms = String(body.text ?? '').split(/[\n,;]+/).map((s) => s.trim()).filter(Boolean).slice(0, 5000);
  return engine(`/companies/${safeId((await params).id)}/keywords`, { method: 'POST', body: { terms } });
}
