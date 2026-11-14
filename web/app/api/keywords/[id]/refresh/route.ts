import type { NextRequest } from 'next/server';
import { engine } from '@/lib/engine';

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = (await req.json().catch(() => ({}))) as { platform?: string };
  return engine(`/keywords/${/^\d{1,12}$/.test(id) ? id : '0'}/refresh`, { method: 'POST', body: { platform: body.platform } });
}
