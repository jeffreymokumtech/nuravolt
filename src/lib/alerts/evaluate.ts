import type { Plant, PlantAlert, PlantAlertKind, PlantAlertSeverity } from '@prisma/client';
import prisma from '@/libs/prisma';
import { queryAnalysisResults } from '@/lib/db/timeseries';
import { settingsFromMetadata } from '@/lib/plants/settings';

/**
 * Threshold evaluation for plant alerts. Called by /api/cron/evaluate-alerts.
 *
 * V1 rules (chosen for reliability from what the pipeline actually writes):
 *   SOILING_LOSS       latest soiling loss %  vs settings.alerts.soilingLossPct
 *                      (soiling rows are a FORWARD-DATED forecast — the query
 *                      is bounded to now+3d and takes the newest row, exactly
 *                      like the soiling summary route, or it would alert on a
 *                      forecast a year out)
 *   PERFORMANCE_RATIO  trailing-7d Σactual/Σpredicted from the digital twin's
 *                      daily aggregate (only days with BOTH metrics; needs ≥3
 *                      measured days) vs settings.alerts.performanceRatioPct
 *   DATA_STALE         newest LatestDeviceSnapshot across the plant's
 *                      connections older than 6h (only for OPERATIONAL plants
 *                      with at least one connection)
 *   BESS_SAFETY        state of safety (worst-of composite, computed by
 *                      nuravolt.bess.pipeline and published as the
 *                      `bess_state_of_safety` analysis artifact) below the
 *                      MODERATE band floor, one row per storage device
 *
 * State machine per (plant, kind, dedup_key):
 *   breach + no ACTIVE row → open (returns the row for notification)
 *   breach + ACTIVE row    → update value/last_seen; escalate WARNING→CRITICAL
 *                            (escalation is the only re-notification)
 *   clear (with hysteresis) + ACTIVE row → resolve
 *   breach + recent RESOLVED (<24h)      → reopen silently (flap guard,
 *                                          keeps original notified_at)
 *
 * dedup_key stays null for the plant-wide kinds (one row per plant per kind).
 * BESS_SAFETY sets it so one bad rack opens one alert instead of one per day,
 * and two bad racks stay two separate alerts.
 */

const STALE_LIMIT_MINUTES = 360;
const SOILING_HYSTERESIS_PP = 0.5;
const PR_HYSTERESIS_PP = 1.0;
const FLAP_GUARD_HOURS = 24;

export interface RuleReading {
  kind: PlantAlertKind;
  /** Observed value; null = rule not evaluable for this plant (skip). */
  value: number | null;
  threshold: number;
  /** True when the value breaches the threshold. */
  breached: boolean;
  /** True when the value clears the threshold incl. hysteresis margin. */
  cleared: boolean;
  severity: PlantAlertSeverity;
  message: string;
  context?: Record<string, unknown>;
  /**
   * Sub-plant identity for kinds that can fire more than once per plant.
   * Undefined for the plant-wide kinds, which stay keyed on (plant, kind).
   */
  dedupKey?: string;
}

export interface PlantEvaluation {
  plantId: string;
  slug: string;
  readings: RuleReading[];
  /** Newly opened or escalated CRITICAL alerts → candidates for email. */
  notify: PlantAlert[];
  opened: number;
  resolved: number;
  escalated: number;
}

// ---------------------------------------------------------------------------
// Rule evaluators (pure reads)
// ---------------------------------------------------------------------------

async function readSoilingLoss(plant: Plant, threshold: number): Promise<RuleReading | null> {
  // Newest soiling row no further than 3 days out (mirrors the summary route).
  const to = new Date(Date.now() + 3 * 86_400_000);
  const rows = (await queryAnalysisResults({
    plantId: plant.id,
    domain: 'soiling',
    metrics: ['soiling_loss_pct', 'fleet_sr_mean'],
    to,
    limit: 50,
  })) as { metric: string; value: number; time: Date }[];
  if (!rows.length) return null;

  const lossRow = rows.find((r) => r.metric === 'soiling_loss_pct');
  const srRow = rows.find((r) => r.metric === 'fleet_sr_mean');
  const value =
    lossRow?.value ?? (srRow != null ? (1 - Number(srRow.value)) * 100 : null);
  if (value == null || !Number.isFinite(value)) return null;

  const critical = value >= threshold * 1.5;
  return {
    kind: 'SOILING_LOSS',
    value: Number(value.toFixed(2)),
    threshold,
    breached: value >= threshold,
    cleared: value < threshold - SOILING_HYSTERESIS_PP,
    severity: critical ? 'CRITICAL' : 'WARNING',
    message: `Soiling loss ${value.toFixed(1)}% exceeds the ${threshold}% alert threshold`,
    context: { source: lossRow ? 'soiling_loss_pct' : 'fleet_sr_mean' },
  };
}

