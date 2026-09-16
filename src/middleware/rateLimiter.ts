import { NextRequest, NextResponse } from 'next/server';

interface RateLimitStore {
  [key: string]: {
    count: number;
    resetTime: number;
  };
}

const store: RateLimitStore = {};

const WINDOW_MS = 60 * 1000; // 1 minute
const MAX_REQUESTS = {
  '/api/leads': 5,
  '/api/calendar/book-demo': 3,
  '/api/stripe/checkout-session': 10,
  default: 30
};

export function rateLimiter(pathname: string, identifier: string): boolean {
  const now = Date.now();
  const key = `${pathname}:${identifier}`;
  const limit = MAX_REQUESTS[pathname as keyof typeof MAX_REQUESTS] || MAX_REQUESTS.default;

  if (!store[key] || store[key].resetTime < now) {
    store[key] = {
      count: 1,
      resetTime: now + WINDOW_MS
    };
    return true;
  }

  if (store[key].count >= limit) {
    return false;
  }

  store[key].count++;
  return true;
}

export function createRateLimitResponse(): NextResponse {
  return NextResponse.json(
    { 
      error: 'Too many requests. Please try again later.',
      retryAfter: WINDOW_MS / 1000 
    },
    { 
      status: 429,
      headers: {
        'Retry-After': String(WINDOW_MS / 1000),
        'X-RateLimit-Limit': String(MAX_REQUESTS.default),
        'X-RateLimit-Reset': String(Date.now() + WINDOW_MS)
      }
    }
  );
}

// Clean up expired entries periodically
setInterval(() => {
  const now = Date.now();
  Object.keys(store).forEach(key => {
    if (store[key].resetTime < now) {
      delete store[key];
    }
  });
}, WINDOW_MS);