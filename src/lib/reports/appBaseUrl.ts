/**
 * Resolve the app's own public base URL for server-side self-fetches (the
 * dashboard-PDF renderer opens `/r/<token>` in headless Chromium). Priority:
 * explicit env override, the caller's Origin, the forwarded/request host,
 * then Vercel's own deployment envs. Only local dev should ever land on
 * localhost — on Vercel the old `env || origin || localhost` chain sent the
 * cron path (no Origin header) to localhost and silently degraded scheduled
 * emails to the section-PDF fallback.
 */
export function appBaseUrl(req?: Request): string {
  if (process.env.NEXT_PUBLIC_APP_URL) return process.env.NEXT_PUBLIC_APP_URL;

  const origin = req?.headers.get('origin');
  if (origin) return origin;

  const host = req?.headers.get('x-forwarded-host') ?? req?.headers.get('host');
  if (host && !host.startsWith('localhost') && !host.startsWith('127.')) {
    const proto = req?.headers.get('x-forwarded-proto') ?? 'https';
    return `${proto}://${host}`;
  }

  if (process.env.VERCEL_PROJECT_PRODUCTION_URL) {
    return `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`;
  }
  if (process.env.VERCEL_URL) return `https://${process.env.VERCEL_URL}`;

  return host ? `http://${host}` : 'http://localhost:3000';
}
