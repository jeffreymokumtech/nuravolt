import prisma from '@/libs/prisma';

export type AuditStatus = 'success' | 'error' | 'forbidden' | 'rate_limited';

export interface AuditRow {
  apiKeyId: string;
  orgClerkId: string;
  toolName: string;
  args: unknown;
  status: AuditStatus;
  durationMs: number;
  errorReason?: string;
  /** Caller-supplied idempotency key (null for reads). */
  idempotencyKey?: string | null;
  /** Tool result JSON. Stored so idempotent replays can return the same value. */
  result?: unknown;
  ticketId?: string | null;
  cleaningScheduleId?: string | null;
}

/**
 * Write a tool-call audit row. Failures to persist the audit row are
 * swallowed (logging side-channel must never break the tool call), but
 * surface in server logs.
 */
export async function recordToolCall(row: AuditRow): Promise<void> {
  try {
    await prisma.mcpToolCall.create({
      data: {
        api_key_id: row.apiKeyId,
        org_clerk_id: row.orgClerkId,
        tool_name: row.toolName,
        args_json: row.args as any,
        status: row.status,
        error_reason: row.errorReason ?? null,
        duration_ms: row.durationMs,
        idempotency_key: row.idempotencyKey ?? null,
        result_json: (row.result ?? null) as any,
        ticket_id: row.ticketId ?? null,
        cleaning_schedule_id: row.cleaningScheduleId ?? null,
      },
    });
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error('[mcp/audit] failed to persist tool-call row', e);
  }
}

/**
 * Look up a prior successful call for an idempotent replay. Returns the
 * stored result if one exists. We only return prior `success` rows — a
 * caller that retries after a failure should get a fresh attempt.
 */
export async function findIdempotentResult(
  apiKeyId: string,
  toolName: string,
  idempotencyKey: string,
): Promise<{ result: unknown; ticketId: string | null; cleaningScheduleId: string | null } | null> {
  const row = await prisma.mcpToolCall.findFirst({
    where: {
      api_key_id: apiKeyId,
      tool_name: toolName,
      idempotency_key: idempotencyKey,
      status: 'success',
    },
    select: {
      result_json: true,
      ticket_id: true,
      cleaning_schedule_id: true,
    },
  });
  if (!row) return null;
  return {
    result: row.result_json,
    ticketId: row.ticket_id,
    cleaningScheduleId: row.cleaning_schedule_id,
  };
}
