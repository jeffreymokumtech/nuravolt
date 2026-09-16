import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/libs/prisma';
import { resolvePlantForRead } from '@/lib/api/tenant';

/**
 * GET /api/plants/[plantId]/data-lineage
 *
 * "Where does each stream actually come from?" — a per-plant provenance view.
 * Joins the configured feeds (PlantDataSource + FieldMapping device→metric +
 * LatestDeviceSnapshot freshness) with the modeled/synthesized analytics streams
 * (irradiance = Open-Meteo satellite unless an on-site sensor exists; soiling
 * forecast = climate-transfer; dust/AOD/DustIQ/ML + fault telemetry = synthesized,
 * per AnalysisArtifact.source). Each stream is tagged with a source_class so the
 * UI can badge real vs modeled/provisional.
 */

type SourceClass = 'ingested' | 'sensor' | 'satellite' | 'climate_transfer' | 'synthesized';

interface FieldMap {
  from: string;
  to: string;
  unit: string | null;
  confidence: number | null;
}

interface Stream {
  key: string;
  label: string;
  metrics: string[];
  source_class: SourceClass;
  source_label: string;
  connection: { name: string; type: string; status: string } | null;
  field_mappings: FieldMap[];
  last_updated: string | null;
  provisional: boolean;
  note?: string;
}

const CLASS_FOR_SOURCE_TYPE: Record<string, SourceClass> = {
  SCADA: 'ingested',
  MANUAL_CSV: 'ingested',
  GRID_METER: 'ingested',
  WEATHER_STATION: 'sensor',
  DUSTIQ: 'sensor',
  SATELLITE_IRR: 'satellite',
  API_WEATHER: 'satellite',
};

const LABEL_FOR_SOURCE_TYPE: Record<string, string> = {
  SCADA: 'SCADA feed',
  MANUAL_CSV: 'CSV upload',
  GRID_METER: 'Grid meter',
  WEATHER_STATION: 'On-site weather station',
  DUSTIQ: 'DustIQ reference sensor',
  SATELLITE_IRR: 'Satellite irradiance (open data)',
  API_WEATHER: 'Open-Meteo reanalysis (open data)',
};