async function readPerformanceRatio(plant: Plant, threshold: number): Promise<RuleReading | null> {
  const from = new Date(Date.now() - 7 * 86_400_000);
  const rows = (await queryAnalysisResults({
    plantId: plant.id,
    domain: 'digitaltwin',
    deviceId: 'PLANT',
    metrics: ['power_ac_predicted', 'power_ac_actual'],
    from,
    resolution: 'daily',
    limit: 40,
  })) as { bucket: Date; metric: string; avg_value: number; sample_count: number }[];
  if (!rows.length) return null;

  // Group by day; keep only days carrying BOTH metrics (measured days).
  const byDay = new Map<string, { pred?: number; act?: number }>();
  for (const r of rows) {
    const day = new Date(r.bucket).toISOString().slice(0, 10);
    const entry = byDay.get(day) ?? {};
    const energy = Number(r.avg_value) * Number(r.sample_count ?? 1);
    if (r.metric === 'power_ac_predicted') entry.pred = (entry.pred ?? 0) + energy;
    if (r.metric === 'power_ac_actual') entry.act = (entry.act ?? 0) + energy;
    byDay.set(day, entry);
  }
  let pred = 0;
  let act = 0;
  let measuredDays = 0;
  for (const e of byDay.values()) {
    if (e.pred != null && e.act != null && e.pred > 0) {
      pred += e.pred;
      act += e.act;
      measuredDays++;
    }
  }
  if (measuredDays < 3 || pred <= 0) return null;

  const pr = (act / pred) * 100;
  const critical = pr < threshold - 10;
  return {
    kind: 'PERFORMANCE_RATIO',
    value: Number(pr.toFixed(2)),
    threshold,
    breached: pr < threshold,
    cleared: pr > threshold + PR_HYSTERESIS_PP,
    severity: critical ? 'CRITICAL' : 'WARNING',
    message: `7-day performance ratio ${pr.toFixed(1)}% is below the ${threshold}% floor`,
    context: { window_days: 7, measured_days: measuredDays },
  };
}

// Only these connector types are actually polled (poll-connections cron);
// csv/SCADA/Influx connections never refresh LatestDeviceSnapshot, so
// "staleness" is meaningless for them and would be a permanent false alarm.
const POLLED_CONNECTOR_TYPES = ['huawei_api', 'solaredge_api', 'sample_api'] as const;

async function readDataStale(plant: Plant): Promise<RuleReading | null> {
  if (plant.status !== 'OPERATIONAL') return null;
  const sources = await prisma.plantDataSource.findMany({
    where: {
      plant_id: plant.id,
      connection_id: { not: null },
      connection: { type: { in: [...POLLED_CONNECTOR_TYPES] as any }, enabled: true },
    },
    select: { connection_id: true },
  });
  const connectionIds = sources
    .map((s) => s.connection_id)
    .filter((c): c is string => Boolean(c));
  if (connectionIds.length === 0) return null;

  const newest = await prisma.latestDeviceSnapshot.findFirst({
    where: { connection_id: { in: connectionIds } },
    orderBy: { ts: 'desc' },
    select: { ts: true },
  });
  if (!newest) return null;

  const staleMinutes = Math.round((Date.now() - newest.ts.getTime()) / 60_000);
  return {
    kind: 'DATA_STALE',
    value: staleMinutes,
    threshold: STALE_LIMIT_MINUTES,
    breached: staleMinutes > STALE_LIMIT_MINUTES,
    cleared: staleMinutes <= STALE_LIMIT_MINUTES,
    severity: 'CRITICAL',
    message: `No data received for ${Math.round(staleMinutes / 60)}h (limit ${STALE_LIMIT_MINUTES / 60}h)`,
    context: { stale_minutes: staleMinutes, connections: connectionIds.length },
  };
}

// ---------------------------------------------------------------------------
// BESS state of safety
// ---------------------------------------------------------------------------

/**
 * Canonical safety disclosure. Mirrors `safety_disclosure()` in
 * nuravolt/bess/thermal_monitor.py word for word so the alert email, the
 * console and the PDF report all say the same thing. When the published
 * artifact carries its own `disclosure` we prefer that string: the pipeline
 * measured the real cadence, this is only the fallback.
 *
 * It is a differentiator, not a weakness. Cloud poll cadence is 5 to 15
 * minutes and thermal runaway propagates in seconds to minutes; saying so is
 * what separates an honest trend indicator from a safety claim we cannot make.
 */
export function bessSafetyDisclosure(intervalMinutes?: number | null): string {
  const interval =
    intervalMinutes != null && Number.isFinite(intervalMinutes) && intervalMinutes > 0
      ? `${intervalMinutes} minute`
      : 'periodic';
  return (
    `State of safety is a trend and margin indicator computed from ${interval} ` +
    'cloud telemetry. It is not a protection system and must not be relied on ' +
    'for emergency response. Your BMS and fire detection system are.'
  );
}

