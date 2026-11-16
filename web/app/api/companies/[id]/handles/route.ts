import type { NextRequest } from 'next/server';
import { engine } from '@/lib/engine';
import { safeId } from '@/lib/ids';

export async function PUT(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const clean: Record<string, string> = {};
  for (const p of ['website', 'youtube', 'instagram', 'twitter']) if (p in body) clean[p] = String(body[p] ?? '').slice(0, 200);
  return engine(`/companies/${safeId((await params).id)}/handles`, { method: 'PUT', body: clean });
}
