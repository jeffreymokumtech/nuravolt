import prisma from '@/libs/prisma';

/**
 * Product usage audit trail, written fire-and-forget from mutating routes
 * (and one row per chat turn). Read ONLY by the founder-gated /admin/usage
 * page; org users never see these rows.
 *
 * recordActivity never throws and is not awaited by callers on the hot
 * path — a tracking failure must never fail the user's action.
 */

export interface ActivityInput {
  orgClerkId: string;
  userId?: string | null;
  /** Snapshot label; pass when you already have the user's name/email. */
  userLabel?: string | null;
  /** Dotted verb: "ticket.created", "alert.acknowledged", "chat.turn", ... */
  action: string;
  targetType?: string;
  targetId?: string;
  plantId?: string | null;
  metadata?: Record<string, unknown>;
}

export function recordActivity(input: ActivityInput): void {
  void (async () => {
    try {
      let label = input.userLabel ?? null;
      if (!label && input.userId) {
        const u = await prisma.user.findUnique({
          where: { id: input.userId },
          select: { name: true, email: true },
        });
        label = u?.name || u?.email || null;
      }
      await prisma.activityEvent.create({
        data: {
          org_clerk_id: input.orgClerkId,
          user_id: input.userId ?? null,
          user_label: label,
          action: input.action,
          target_type: input.targetType ?? null,
          target_id: input.targetId ?? null,
          plant_id: input.plantId ?? null,
          metadata: (input.metadata as never) ?? undefined,
        },
      });
    } catch (e) {
      console.warn('[activity] record failed:', e instanceof Error ? e.message : e);
    }
  })();
}
