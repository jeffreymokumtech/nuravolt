import { NextRequest, NextResponse } from 'next/server';
import path from 'node:path';
import fs from 'node:fs';

/**
 * GET /api/soiling/universal?lat=37.96&lon=-1.21&plant_id=optional&days=30
 *
 * Day-1 universal soiling forecast for any coordinates: a climate-prior
 * baseline (literature-derived monthly soiling rates per climate zone). Runs
 * in-process in the Node runtime; it previously spawned a Python interpreter,
 * which cannot exist on Vercel (the route 500'd on prod). The US-only NREL
 * Soiling Map overlay is not part of this port, so the nrel_* fields are null.
 *
 * Zone bounds are ported verbatim from
 * nuravolt/soiling/climate_regions.py::_zone_from_latlon (order matters:
 * first match wins). Priors come from public/data/soiling/_climate_priors.json.
 */

// Public route: serves aggregate/public-data-derived content only (showcase).

function zoneFromLatLon(lat: number, lon: number): string {
  // (0,0) is the "missing coordinates" sentinel; force UNKNOWN.
  if (lat === 0 && lon === 0) return 'UNKNOWN';

  // More-specific bounds first.
  if (lat >= 8 && lat <= 35 && lon >= 65 && lon <= 95) return 'SUBTROPICAL_INDIA';
  if (lat >= 15 && lat <= 38 && lon >= 35 && lon <= 65) return 'DESERT_MENA';
  if (lat >= 10 && lat <= 20 && lon >= -20 && lon <= 40) return 'TROPICAL_MONSOON_SAHEL';
  if (lat >= 20 && lat <= 30 && lon >= -20 && lon <= 35) return 'DESERT_NORTH_AFRICA';
  if (lat >= -5 && lat <= 5 && lon >= 33 && lon <= 42) return 'EQUATORIAL_EAST_AFRICA';

  // Sub-Saharan tropical savanna (both hemispheres).
  if (lat >= -20 && lat < 10 && lon >= -20 && lon <= 45) return 'TROPICAL_SAVANNA';
  if (lat >= -20 && lat <= -5 && lon >= -60 && lon <= -40) return 'TROPICAL_SAVANNA';
  if (lat >= -20 && lat <= -10 && lon >= 130 && lon <= 150) return 'TROPICAL_SAVANNA';

  // Southern Africa (specific before generic).
  if (lat >= -32 && lat <= -27 && lon >= 30 && lon <= 33) return 'HUMID_SUBTROPICAL';
  if (lat >= -35 && lat <= -32 && lon >= 17 && lon < 18.5) return 'MEDITERRANEAN';
  if (lat >= -33 && lat <= -22 && lon >= 18 && lon <= 32) return 'SEMIARID_COLD_STEPPE';

  // Semi-arid cold steppe (Anatolia/Iran, US Plains, Pampas).
  if (lat >= 35 && lat <= 41 && lon >= 30 && lon <= 62) return 'SEMIARID_COLD_STEPPE';
  if (lat >= 35 && lat <= 49 && lon >= -106 && lon <= -98) return 'SEMIARID_COLD_STEPPE';
  if (lat >= -40 && lat <= -32 && lon >= -68 && lon <= -60) return 'SEMIARID_COLD_STEPPE';

  // Humid subtropical (Cfa).
  if (lat >= 25 && lat <= 37 && lon >= -100 && lon <= -75) return 'HUMID_SUBTROPICAL';
  if (lat >= -35 && lat <= -20 && lon >= -65 && lon <= -45) return 'HUMID_SUBTROPICAL';
  if (lat >= -38 && lat <= -25 && lon >= 145 && lon <= 154) return 'HUMID_SUBTROPICAL';
  if (lat >= 22 && lat <= 38 && lon >= 105 && lon <= 140) return 'HUMID_SUBTROPICAL';

  // Broader fallbacks last.
  if (lat >= 30 && lat <= 40 && lon >= -125 && lon <= -100) return 'DESERT_SOUTHWEST_US';
  if (lat >= 30 && lat <= 46 && lon >= -10 && lon <= 40) return 'MEDITERRANEAN';
  if (lat >= 46 && lat <= 65 && lon >= -10 && lon <= 40) return 'TEMPERATE_CONTINENTAL';

  return 'UNKNOWN';
}

