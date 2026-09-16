'use client';

import Link from 'next/link';
import { MapPin, ChevronRight } from 'lucide-react';
import { formatCurrency } from '@/utils/riskScoring';
import type { FinancialPlantData } from '@/types/portfolio';

const ASSET_ACCENT: Record<string, { bar: string; chip: string }> = {
  SOLAR: { bar: 'border-t-asset-solar', chip: 'bg-blue-50 text-blue-700' },
  WIND: { bar: 'border-t-asset-wind', chip: 'bg-cyan-50 text-cyan-700' },
  BESS: { bar: 'border-t-asset-bess', chip: 'bg-violet-50 text-violet-700' },
  HYDROGEN: { bar: 'border-t-emerald-500', chip: 'bg-emerald-50 text-emerald-700' },
};

const RISK_TONE: Record<string, string> = {
  low: 'bg-signal-positive/10 text-signal-positive border-signal-positive/20',
  medium: 'bg-signal-warning/10 text-signal-warning border-signal-warning/20',
  high: 'bg-signal-critical/10 text-signal-critical border-signal-critical/20',
  critical: 'bg-rose-100 text-rose-800 border-rose-300',
};

export default function FleetCard({
  plant,
  name,
  location,
}: {
  plant: FinancialPlantData;
  /** Display name/location after anonymization. */
  name: string;
  location: string;
}) {
  const accent = ASSET_ACCENT[plant.assetType ?? 'SOLAR'] ?? ASSET_ACCENT.SOLAR;
  const health = plant.metrics.healthScore ?? null;
  const dev = plant.financials.budget_deviation_pct;
  const risk = plant.riskScore;

  return (
    <Link
      href={`/demo/plant/${plant.plantId}`}
      className={`group block rounded-xl border border-divider border-t-2 ${accent.bar} bg-white p-4 shadow-sm transition-all hover:-translate-y-0.5 hover:border-blue-300 hover:shadow-md`}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="truncate font-semibold text-ink group-hover:text-blue-600">
            {name}
          </div>
          <div className="mt-0.5 flex items-center gap-1 text-xs text-ink-3">
            <MapPin className="h-3 w-3 shrink-0" />
            <span className="truncate">{location}</span>
          </div>
        </div>
        <span
          className={`shrink-0 rounded-full border px-2 py-0.5 text-[11px] font-semibold ${RISK_TONE[risk.level] ?? RISK_TONE.medium}`}
          title={`Risk score ${risk.overall}/100`}
        >
          {risk.overall}
        </span>
      </div>

      <div className="mt-3 grid grid-cols-3 gap-2 text-center">
        <div>
          <div className="text-sm font-bold text-ink">{plant.capacity_MW} MW</div>
          <div className="text-[10px] uppercase tracking-wide text-ink-3">Capacity</div>
        </div>
        <div>
          <div
            className={`text-sm font-bold ${
              dev >= -3 ? 'text-signal-positive' : dev >= -8 ? 'text-signal-warning' : 'text-signal-critical'
            }`}
          >
            {dev > 0 ? '+' : ''}
            {dev.toFixed(1)}%
          </div>
          <div className="text-[10px] uppercase tracking-wide text-ink-3">vs budget</div>
        </div>
        <div>
          <div className="text-sm font-bold text-signal-critical">
            {formatCurrency(plant.financials.revenue_at_risk_eur)}
          </div>
          <div className="text-[10px] uppercase tracking-wide text-ink-3">At risk</div>
        </div>
      </div>

      {health != null && (
        <div className="mt-3">
          <div className="flex items-center justify-between text-[11px] text-ink-3">
            <span>Health</span>
            <span
              className={`font-semibold ${
                health >= 90 ? 'text-signal-positive' : health >= 80 ? 'text-signal-warning' : 'text-signal-critical'
              }`}
            >
              {health}%
            </span>
          </div>
          <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-paper-2">
            <div
              className={`h-full rounded-full ${
                health >= 90 ? 'bg-emerald-500' : health >= 80 ? 'bg-amber-500' : 'bg-rose-500'
              }`}
              style={{ width: `${health}%` }}
            />
          </div>
        </div>
      )}

      <div className="mt-3 flex items-center justify-end text-xs font-medium text-blue-600 opacity-0 transition-opacity group-hover:opacity-100">
        Open plant <ChevronRight className="h-3.5 w-3.5" />
      </div>
    </Link>
  );
}
