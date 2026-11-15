import type { NextRequest } from 'next/server';
import { engine } from '@/lib/engine';

export async function POST(_req: NextRequest, { params }: { params: Promise<{ platform: string }> }) {
  const { platform } = await params;
  return engine(`/accounts/${/^[a-z]{1,20}$/.test(platform) ? platform : 'x'}/resume`, { method: 'POST', body: {} });
}