interface ZonePrior {
  annual_mean_pct_per_day?: number;
  monthly_multipliers?: number[];
  _method?: string;
}

let cachedPriors: Record<string, ZonePrior> | null = null;
function loadPriors(): Record<string, ZonePrior> {
  if (cachedPriors) return cachedPriors;
  const p = path.join(process.cwd(), 'public', 'data', 'soiling', '_climate_priors.json');
  const payload = JSON.parse(fs.readFileSync(p, 'utf-8'));
  cachedPriors = (payload.zones ?? payload) as Record<string, ZonePrior>;
  return cachedPriors;
}

function round4(n: number): number {
  return Math.round(n * 1e4) / 1e4;
}

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const lat = parseFloat(url.searchParams.get('lat') ?? '');
  const lon = parseFloat(url.searchParams.get('lon') ?? '');
  const plantId = url.searchParams.get('plant_id') ?? null;
  const days = parseInt(url.searchParams.get('days') ?? '365', 10);

  if (isNaN(lat) || isNaN(lon) || lat < -90 || lat > 90 || lon < -180 || lon > 180) {
    return NextResponse.json(
      { error: 'invalid_coordinates', hint: 'Pass lat=<float -90..90> and lon=<float -180..180>' },
      { status: 400 },
    );
  }
  if (isNaN(days) || days < 1 || days > 730) {
    return NextResponse.json({ error: 'invalid_days', hint: 'days must be 1..730' }, { status: 400 });
  }

  let priors: Record<string, ZonePrior>;
  try {
    priors = loadPriors();
  } catch {
    return NextResponse.json({ error: 'priors_unavailable' }, { status: 500 });
  }

  const zone = zoneFromLatLon(lat, lon);
  const zp = priors[zone] ?? priors.UNKNOWN ?? {};
  const annualMean = typeof zp.annual_mean_pct_per_day === 'number' ? zp.annual_mean_pct_per_day : 0;
  const mult =
    Array.isArray(zp.monthly_multipliers) && zp.monthly_multipliers.length === 12
      ? zp.monthly_multipliers
      : new Array(12).fill(1);

  const previewDays = Math.min(days, 30);
  const start = new Date();
  const days_preview = [];
  for (let i = 0; i < previewDays; i++) {
    const d = new Date(start);
    d.setUTCDate(d.getUTCDate() + i);
    const rate = mult[d.getUTCMonth()] * annualMean;
    days_preview.push({
      date: d.toISOString().slice(0, 10),
      expected_rate_pct_per_day: round4(rate),
      climate_prior_rate: round4(rate),
      nrel_overlay_rate: null,
      zone,
    });
  }

  const monthlyRates = mult.map((m: number) => m * annualMean);
  const mean = monthlyRates.reduce((a: number, b: number) => a + b, 0) / 12;

  return NextResponse.json({
    summary: {
      plant_id: plantId,
      lat,
      lon,
      zone,
      horizon_days: days,
      mean_daily_rate_pct: round4(mean),
      min_daily_rate_pct: round4(Math.min(...monthlyRates)),
      max_daily_rate_pct: round4(Math.max(...monthlyRates)),
      nrel_overlay_active: false,
      nrel_site_id: null,
      nrel_site_distance_km: null,
      prior_provenance:
        typeof zp._method === 'string'
          ? zp._method
          : `Climate-prior baseline for ${zone.replace(/_/g, ' ')} (literature-derived monthly soiling rates)`,
    },
    days_preview,
    nrel_site: null,
  });
}
