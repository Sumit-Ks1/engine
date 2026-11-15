import type { NextRequest } from 'next/server';
import { engine } from '@/lib/engine';
import { safeId } from '@/lib/ids';

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return engine(`/companies/${safeId((await params).id)}`, { method: 'DELETE' });
}
