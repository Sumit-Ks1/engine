import type { NextRequest } from 'next/server';
import { engine } from '@/lib/engine';
import { safeId } from '@/lib/ids';

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string; kid: string }> }) {
  const { id, kid } = await params;
  return engine(`/companies/${safeId(id)}/keywords/${safeId(kid)}`, { method: 'DELETE' });
}
