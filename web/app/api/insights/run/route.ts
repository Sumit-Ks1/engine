import type { NextRequest } from 'next/server';
import { engine } from '@/lib/engine';

export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => ({}))) as { companyId?: unknown };
  const companyId = Number.isInteger(body.companyId) && (body.companyId as number) > 0 ? body.companyId : undefined;
  return engine('/insights/run', { method: 'POST', body: { companyId } });
}
