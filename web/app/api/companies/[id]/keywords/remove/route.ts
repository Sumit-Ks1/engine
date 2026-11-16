import type { NextRequest } from 'next/server';
import { engine } from '@/lib/engine';
import { safeId } from '@/lib/ids';

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const body = (await req.json().catch(() => ({}))) as { ids?: unknown; all?: unknown };
  const payload = body.all === true
    ? { all: true }
    : { ids: (Array.isArray(body.ids) ? body.ids : []).filter((n) => Number.isInteger(n) && n > 0).slice(0, 5000) };
  return engine(`/companies/${safeId((await params).id)}/keywords/remove`, { method: 'POST', body: payload });
}
