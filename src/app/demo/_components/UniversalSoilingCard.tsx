'use client';

/**
 * Universal Soiling Forecast card, Phase K Pillar 3 demo.
 *
 * Lets you type any latitude / longitude and instantly get a day-1
 * soiling forecast: climate-prior baseline (literature-derived per
 * climate zone) + NREL Soiling Map overlay (US plants), zero
 * client data required.
 *
 * Powered by GET /api/soiling/universal?lat=&lon=
 */

import { useState } from 'react';

type SoilingDay = {
  date: string;
  expected_rate_pct_per_day: number;
  climate_prior_rate: number;
  nrel_overlay_rate: number | null;
  zone: string;
};

type ForecastResponse = {
  summary: {
    plant_id: string | null;
    lat: number;
    lon: number;
    zone: string;
    horizon_days: number;
    mean_daily_rate_pct: number;
    min_daily_rate_pct: number;
    max_daily_rate_pct: number;
    nrel_overlay_active: boolean;
    nrel_site_id: string | null;
    nrel_site_distance_km: number | null;
    prior_provenance: string;
  };
  days_preview: SoilingDay[];
  nrel_site: {
    site_id: string;
    lat: number;
    lon: number;
    distance_km: number;
  } | null;
};

const PRESETS = [
  { name: 'Spain (Mediterranean)', lat: 37.96, lon: -1.21 },
  { name: 'UAE (Desert MENA)', lat: 24.45, lon: 54.39 },
  { name: 'Phoenix (SW US)', lat: 33.37, lon: -112.58 },
  { name: 'Germany (Continental)', lat: 51.30, lon: 13.20 },
  { name: 'Delhi (India)', lat: 28.60, lon: 77.20 },
];

export function UniversalSoilingCard() {
  const [lat, setLat] = useState<string>('37.96');
  const [lon, setLon] = useState<string>('-1.21');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<ForecastResponse | null>(null);

  const fetchForecast = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/soiling/universal?lat=${lat}&lon=${lon}&days=30`);
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || `HTTP ${res.status}`);
      }
      const json: ForecastResponse = await res.json();
      setData(json);
    } catch (e: any) {
      setError(e?.message ?? 'unknown error');
      setData(null);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-950 p-6 text-zinc-100">
      <div className="mb-4">
        <h3 className="text-lg font-semibold">Universal soiling forecast</h3>
        <p className="text-sm text-zinc-400">
          Drop in any lat/lon and get a day-1 soiling rate forecast, climate-prior baseline
          (Mediterranean / MENA / Sahel / etc.) + NREL Soiling Map overlay (US plants). No
          client data required.
        </p>
      </div>

      <div className="mb-3 flex flex-wrap gap-2">
        {PRESETS.map((p) => (
          <button
            key={p.name}
            onClick={() => {
              setLat(p.lat.toString());
              setLon(p.lon.toString());
            }}
            className="rounded border border-zinc-700 bg-zinc-900 px-2 py-1 text-xs hover:bg-zinc-800"
          >
            {p.name}
          </button>
        ))}
      </div>

      <div className="mb-4 flex gap-2">
        <input
          type="text"
          value={lat}
          onChange={(e) => setLat(e.target.value)}
          placeholder="Latitude"
          className="w-32 rounded border border-zinc-700 bg-zinc-900 px-2 py-1 text-sm"
        />
        <input
          type="text"
          value={lon}
          onChange={(e) => setLon(e.target.value)}
          placeholder="Longitude"
          className="w-32 rounded border border-zinc-700 bg-zinc-900 px-2 py-1 text-sm"
        />
        <button
          onClick={fetchForecast}
          disabled={loading}
          className="rounded bg-emerald-600 px-3 py-1 text-sm font-medium text-white hover:bg-emerald-500 disabled:opacity-50"
        >
          {loading ? 'Forecasting…' : 'Get forecast'}
        </button>
      </div>

      {error && (
        <div className="mb-3 rounded border border-red-700 bg-red-950 p-2 text-sm text-red-200">
          {error}
        </div>
      )}

      {data && (
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Metric label="Climate zone" value={data.summary.zone.replace(/_/g, ' ')} />
            <Metric
              label="Mean rate"
              value={`${data.summary.mean_daily_rate_pct.toFixed(3)} %/day`}
            />
            <Metric
              label="Peak month rate"
              value={`${data.summary.max_daily_rate_pct.toFixed(3)} %/day`}
            />
            <Metric
              label="NREL overlay"
              value={
                data.summary.nrel_overlay_active
                  ? `${data.summary.nrel_site_id} @ ${data.summary.nrel_site_distance_km}km`
                  : 'not in NREL Map footprint'
              }
            />
          </div>

          <div className="rounded border border-zinc-800 bg-zinc-900 p-3 text-xs">
            <div className="mb-1 font-medium text-zinc-300">Provenance</div>
            <div className="text-zinc-400">{data.summary.prior_provenance}</div>
          </div>

          <details className="rounded border border-zinc-800 bg-zinc-900 p-3 text-xs">
            <summary className="cursor-pointer text-zinc-300">
              30-day preview ({data.days_preview.length} days)
            </summary>
            <div className="mt-2 max-h-48 overflow-y-auto font-mono">
              {data.days_preview.map((d) => (
                <div key={d.date} className="flex justify-between text-zinc-400">
                  <span>{d.date}</span>
                  <span>
                    {d.expected_rate_pct_per_day.toFixed(3)} %/day
                    {d.nrel_overlay_rate !== null && (
                      <span className="ml-2 text-emerald-400">
                        (NREL: {d.nrel_overlay_rate.toFixed(3)})
                      </span>
                    )}
                  </span>
                </div>
              ))}
            </div>
          </details>
        </div>
      )}
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded border border-zinc-800 bg-zinc-900 p-2">
      <div className="text-xs uppercase tracking-wide text-zinc-500">{label}</div>
      <div className="mt-1 text-sm font-medium text-zinc-100">{value}</div>
    </div>
  );
}
