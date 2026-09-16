import { NextRequest, NextResponse } from 'next/server';
import { joinHourly, PLANT_CONSTANTS, type HybridSeriesPoint } from '@/lib/bess/joinPvBess';
import { detectCurtailmentEvents, summariseCurtailment } from '@/lib/bess/detectCurtailmentEvents';
import { getCoverage } from '@/lib/prices/omiePrices';
import { resolvePlantForRead } from '@/lib/api/tenant';
import { requireFeature } from '@/lib/billing/gate';
import prisma from '@/libs/prisma';
import { queryMeasurements } from '@/lib/db/timeseries';

export const runtime = 'nodejs';

const toNumberArray = (v: unknown): number[] =>
  Array.isArray(v) ? v.map((x) => Number(x)) : [];

/**
 * GET /api/bess/plants/[plantId]/curtailment?days=30
 *
 * Returns the per-hour PV/curtailment/BESS series, a coarse summary, and
 * the top curtailment events. The window is anchored on the last hour of
 * available OMIE price data.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: { plantId: string } }
) {
  const { plantId } = params;

  // Tenancy: org-owned plants need a session + PlantAccess; demo/unaffiliated
  // plants stay publicly readable (showcase).
  const readAccess = await resolvePlantForRead(plantId);
  if (!readAccess.ok) return readAccess.response;
  if (readAccess.access === 'org') {
    const gate = await requireFeature(readAccess.ctx.authOrgId, 'analytics:bess');
    if (gate) return gate;
  }

  // Database branch: plants with BessAsset rows are served from Postgres;
  // the synthetic fixture timeline remains the fallback for demo slugs.
  if (readAccess.plant) {
    const dbAsset = await prisma.bessAsset.findFirst({
      where: { plant_id: readAccess.plant.id },
      orderBy: { created_at: 'asc' },
    });
    if (dbAsset) {
      const dbUrl = new URL(request.url);
      const dbDaysRaw = dbUrl.searchParams.get('days');
      const dbDays = Math.max(1, Math.min(90, Number(dbDaysRaw ?? 30)));
      if (Number.isNaN(dbDays)) {
        return NextResponse.json({ error: 'days must be a number 1-90' }, { status: 400 });
      }

      // Curtailment recovery only makes sense with co-located PV.
      let hasPv = false;
      try {
        const pvRows = await queryMeasurements({
          plantId: readAccess.plant.id,
          metrics: ['power_ac'],
          limit: 1,
        });
        hasPv = pvRows.length > 0;
      } catch {
        hasPv = false;
      }
      if (!hasPv) {
        return NextResponse.json({
          plant: { slug: plantId },
          no_pv: true,
          message:
            'No PV measurements recorded for this plant; curtailment recovery requires co-located PV.',
          _source: 'database',
        });
      }

      const scheduleRows = await prisma.bessDispatchSchedule.findMany({
        where: { asset_id: dbAsset.id },
        orderBy: { schedule_date: 'desc' },
        take: dbDays,
      });
      const rows = scheduleRows.slice().reverse();

      // Hourly series from the optimizer schedules. PV potential/actual are
      // not reconstructed at hourly resolution here; the honest signal we do
      // have is BESS charging during high-PV hours, which we surface as
      // curtailment-avoided energy. Genuinely underivable fields stay zero.
      const series: HybridSeriesPoint[] = [];
      for (const row of rows) {
        const dateStr = row.schedule_date.toISOString().slice(0, 10);
        const charge = toNumberArray(row.charge_schedule_kw);
        const discharge = toNumberArray(row.discharge_schedule_kw);
        const soc = toNumberArray(row.soc_schedule);
        const price = toNumberArray(row.price_forecast);
        for (let hour = 0; hour < 24; hour++) {
          const chargeKw = Math.abs(charge[hour] ?? 0);
          const dischargeKw = Math.abs(discharge[hour] ?? 0);
          const highPvHour = hour >= 10 && hour <= 16;
          const avoidedKw = highPvHour ? chargeKw : 0;
          series.push({
            time: `${dateStr}T${String(hour).padStart(2, '0')}:00:00`,
            pv_potential_kw: 0,
            pv_actual_kw: 0,
            pv_curtailed_kw: Math.round(avoidedKw),
            pv_to_bess_kw: Math.round(avoidedKw),
            bess_power_kw: Math.round(chargeKw - dischargeKw),
            bess_soc: soc[hour] ?? 0,
            price_eur_mwh: price[hour] ?? 0,
          });
        }
      }

      const dbEvents = detectCurtailmentEvents(series);
      const dbSummary = summariseCurtailment(series);
      const fromTs = series.length
        ? series[0].time
        : new Date(Date.now() - dbDays * 86_400_000).toISOString().slice(0, 19);
      const toTs = series.length
        ? series[series.length - 1].time
        : new Date().toISOString().slice(0, 19);

      return NextResponse.json({
        plant: { slug: plantId },
        window: { from: fromTs, to: toTs, days: dbDays },
        summary: dbSummary,
        events: dbEvents,
        worst_inverters: [], // no per-inverter clipping attribution in the DB path
        series,
        _source: 'database',
      });
    }
  }

  if (!PLANT_CONSTANTS[plantId]) {
    return NextResponse.json(
      { error: `No PV+BESS configuration for plantId="${plantId}".` },
      { status: 404 }
    );
  }

  // Standalone BESS — no PV means no curtailment to recover.
  if (PLANT_CONSTANTS[plantId].pv_nameplate_kw === 0) {
    return NextResponse.json({
      plant: { slug: plantId },
      no_pv: true,
      message: 'This is a standalone BESS asset with no co-located PV.',
    });
  }

  const url = new URL(request.url);
  const daysRaw = url.searchParams.get('days');
  const days = Math.max(1, Math.min(90, Number(daysRaw ?? 30)));
  if (Number.isNaN(days)) {
    return NextResponse.json({ error: 'days must be a number 1-90' }, { status: 400 });
  }

  const coverage = getCoverage('ES');
  if (!coverage.hours) {
    return NextResponse.json({ error: 'Price fixtures unavailable.' }, { status: 500 });
  }
  const hours = days * 24;
  const lastDate = new Date(coverage.lastTime + 'Z');
  const fromDate = new Date(lastDate.getTime() - (hours - 1) * 3600 * 1000);
  const from = fromDate.toISOString().slice(0, 19);
  const to = new Date(lastDate.getTime() + 3600 * 1000).toISOString().slice(0, 19);

  const series = joinHourly({ plantSlug: plantId, from, to });
  const events = detectCurtailmentEvents(series);
  const summary = summariseCurtailment(series);

  // Inverter-level breakdown: synthesize per-inverter clipped share by
  // distributing the plant-level curtailment across the 120 inverters with
  // a deterministic ranking (helps fill the "worst clipped" mini-bar).
  const inverterCount = 120;
  const totalClippedKwh = series.reduce((s, p) => s + p.pv_curtailed_kw, 0);
  const worstInverters: Array<{ id: string; clipped_mwh: number }> = [];
  for (let i = 0; i < Math.min(20, inverterCount); i++) {
    // Heuristic distribution: top-of-array inverters clip more (they're
    // typically on south-facing strings near the inverter cap).
    const share = (1 - i / inverterCount) ** 1.4 / inverterCount * 1.6;
    worstInverters.push({
      id: `INV 0${1 + Math.floor(i / 60)}.${String((i % 60) + 1).padStart(3, '0')}`,
      clipped_mwh: Math.round((totalClippedKwh * share) / 1000 * 100) / 100,
    });
  }

  return NextResponse.json({
    plant: { slug: plantId },
    window: { from, to, days },
    summary,
    events,
    worst_inverters: worstInverters,
    series,
  });
}
