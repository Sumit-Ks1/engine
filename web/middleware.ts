import { NextResponse, type NextRequest } from 'next/server';
import { COOKIE, verifySession } from './lib/session';

export async function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;
  if (pathname === '/login' || pathname === '/api/login') return NextResponse.next();
  if (await verifySession(req.cookies.get(COOKIE)?.value)) {
    // state-changing calls must come from our own pages
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      const origin = req.headers.get('origin');
      if (origin && new URL(origin).host !== req.headers.get('host')) {
        return NextResponse.json({ error: 'forbidden' }, { status: 403 });
      }
    }
    return NextResponse.next();
  }
  if (pathname.startsWith('/api/')) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  return NextResponse.redirect(new URL('/login', req.url));
}

export const config = { matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'] };
