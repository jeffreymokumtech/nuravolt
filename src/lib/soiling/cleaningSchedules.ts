import prisma from '@/libs/prisma';

/**
 * Shared adopt-a-cleaning-schedule logic. The optimizer UI, the chat
 * draft-confirm card, and the MCP approveCleaningSchedule tool all persist
 * through here so the economics derivation stays identical everywhere.
 */

export interface AdoptScheduleInput {
  plantId: string; // Plant.id (uuid)
  orgClerkId: string;
  userId: string;
  scheduleName: string;
  dates: string[]; // YYYY-MM-DD
  estimatedEnergyRecoveredMwh: number;
  estimatedRevenueRecoveredEur: number;
  estimatedCleaningCostEur: number;
  avgSrBaseline?: number;
  avgSrOptimized?: number;
  validFrom?: string;
  validTo?: string;
  createTickets?: boolean;
}

export interface AdoptedSchedule {
  id: string;
  scheduleName: string;
  dates: string[];
  nCleanings: number;
  netBenefitEur: number;
  roiPct: number;
  paybackDays: number;
  ticketIds: string[];
  createdAt: string;
}

export function deriveScheduleEconomics(input: {
  dates: string[];
  revenue: number;
  cleaningCost: number;
  validFrom?: string;
  validTo?: string;
}) {
  const sortedDates = [...input.dates].sort();
  const validFrom = input.validFrom
    ? new Date(input.validFrom)
    : new Date(sortedDates[0]);
  const validTo = input.validTo
    ? new Date(input.validTo)
    : new Date(sortedDates[sortedDates.length - 1]);
  const netBenefit = input.revenue - input.cleaningCost;
  const roiPct = (netBenefit / input.cleaningCost) * 100;
  const windowDays = Math.max(
    1,
    Math.round((validTo.getTime() - validFrom.getTime()) / (1000 * 60 * 60 * 24)),
  );
  const paybackDays =
    input.revenue > 0 ? input.cleaningCost / (input.revenue / windowDays) : windowDays;
  return { sortedDates, validFrom, validTo, netBenefit, roiPct, paybackDays };
}

export async function createCleaningSchedule(
  input: AdoptScheduleInput,
): Promise<AdoptedSchedule> {
  if (!input.dates.length) throw new Error('dates must not be empty');
  if (!(input.estimatedCleaningCostEur > 0)) {
    throw new Error('estimatedCleaningCostEur must be > 0');
  }

  const { sortedDates, validFrom, validTo, netBenefit, roiPct, paybackDays } =
    deriveScheduleEconomics({
      dates: input.dates,
      revenue: input.estimatedRevenueRecoveredEur,
      cleaningCost: input.estimatedCleaningCostEur,
      validFrom: input.validFrom,
      validTo: input.validTo,
    });

  const perCleaningCost = input.estimatedCleaningCostEur / sortedDates.length;

  const result = await prisma.$transaction(async (tx) => {
    const row = await tx.cleaningSchedule.create({
      data: {
        plant_id: input.plantId,
        schedule_name: input.scheduleName,
        recommended_dates: sortedDates,
        n_cleanings: sortedDates.length,
        energy_recovered_mwh: input.estimatedEnergyRecoveredMwh,
        revenue_recovered_eur: input.estimatedRevenueRecoveredEur,
        cleaning_cost_eur: input.estimatedCleaningCostEur,
        net_benefit_eur: netBenefit,
        roi_pct: roiPct.toFixed(2),
        payback_days: paybackDays.toFixed(1),
        avg_sr_baseline: (input.avgSrBaseline ?? 0.95).toFixed(5),
        avg_sr_optimized: (input.avgSrOptimized ?? 0.99).toFixed(5),
        is_optimal: true,
        valid_from: validFrom,
        valid_to: validTo,
      },
      select: { id: true, created_at: true },
    });

    const ticketIds: string[] = [];
    if (input.createTickets) {
      for (const date of sortedDates) {
        const ticket = await tx.ticket.create({
          data: {
            org_clerk_id: input.orgClerkId,
            plant_id: input.plantId,
            title: `Panel cleaning on ${date}`,
            description:
              `Scheduled cleaning from the adopted plan "${input.scheduleName}". ` +
              `Estimated cost ${perCleaningCost.toFixed(0)} EUR for this visit; ` +
              `plan net benefit ${netBenefit.toFixed(0)} EUR across ${sortedDates.length} cleanings.`,
            priority: 'MEDIUM',
            trigger_type: 'SCHEDULED_MAINTENANCE',
            // Ticket links back to the plan via trigger_id (the generic
            // source-reference field; Ticket has no dedicated FK).
            trigger_id: row.id,
            history: {
              create: {
                new_status: 'NEW',
                new_priority: 'MEDIUM',
                changed_by_clerk_id: input.userId,
                change_reason: 'Created from adopted cleaning schedule',
              },
            },
          },
          select: { id: true },
        });
        ticketIds.push(ticket.id);
      }
    }

    return { row, ticketIds };
  });

  return {
    id: result.row.id,
    scheduleName: input.scheduleName,
    dates: sortedDates,
    nCleanings: sortedDates.length,
    netBenefitEur: Number(netBenefit.toFixed(2)),
    roiPct: Number(roiPct.toFixed(2)),
    paybackDays: Number(paybackDays.toFixed(1)),
    ticketIds: result.ticketIds,
    createdAt: result.row.created_at.toISOString(),
  };
}

/** Schedules for a plant, newest first, with their linked ticket ids. */
export async function listCleaningSchedules(plantId: string) {
  const rows = await prisma.cleaningSchedule.findMany({
    where: { plant_id: plantId },
    orderBy: { created_at: 'desc' },
    take: 10,
  });
  const tickets = await prisma.ticket.findMany({
    where: { trigger_id: { in: rows.map((r) => r.id) } },
    select: { id: true, trigger_id: true, title: true, status: true },
  });
  return rows.map((r) => ({
    id: r.id,
    scheduleName: r.schedule_name,
    dates: (r.recommended_dates as string[]) ?? [],
    nCleanings: r.n_cleanings,
    energyRecoveredMwh: Number(r.energy_recovered_mwh),
    revenueRecoveredEur: Number(r.revenue_recovered_eur),
    cleaningCostEur: Number(r.cleaning_cost_eur),
    netBenefitEur: Number(r.net_benefit_eur),
    roiPct: Number(r.roi_pct),
    paybackDays: Number(r.payback_days),
    validFrom: r.valid_from.toISOString().slice(0, 10),
    validTo: r.valid_to.toISOString().slice(0, 10),
    createdAt: r.created_at.toISOString(),
    tickets: tickets
      .filter((t) => t.trigger_id === r.id)
      .map((t) => ({ id: t.id, title: t.title, status: t.status })),
  }));
}
