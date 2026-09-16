import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/libs/prisma';
import { resolvePlantForRead } from '@/lib/api/tenant';
import { readArtifact } from '@/lib/analysis/artifacts';
import { settingsFromMetadata } from '@/lib/plants/settings';

/**
 * GET /api/plants/[plantId]/source-candidates
 *
 * Read-only inventory of the data sources a plant could use for irradiance
 * and for its soiling reference, with live availability/health, plus the
 * currently selected preference (Plant.metadata.settings.dataSources) and a
 * data-quality recommendation derived from the quality_correlation artifact.
 *
 * Confidence figures mirror the pipeline's fallback ladder
 * (nuravolt/weather/fallback.py): onsite 0.95, open-meteo 0.75.
 *
 * The preference itself is written through PUT /api/plants/[plantId]/settings
 * — this route never mutates anything.
 */

export const dynamic = 'force-dynamic';

interface SourceCandidate {
  id: string;
  label: string;
  available: boolean;
  disabledReason: string | null;
  health: 'ok' | 'stale' | 'missing';
  lastSampleAgeMinutes: number | null;
  confidence: number;
  description: string;
}

const STALE_AFTER_MIN = 6 * 60;

function healthFromAge(ageMin: number | null): 'ok' | 'stale' | 'missing' {
  if (ageMin == null) return 'missing';
  return ageMin <= STALE_AFTER_MIN ? 'ok' : 'stale';
}

export async function GET(
  _request: NextRequest,
  { params }: { params: { plantId: string } },
) {
  const result = await resolvePlantForRead(params.plantId);
  if (!result.ok) return result.response;
  const plant = result.plant;
  if (!plant) {
    return NextResponse.json({ error: 'plant_not_found' }, { status: 404 });
  }

  // Live stream inventory — same raw-SQL shape as the quality/today scan.
  let irradianceAgeMin: number | null = null;
  let dustAgeMin: number | null = null;
  let inverterPowerStreams = 0;
  try {
    const rows = await prisma.$queryRaw<
      Array<{ device_id: string; metric: string; last_time: Date }>
    >`SELECT device_id, metric, MAX(time) AS last_time
      FROM measurements
      WHERE plant_id::text = ${plant.id} AND time >= NOW() - INTERVAL '35 days'
      GROUP BY device_id, metric
      ORDER BY device_id, metric`;
    const now = Date.now();
    for (const r of rows) {
      // Seeded/QA plants can carry samples stamped slightly ahead of
      // wall-clock — clamp so "age" never reads negative.
      const ageMin = Math.max(0, Math.round((now - new Date(r.last_time).getTime()) / 60000));
      if (/irradiance|ghi|poa/i.test(r.metric)) {
        irradianceAgeMin = irradianceAgeMin == null ? ageMin : Math.min(irradianceAgeMin, ageMin);
      }
      if (/dustiq|soiling/i.test(r.metric)) {
        dustAgeMin = dustAgeMin == null ? ageMin : Math.min(dustAgeMin, ageMin);
      }
      if (/power/i.test(r.metric)) inverterPowerStreams += 1;
    }
  } catch {
    // measurements table absent (fixture-only envs) — candidates fall back to
    // the plant's declared sensor flags below.
  }

  const hasOnsiteIrradiance = irradianceAgeMin != null || Boolean(plant.has_weather_station);
  const hasDustiq = dustAgeMin != null || Boolean(plant.has_dustiq_sensor);

  // Inferred per-inverter reference needs either an existing per-inverter
  // artifact or enough inverter streams to self-normalize.
  const perInverter = await readArtifact(plant.id, 'per_inverter');
  const canInfer = perInverter != null || inverterPowerStreams >= 2;

  const irradiance: SourceCandidate[] = [
    {
      id: 'onsite',
      label: plant.irradiance_sensor_type
        ? `On-site sensor (${plant.irradiance_sensor_type})`
        : 'On-site sensor',
      available: hasOnsiteIrradiance,
      disabledReason: hasOnsiteIrradiance ? null : 'No on-site irradiance sensor detected',
      health: healthFromAge(irradianceAgeMin),
      lastSampleAgeMinutes: irradianceAgeMin,
      confidence: 0.95,
      description: 'Pyranometer / reference cell at the plant — highest fidelity when healthy.',
    },
    {
      id: 'open_meteo',
      label: 'Open-Meteo satellite',
      available: true,
      disabledReason: null,
      health: 'ok',
      lastSampleAgeMinutes: null,
      confidence: 0.75,
      description: 'ERA5 + satellite blend at the plant location — always available, no hardware.',
    },
  ];

  const soilingReference: SourceCandidate[] = [
    {
      id: 'dustiq',
      label: 'DustIQ sensor',
      available: hasDustiq,
      disabledReason: hasDustiq ? null : 'No soiling sensor detected',
      health: healthFromAge(dustAgeMin),
      lastSampleAgeMinutes: dustAgeMin,
      confidence: 0.95,
      description: 'Optical soiling sensor — anchors the per-inverter estimates to a measured ratio.',
    },
    {
      id: 'inferred',
      label: 'Inferred per-inverter',
      available: canInfer,
      disabledReason: canInfer
        ? null
        : 'Needs at least 2 inverter power streams to self-normalize',
      health: canInfer ? 'ok' : 'missing',
      lastSampleAgeMinutes: null,
      confidence: 0.8,
      description: 'Soiling estimated from measured per-inverter performance — no extra hardware.',
    },
  ];

  // Recommendation from the quality correlation artifact (majority of zone
  // betterSource verdicts across uniform periods).
  let recommendation: { irradiance: 'onsite' | 'open_meteo' | null; reason: string } = {
    irradiance: null,
    reason: 'No correlation analysis available yet.',
  };
  try {
    const corr = await readArtifact<{
      overallAnalysis?: {
        uniformPeriods?: {
          zoneCorrelations?: Array<{ betterSource?: string }>;
        };
      };
    }>(plant.id, 'quality_correlation');
    const zones = corr?.payload?.overallAnalysis?.uniformPeriods?.zoneCorrelations ?? [];
    if (zones.length > 0) {
      const votes = { on_site: 0, open_meteo: 0, similar: 0 };
      for (const z of zones) {
        const v = z.betterSource as keyof typeof votes;
        if (v in votes) votes[v] += 1;
      }
      if (votes.on_site > votes.open_meteo && votes.on_site >= votes.similar) {
        recommendation = {
          irradiance: 'onsite',
          reason: 'Data quality: the on-site sensor tracks zone production best.',
        };
      } else if (votes.open_meteo > votes.on_site && votes.open_meteo >= votes.similar) {
        recommendation = {
          irradiance: 'open_meteo',
          reason: 'Data quality: the satellite reference tracks zone production better than the on-site sensor.',
        };
      } else {
        recommendation = {
          irradiance: null,
          reason: 'Data quality: on-site and satellite track production similarly — either works.',
        };
      }
    }
  } catch {
    // keep the default recommendation
  }

  const selected = settingsFromMetadata(plant.metadata).dataSources;

  return NextResponse.json({
    plant_id: plant.slug ?? plant.id,
    irradiance,
    soilingReference,
    recommendation,
    selected,
    scope:
      'Applies to soiling analytics runs. The digital twin runs on modeled weather by design.',
  });
}