/** Artifact kind written by the BESS pipeline publish step. */
export const BESS_SAFETY_ARTIFACT_KIND = 'bess_state_of_safety';

/** MODERATE band floor from nuravolt.bess.thermal_monitor.SAFETY_BANDS. */
const BESS_SAFETY_FLOOR = 60;
/** CRITICAL band floor from the same table. */
const BESS_SAFETY_CRITICAL_BAND = 40;
/** Hysteresis in score points, so a score hovering on 60 does not flap. */
const BESS_SAFETY_HYSTERESIS = 5;
/**
 * A safety snapshot this old is not evidence of anything. We stop evaluating
 * rather than either alerting forever on a frozen number or resolving a real
 * breach because the publisher stopped running. Stale feeds are DATA_STALE's job.
 */
const BESS_SAFETY_MAX_AGE_HOURS = 48;

/**
 * Only these sub indices can raise a CRITICAL. Imbalance and dwell exposure are
 * developing-fault and warranty-stress signals: real, worth a work order, not
 * worth waking someone at 3am off 15 minute cloud telemetry.
 */
const CRITICAL_LIMITING_INDICES = new Set(['thermal_margin', 'protection_status']);

export interface BessSafetyDeviceReading {
  asset_id?: string;
  device_id?: string;
  device_label?: string;
  score?: number | null;
  band?: string | null;
  limiting_index?: string | null;
  unavailable?: string[];
}

export interface BessSafetyArtifact {
  evaluated_at?: string;
  interval_minutes?: number | null;
  disclosure?: string;
  readings?: BessSafetyDeviceReading[];
}

const humanIndex = (name: string): string => name.replace(/_/g, ' ');

/**
 * Map a published state-of-safety artifact onto alert readings. Pure, so the
 * banding and the dedup key are testable without a database.
 */
export function bessSafetyReadings(payload: BessSafetyArtifact | null): RuleReading[] {
  const rows = Array.isArray(payload?.readings) ? payload!.readings : [];
  const disclosure =
    typeof payload?.disclosure === 'string' && payload.disclosure.trim()
      ? payload.disclosure.trim()
      : bessSafetyDisclosure(payload?.interval_minutes ?? null);

  const readings: RuleReading[] = [];
  for (const row of rows) {
    const score = row?.score;
    // A null score means no sub index had data. That is a "connect your BMS"
    // state for the UI to render, never an alert and never a clear.
    if (score == null || !Number.isFinite(score)) continue;

    const assetId = String(row.asset_id ?? '').trim();
    const deviceId = String(row.device_id ?? '').trim();
    if (!assetId || !deviceId) continue;

    const limiting = row.limiting_index ? String(row.limiting_index) : null;
    const critical =
      score < BESS_SAFETY_CRITICAL_BAND &&
      limiting != null &&
      CRITICAL_LIMITING_INDICES.has(limiting);

    const label = row.device_label?.trim() || deviceId;
    const cause = limiting ? `, limited by ${humanIndex(limiting)}` : '';

    readings.push({
      kind: 'BESS_SAFETY',
      value: Math.round(score),
      threshold: BESS_SAFETY_FLOOR,
      breached: score < BESS_SAFETY_FLOOR,
      cleared: score > BESS_SAFETY_FLOOR + BESS_SAFETY_HYSTERESIS,
      severity: critical ? 'CRITICAL' : 'WARNING',
      message:
        `State of safety ${Math.round(score)} out of 100 for ${label}${cause}. ` +
        disclosure,
      // rule token is constant on purpose: the limiting index can move between
      // runs and a key that moved with it would abandon the open row.
      dedupKey: `${assetId}:state_of_safety:${deviceId}`,
      context: {
        asset_id: assetId,
        device_id: deviceId,
        limiting_index: limiting,
        band: row.band ?? null,
        unavailable: row.unavailable ?? [],
        interval_minutes: payload?.interval_minutes ?? null,
        disclosure,
      },
    });
  }
  return readings;
}

async function readBessSafety(plant: Plant): Promise<RuleReading[]> {
  const artifact = await prisma.analysisArtifact.findUnique({
    where: { plant_id_kind: { plant_id: plant.id, kind: BESS_SAFETY_ARTIFACT_KIND } },
    select: { payload: true, generated_at: true },
  });
  if (!artifact) return [];

  const ageHours = (Date.now() - artifact.generated_at.getTime()) / 3_600_000;
  if (ageHours > BESS_SAFETY_MAX_AGE_HOURS) return [];

  return bessSafetyReadings(artifact.payload as BessSafetyArtifact | null);
}

