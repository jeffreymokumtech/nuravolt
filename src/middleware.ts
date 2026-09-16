import { NextRequest, NextResponse } from 'next/server'
import { getSessionCookie } from 'better-auth/cookies'

const PROTECTED_PREFIXES = [
  '/dashboard',
  '/admin',
  '/chat',
  '/create-organization',
  '/onboarding',
  '/api/mcp-keys',
]

export default function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl

  // Block demo routes in production — demo is for local development only
  if (process.env.NODE_ENV === 'production' && pathname.startsWith('/demo')) {
    return NextResponse.rewrite(new URL('/not-found', request.url))
  }

  const isProtected = PROTECTED_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`)
  )

  if (isProtected) {
    // Optimistic cookie check only — middleware runs on the edge, so real
    // session validation happens in route handlers / server components via
    // auth.api.getSession().
    const sessionCookie = getSessionCookie(request)
    if (!sessionCookie) {
      if (pathname.startsWith('/api/')) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
      }
      const signInUrl = new URL('/sign-in', request.url)
      signInUrl.searchParams.set('redirect_url', pathname + request.nextUrl.search)
      return NextResponse.redirect(signInUrl)
    }
  }

  return NextResponse.next()
}

export const config = {
  // Only the paths this middleware actually acts on. Marketing/SEO pages are
  // static on the CDN and must not invoke middleware on every hit (Vercel
  // bills each invocation). Security headers + CSP are static in vercel.json.
  matcher: [
    '/dashboard/:path*',
    '/admin/:path*',
    '/chat/:path*',
    '/create-organization/:path*',
    '/onboarding/:path*',
    '/api/mcp-keys/:path*',
    '/demo/:path*',
  ],
};
