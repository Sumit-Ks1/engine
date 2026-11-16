import type { NextRequest } from 'next/server';
import { engine } from '@/lib/engine';
import { safeId } from '@/lib/ids';

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const platform = req.nextUrl.searchParams.get('platform');
  const company = req.nextUrl.searchParams.get('c');
  const q = new URLSearchParams();
  if (platform) q.set('platform', platform);
  if (company && /^\d{1,12}$/.test(company)) q.set('c', company);
  const qs = q.size ? `?${q}` : '';
  return engine(`/keywords/${safeId((await params).id)}${qs}`);
}
