import type { NextRequest } from 'next/server';
import { engine } from '@/lib/engine';

type Ctx = { params: Promise<{ id: string }> };
const safe = (id: string) => (/^\d{1,12}$/.test(id) ? id : '0');

export async function GET(req: NextRequest, { params }: Ctx) {
  const platform = req.nextUrl.searchParams.get('platform');
  const qs = platform ? `?${new URLSearchParams({ platform })}` : '';
  return engine(`/keywords/${safe((await params).id)}${qs}`);
}

export async function DELETE(_req: NextRequest, { params }: Ctx) {
  return engine(`/keywords/${safe((await params).id)}`, { method: 'DELETE' });
}
