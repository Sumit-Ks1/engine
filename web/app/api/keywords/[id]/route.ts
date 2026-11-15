import type { NextRequest } from 'next/server';
import { engine } from '@/lib/engine';
import { safeId } from '@/lib/ids';

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const platform = req.nextUrl.searchParams.get('platform');
  const qs = platform ? `?${new URLSearchParams({ platform })}` : '';
  return engine(`/keywords/${safeId((await params).id)}${qs}`);
}