// ---------------------------------------------------------------------------
// State machine
// ---------------------------------------------------------------------------

async function applyReading(
  plant: Plant,
  orgClerkId: string,
  reading: RuleReading,
  dryRun: boolean,
): Promise<{ opened?: PlantAlert; escalated?: PlantAlert; resolved?: boolean }> {
  // dedup_key is null for the plant-wide kinds, so `dedup_key: null` matches
  // exactly the rows those kinds have always written.
  const dedupKey = reading.dedupKey ?? null;
  const active = await prisma.plantAlert.findFirst({
    where: { plant_id: plant.id, kind: reading.kind, dedup_key: dedupKey, status: 'ACTIVE' },
  });

  if (reading.breached) {
    if (active) {
      const escalate = active.severity === 'WARNING' && reading.severity === 'CRITICAL';
      if (!dryRun) {
        await prisma.plantAlert.update({
          where: { id: active.id },
          data: {
            metric_value: reading.value!,
            last_seen_at: new Date(),
            ...(escalate ? { severity: 'CRITICAL', message: reading.message } : {}),
          },
        });
      }
      return escalate ? { escalated: active } : {};
    }

    // Flap guard: a breach shortly after a resolve reopens silently. Manual
    // resolves (context.manual_resolve, set by the alerts PATCH route) are
    // exempt — silently reopening the same row would undo the operator's
    // explicit action; a persisting condition opens a fresh, notified row.
    const recentResolved = await prisma.plantAlert.findFirst({
      where: {
        plant_id: plant.id,
        kind: reading.kind,
        dedup_key: dedupKey,
        status: 'RESOLVED',
        resolved_at: { gte: new Date(Date.now() - FLAP_GUARD_HOURS * 3_600_000) },
      },
      orderBy: { resolved_at: 'desc' },
    });
    if (recentResolved && (recentResolved.context as any)?.manual_resolve) {
      // fall through to open a new row below
    } else if (recentResolved) {
      if (!dryRun) {
        await prisma.plantAlert.update({
          where: { id: recentResolved.id },
          data: {
            status: 'ACTIVE',
            resolved_at: null,
            metric_value: reading.value!,
            severity: reading.severity,
            last_seen_at: new Date(),
          },
        });
      }
      return {};
    }

    if (dryRun) {
      return {
        opened: {
          id: 'dry-run',
          plant_id: plant.id,
          kind: reading.kind,
          dedup_key: dedupKey,
          severity: reading.severity,
          metric_value: reading.value,
          threshold: reading.threshold,
          message: reading.message,
        } as unknown as PlantAlert,
      };
    }
    const opened = await prisma.plantAlert.create({
      data: {
        org_clerk_id: orgClerkId,
        plant_id: plant.id,
        kind: reading.kind,
        dedup_key: dedupKey,
        severity: reading.severity,
        metric_value: reading.value!,
        threshold: reading.threshold,
        message: reading.message,
        context: (reading.context ?? {}) as object,
      },
    });
    return { opened };
  }

  if (active && reading.cleared) {
    if (!dryRun) {
      await prisma.plantAlert.update({
        where: { id: active.id },
        data: { status: 'RESOLVED', resolved_at: new Date(), metric_value: reading.value! },
      });
    }
    return { resolved: true };
  }

  return {};
}

/** Evaluate all v1 rules for one plant and apply state transitions. */
export async function evaluatePlant(
  plant: Plant,
  orgClerkId: string,
  dryRun = false,
): Promise<PlantEvaluation> {
  const settings = settingsFromMetadata(plant.metadata);
  const [single, bess] = await Promise.all([
    Promise.all([
      readSoilingLoss(plant, settings.alerts.soilingLossPct),
      readPerformanceRatio(plant, settings.alerts.performanceRatioPct),
      readDataStale(plant),
    ]),
    // Storage safety fans out: one reading per BESS device, so a plant with
    // four racks can carry four independent alerts.
    readBessSafety(plant),
  ]);
  const readings = [...single.filter((r): r is RuleReading => r !== null), ...bess];

  const result: PlantEvaluation = {
    plantId: plant.id,
    slug: plant.slug,
    readings,
    notify: [],
    opened: 0,
    resolved: 0,
    escalated: 0,
  };

  for (const reading of readings) {
    const outcome = await applyReading(plant, orgClerkId, reading, dryRun);
    if (outcome.opened) {
      result.opened++;
      // Notify on every newly opened alert (WARNING included, not just
      // CRITICAL). The cron gates email per severity (emailCritical /
      // emailWarning) and delivers alert webhooks to subscribers.
      result.notify.push(outcome.opened);
    }
    if (outcome.escalated) {
      result.escalated++;
      result.notify.push(outcome.escalated);
    }
    if (outcome.resolved) result.resolved++;
  }
  return result;
}
