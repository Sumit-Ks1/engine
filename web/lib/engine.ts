import 'server-only';
import { NextResponse } from 'next/server';

/** Server-side bridge to the engine. The browser never sees its address or key. */
export async function engine(path: string, init: { method?: string; body?: unknown } = {}): Promise<NextResponse> {
  const base = process.env.ENGINE_URL || 'http://127.0.0.1:4000';
  try {
    const res = await fetch(base + path, {
      method: init.method ?? 'GET',
      headers: {
        'x-api-key': process.env.ENGINE_API_KEY ?? '',
        ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
      cache: 'no-store',
      signal: AbortSignal.timeout(20_000),
    });
    const data = await res.json().catch(() => ({ error: 'bad response' }));
    return NextResponse.json(data, { status: res.status === 401 ? 502 : res.status });
  } catch {
    return NextResponse.json({ error: 'The engine is not reachable right now.' }, { status: 502 });
  }
}
