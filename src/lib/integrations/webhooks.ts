import crypto from 'crypto';
import prisma from '@/libs/prisma';

/**
 * Outbound webhook dispatch (arc 9). Ticket lifecycle events POST signed
 * JSON to customer endpoints (monday.com automations, Jira Automation,
 * Make/Zapier, any CMMS).
 *
 * Contract:
 *   POST <url>
 *   x-nuravolt-event:     ticket.created | ticket.status_changed | ping
 *   x-nuravolt-delivery:  delivery row id
 *   x-nuravolt-signature: sha256=<hex HMAC-SHA256 of the raw body>
 *   body: { delivery_id, event, created_at, data }
 *
 * Callers AWAIT emitTicketEvent (via Promise.allSettled inside) BEFORE
 * returning their response — fire-and-forget promises get killed on
 * serverless. One attempt, 5s timeout, no retries this arc; every attempt
 * writes a WebhookDelivery row. Failures never fail the ticket write.
 */

export type WebhookEvent =
  | 'ticket.created'
  | 'ticket.status_changed'
  | 'alert.opened'
  | 'alert.resolved'
  | 'alert.acknowledged'
  | 'ping';

/** Subscribable events shown in the integrations UI (excludes the 'ping' test). */
export const WEBHOOK_EVENT_VALUES = [
  'ticket.created',
  'ticket.status_changed',
  'alert.opened',
  'alert.resolved',
  'alert.acknowledged',
] as const;

export interface TicketEventData {
  id: string;
  title: string;
  status: string;
  old_status?: string | null;
  priority?: string | null;
  plant_slug?: string | null;
  plant_name?: string | null;
  trigger_type?: string | null;
  estimated_revenue_impact_eur?: number | null;
  url?: string;
  [key: string]: unknown;
}

export interface AlertEventData {
  id: string;
  kind: string;
  severity: string;
  message: string;
  status?: string | null;
  metric_value?: number | null;
  threshold?: number | null;
  plant_slug?: string | null;
  plant_name?: string | null;
  acknowledged_by?: string | null;
  url?: string;
  [key: string]: unknown;
}

const TIMEOUT_MS = 5000;

/**
 * SSRF guard: https-only in production, and never literal loopback /
 * private / link-local hosts. DNS-rebinding-grade protection is out of
 * scope (documented limitation).
 */
export function webhookUrlProblem(rawUrl: string): string | null {
  let u: URL;
  try {
    u = new URL(rawUrl);
  } catch {
    return 'Not a valid URL.';
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') {
    return 'URL must be http(s).';
  }
  if (process.env.NODE_ENV === 'production' && u.protocol !== 'https:') {
    return 'URL must use https.';
  }
  const host = u.hostname.toLowerCase();
  if (
    host === 'localhost' ||
    host === '0.0.0.0' ||
    host === '::1' ||
    /^127\./.test(host) ||
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^169\.254\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host)
  ) {
    // Dev servers may legitimately test against localhost tools.
    if (process.env.NODE_ENV === 'production') {
      return 'Private and loopback addresses are not allowed.';
    }
  }
  return null;
}

export function signWebhookBody(secret: string, rawBody: string): string {
  return `sha256=${crypto.createHmac('sha256', secret).update(rawBody).digest('hex')}`;
}

async function deliverOne(
  hook: { id: string; url: string; secret: string },
  event: WebhookEvent,
  data: Record<string, unknown>
): Promise<void> {
  const delivery = await prisma.webhookDelivery.create({
    data: {
      webhook_id: hook.id,
      event,
      payload: data as object,
      status: 'pending',
    },
    select: { id: true },
  });

  const body = JSON.stringify({
    delivery_id: delivery.id,
    event,
    created_at: new Date().toISOString(),
    data,
  });

  const started = Date.now();
  try {
    const problem = webhookUrlProblem(hook.url);
    if (problem) throw new Error(problem);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    let res: Response;
    try {
      res = await fetch(hook.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-nuravolt-event': event,
          'x-nuravolt-delivery': delivery.id,
          'x-nuravolt-signature': signWebhookBody(hook.secret, body),
        },
        body,
        signal: controller.signal,
        redirect: 'error',
      });
    } finally {
      clearTimeout(timer);
    }

    await prisma.webhookDelivery.update({
      where: { id: delivery.id },
      data: {
        status: res.ok ? 'success' : 'failed',
        response_code: res.status,
        duration_ms: Date.now() - started,
        error: res.ok ? null : `HTTP ${res.status}`,
      },
    });
  } catch (e) {
    await prisma.webhookDelivery
      .update({
        where: { id: delivery.id },
        data: {
          status: 'failed',
          duration_ms: Date.now() - started,
          error: (e instanceof Error ? e.message : 'delivery failed').slice(0, 300),
        },
      })
      .catch(() => {});
  }
}

/**
 * Deliver `event` to every active org webhook subscribed to it. Await this
 * before returning the route response; it never throws and never rejects.
 * `onlyWebhookId` restricts delivery to a single hook (test button / ping).
 */
/**
 * Core dispatch: deliver `event` to every active org webhook subscribed to it.
 * Await this before returning the route response; fire-and-forget promises get
 * killed on serverless. Never throws, never rejects. `onlyWebhookId` restricts
 * delivery to a single hook (test button / ping).
 */
export async function emitWebhookEvent(
  orgClerkId: string,
  event: WebhookEvent,
  data: Record<string, unknown>,
  onlyWebhookId?: string
): Promise<void> {
  try {
    const hooks = await prisma.integrationWebhook.findMany({
      where: {
        org_clerk_id: orgClerkId,
        active: true,
        ...(onlyWebhookId ? { id: onlyWebhookId } : { events: { has: event } }),
      },
      select: { id: true, url: true, secret: true },
    });
    if (hooks.length === 0) return;
    await Promise.allSettled(hooks.map((h) => deliverOne(h, event, data)));
  } catch (e) {
    // Table missing (migration pending) or DB hiccup — never fail the caller.
    console.warn('[webhooks] emit failed:', e instanceof Error ? e.message : e);
  }
}

/** Ticket lifecycle events (ticket.created / ticket.status_changed). */
export async function emitTicketEvent(
  orgClerkId: string,
  event: WebhookEvent,
  data: TicketEventData | Record<string, unknown>,
  onlyWebhookId?: string
): Promise<void> {
  return emitWebhookEvent(orgClerkId, event, data as Record<string, unknown>, onlyWebhookId);
}

/** Alert lifecycle events (alert.opened / alert.resolved / alert.acknowledged). */
export async function emitAlertEvent(
  orgClerkId: string,
  event: WebhookEvent,
  data: AlertEventData | Record<string, unknown>,
  onlyWebhookId?: string
): Promise<void> {
  return emitWebhookEvent(orgClerkId, event, data as Record<string, unknown>, onlyWebhookId);
}