export async function GET(
  _request: NextRequest,
  { params }: { params: { plantId: string } },
) {
  const readAccess = await resolvePlantForRead(params.plantId);
  if (!readAccess.ok) return readAccess.response;
  const plant = readAccess.plant;
  if (!plant) return NextResponse.json({ error: 'plant_not_found' }, { status: 404 });

  const streams: Stream[] = [];

  // --- 1. Configured feeds (PlantDataSource + connection + mappings + freshness) ---
  const sources = await prisma.plantDataSource.findMany({
    where: { plant_id: plant.id },
    orderBy: [{ is_primary: 'desc' }, { name: 'asc' }],
    include: { connection: { select: { id: true, name: true, type: true, status: true } } },
  });

  for (const s of sources) {
    let fieldMappings: FieldMap[] = [];
    let lastUpdated: string | null = null;
    if (s.connection_id) {
      const [maps, snap] = await Promise.all([
        prisma.fieldMapping.findMany({
          where: { connection_id: s.connection_id },
          select: { original_field: true, mapped_field: true, unit: true, confidence_score: true },
          take: 20,
        }),
        prisma.latestDeviceSnapshot.findFirst({
          where: { connection_id: s.connection_id },
          orderBy: { ts: 'desc' },
          select: { ts: true },
        }),
      ]);
      fieldMappings = maps.map((m) => ({
        from: m.original_field,
        to: String(m.mapped_field),
        unit: m.unit,
        confidence: m.confidence_score != null ? Number(m.confidence_score) : null,
      }));
      lastUpdated = snap?.ts ? snap.ts.toISOString() : null;
    }
    // Sandbox sample feed: honest "synthesized / provisional" badge regardless
    // of the underlying source_type, so it never reads as real inverter data.
    const isSample = String(s.connection?.type) === 'sample_api';
    const cls: SourceClass = isSample
      ? 'synthesized'
      : CLASS_FOR_SOURCE_TYPE[String(s.source_type)] ?? 'ingested';
    streams.push({
      key: `src-${s.id}`,
      label: s.name,
      metrics: s.provides_metrics ?? [],
      source_class: cls,
      source_label: isSample
        ? 'Sample inverter feed (sandbox)'
        : s.connection
          ? `${String(s.connection.type)} · ${s.connection.name}`
          : LABEL_FOR_SOURCE_TYPE[String(s.source_type)] ?? String(s.source_type),
      connection: s.connection
        ? { name: s.connection.name, type: String(s.connection.type), status: String(s.connection.status) }
        : null,
      field_mappings: fieldMappings,
      last_updated: lastUpdated,
      provisional: isSample || cls === 'satellite',
      note: isSample
        ? 'Synthetic data for exploration — connect a real inverter to replace it.'
        : undefined,
    });
  }

  // --- 2. Modeled / synthesized analytics streams ---
  // Irradiance & weather driving the digital twin.
  const hasOwnWeather = Boolean((plant as any).has_weather_station);
  if (!streams.some((s) => s.source_class === 'satellite' || s.metrics.includes('irradiance_poa'))) {
    streams.push({
      key: 'weather',
      label: 'Irradiance & weather (twin driver)',
      metrics: ['irradiance_poa', 'irradiance_ghi', 'temp_ambient', 'wind_speed'],
      source_class: hasOwnWeather ? 'sensor' : 'satellite',
      source_label: hasOwnWeather
        ? `On-site sensor (${(plant as any).irradiance_sensor_type ?? 'pyranometer'})`
        : 'Open-Meteo (ERA5 + satellite reanalysis)',
      connection: null,
      field_mappings: [],
      last_updated: null,
      provisional: !hasOwnWeather,
      note: hasOwnWeather
        ? 'Measured on site.'
        : 'Modeled from open-source reanalysis until an on-site pyranometer is connected.',
    });
  }

  // Soiling forecast = climate-transfer (coldstart) unless plant-trained.
  const coldstart = await prisma.$queryRaw<Array<{ n: bigint }>>`
    SELECT COUNT(*)::bigint AS n FROM analysis_results
    WHERE plant_id::text = ${plant.id} AND domain = 'soiling' AND metric = 'soiling_ratio'
      AND time > NOW() LIMIT 1`;
  if (Number(coldstart[0]?.n ?? 0) > 0) {
    streams.push({
      key: 'soiling-forecast',
      label: 'Soiling forecast',
      metrics: ['soiling_ratio'],
      source_class: 'climate_transfer',
      source_label: 'Climate-analog transfer model',
      connection: null,
      field_mappings: [],
      last_updated: null,
      provisional: true,
      note: 'Transferred from the nearest/most-similar climate zone until the plant-trained model has enough history.',
    });
  }

  // Synthesized artifacts (dust/AOD/DustIQ/ML streams + fault telemetry).
  const artifacts = await prisma.analysisArtifact.findMany({
    where: { plant_id: plant.id },
    select: { kind: true, source: true, model_version: true, generated_at: true },
  });
  for (const a of artifacts) {
    if (a.kind === 'soiling_streams') {
      streams.push({
        key: 'soiling-streams',
        label: 'Dust, aerosol (AOD), DustIQ reference & ML soiling',
        metrics: ['pm10', 'pm2_5', 'aod_550nm', 'sr_dustiq', 'sr_ml'],
        source_class: a.source === 'ingested' ? 'ingested' : 'synthesized',
        source_label: a.source === 'ingested' ? 'Reference sensors / aerosol feed' : 'Synthesized (provisional)',
        connection: null,
        field_mappings: [],
        last_updated: a.generated_at.toISOString(),
        provisional: a.source !== 'ingested',
        note: 'Connect a DustIQ reference sensor or aerosol (CAMS) feed to replace the modeled series.',
      });
    } else if (a.kind === 'faults_enhanced') {
      streams.push({
        key: 'faults',
        label: 'Predictive fault telemetry (RUL / cascade / health)',
        metrics: ['rul_days', 'health_score'],
        source_class: a.source === 'ingested' ? 'ingested' : 'synthesized',
        source_label: a.source === 'ingested' ? 'Trained fault model' : 'Synthesized (provisional)',
        connection: null,
        field_mappings: [],
        last_updated: a.generated_at.toISOString(),
        provisional: a.source !== 'ingested',
        note: 'Derived from the twin residuals + soiling; a plant-trained fault model replaces it as history accrues.',
      });
    }
  }

  return NextResponse.json({
    plant: {
      slug: plant.slug,
      has_weather_station: (plant as any).has_weather_station ?? false,
      irradiance_sensor_type: (plant as any).irradiance_sensor_type ?? null,
      has_dustiq_sensor: (plant as any).has_dustiq_sensor ?? false,
    },
    streams,
  });
}
