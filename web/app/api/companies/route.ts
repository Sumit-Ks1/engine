import type { NextRequest } from 'next/server';
import { engine } from '@/lib/engine';

export const GET = () => engine('/companies');

export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => ({}))) as { name?: unknown };
  return engine('/companies', { method: 'POST', body: { name: String(body.name ?? '').slice(0, 200) } });
}
