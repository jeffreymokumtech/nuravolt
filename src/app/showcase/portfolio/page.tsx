'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import {
  ArrowRight,
  ArrowUpRight,
  Battery,
  Euro,
  Gauge,
  Sun,
  TrendingUp,
  Wind,
} from 'lucide-react';

interface ShowcasePortfolioPlant {
  plantId: string;
  plantName: string;
  location: string;
  asset_type: 'SOLAR' | 'WIND' | 'BESS';
  capacity_MW: number;
  metrics: {
    healthScore: number;
    availability_pct: number;
    performance_ratio: number;
  };
  financials: {
    annual_revenue_eur: number;
    revenue_at_risk_eur: number;
    budget_deviation_pct: number;
    soiling_loss_eur: number;
    fault_loss_eur: number;
    availability_pct: number;
    performance_ratio: number;
  };
  riskScore: {
    overall: number;
    level: string;
  };
}

interface ShowcasePortfolio {
  as_of: string;
  total_capacity_mw: number;
  total_plants: number;
  plants: ShowcasePortfolioPlant[];
}

function fmtEur(value: number): string {
  if (Math.abs(value) >= 1_000_000) {
    return `€${(value / 1_000_000).toFixed(2)}M`;
  }
  if (Math.abs(value) >= 1000) {
    return `€${(value / 1000).toFixed(1)}k`;
  }
  return `€${value.toFixed(0)}`;
}

function riskPill(level: string): { bg: string; text: string } {
  switch (level) {
    case 'low':
      return { bg: 'bg-signal-positive/10', text: 'text-signal-positive' };
    case 'medium':
      return { bg: 'bg-signal-warning/10', text: 'text-signal-warning' };
    case 'high':
      return { bg: 'bg-signal-critical/10', text: 'text-signal-critical' };
    case 'critical':
      return { bg: 'bg-red-200', text: 'text-red-900' };
    default:
      return { bg: 'bg-paper-2', text: 'text-ink-2' };
  }
}

function assetIcon(type: string) {
  switch (type) {
    case 'SOLAR':
      return Sun;
    case 'WIND':
      return Wind;
    case 'BESS':
      return Battery;
    default:
      return Sun;
  }
}

export default function ShowcasePortfolioPage() {
  const [portfolio, setPortfolio] = useState<ShowcasePortfolio | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch('/data/showcase/portfolio.json')
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error('Failed'))))
      .then((json) => setPortfolio(json))
      .catch((err) => setError(err.message));
  }, []);

  if (error) {
    return (
      <div className="mx-auto max-w-[1400px] px-4 sm:px-6 py-10">
        <div className="rounded-xl bg-signal-critical/10 border border-signal-critical/20 p-6 text-signal-critical">
          Could not load portfolio: {error}
        </div>
      </div>
    );
  }

  if (!portfolio) {
    return (
      <div className="mx-auto max-w-[1400px] px-4 sm:px-6 py-10">
        <div className="text-ink-3">Loading portfolio…</div>
      </div>
    );
  }

  const totalRevenue = portfolio.plants.reduce(
    (s, p) => s + p.financials.annual_revenue_eur,
    0,
  );
  const totalAtRisk = portfolio.plants.reduce(
    (s, p) => s + p.financials.revenue_at_risk_eur,
    0,
  );
  const totalLosses = portfolio.plants.reduce(
    (s, p) => s + p.financials.soiling_loss_eur + p.financials.fault_loss_eur,
    0,
  );
  const weightedPR =
    portfolio.plants.reduce(
      (s, p) => s + p.metrics.performance_ratio * p.capacity_MW,
      0,
    ) / portfolio.total_capacity_mw;

  return (
    <div className="mx-auto max-w-[1400px] px-4 sm:px-6 py-8">
      {/* Header */}
      <div className="mb-6">
        <div className="flex items-baseline justify-between">
          <div>
            <h1 className="text-2xl font-bold text-ink">Portfolio Overview</h1>
            <p className="text-sm text-ink-3 mt-1">
              {portfolio.total_plants} plants · {portfolio.total_capacity_mw.toFixed(1)} MW
              installed capacity
            </p>
          </div>
          <span className="text-xs text-ink-3">
            As of {new Date(portfolio.as_of).toLocaleDateString()}
          </span>
        </div>
      </div>

      {/* KPI grid */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-8">
        <div className="rounded-xl bg-white border border-divider p-5">
          <div className="flex items-center justify-between mb-3">
            <span className="text-xs text-ink-3 uppercase tracking-wider font-semibold">
              Annual Revenue
            </span>
            <Euro className="w-4 h-4 text-signal-positive" />
          </div>
          <div className="text-2xl font-bold text-ink">{fmtEur(totalRevenue)}</div>
          <div className="text-xs text-ink-3 mt-1">Across the portfolio</div>
        </div>
        <div className="rounded-xl bg-white border border-divider p-5">
          <div className="flex items-center justify-between mb-3">
            <span className="text-xs text-ink-3 uppercase tracking-wider font-semibold">
              Revenue at Risk
            </span>
            <TrendingUp className="w-4 h-4 text-red-500" />
          </div>
          <div className="text-2xl font-bold text-ink">{fmtEur(totalAtRisk)}</div>
          <div className="text-xs text-ink-3 mt-1">
            {((totalAtRisk / totalRevenue) * 100).toFixed(1)}% of annual
          </div>
        </div>
        <div className="rounded-xl bg-white border border-divider p-5">
          <div className="flex items-center justify-between mb-3">
            <span className="text-xs text-ink-3 uppercase tracking-wider font-semibold">
              Realised Losses
            </span>
            <ArrowUpRight className="w-4 h-4 text-signal-warning" />
          </div>
          <div className="text-2xl font-bold text-ink">{fmtEur(totalLosses)}</div>
          <div className="text-xs text-ink-3 mt-1">Soiling + fault losses</div>
        </div>
        <div className="rounded-xl bg-white border border-divider p-5">
          <div className="flex items-center justify-between mb-3">
            <span className="text-xs text-ink-3 uppercase tracking-wider font-semibold">
              Weighted PR
            </span>
            <Gauge className="w-4 h-4 text-blue-600" />
          </div>
          <div className="text-2xl font-bold text-ink">
            {(weightedPR * 100).toFixed(1)}%
          </div>
          <div className="text-xs text-ink-3 mt-1">Capacity-weighted average</div>
        </div>
      </div>

      {/* Plants table */}
      <div className="rounded-xl bg-white border border-divider overflow-hidden">
        <div className="px-5 py-4 border-b border-divider flex items-center justify-between">
          <div>
            <h2 className="text-base font-bold text-ink">Plants</h2>
            <p className="text-xs text-ink-3 mt-0.5">Click a plant to drill in.</p>
          </div>
          <Link
            href="/showcase/reports"
            className="text-sm text-blue-600 hover:text-blue-800 font-semibold"
          >
            See reports →
          </Link>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-paper text-left">
              <tr className="text-xs text-ink-3 uppercase tracking-wider font-semibold">
                <th className="px-5 py-3">Plant</th>
                <th className="px-5 py-3">Type</th>
                <th className="px-5 py-3">Capacity</th>
                <th className="px-5 py-3">Availability</th>
                <th className="px-5 py-3">PR</th>
                <th className="px-5 py-3">Revenue</th>
                <th className="px-5 py-3">At Risk</th>
                <th className="px-5 py-3">Risk</th>
                <th className="px-5 py-3" />
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {portfolio.plants.map((p) => {
                const Icon = assetIcon(p.asset_type);
                const pill = riskPill(p.riskScore.level);
                return (
                  <tr key={p.plantId} className="hover:bg-gray-50 transition">
                    <td className="px-5 py-4">
                      <Link
                        href={`/showcase/plant/${p.plantId}`}
                        className="flex items-center gap-3 group"
                      >
                        <div className="p-2 rounded-lg bg-blue-50">
                          <Icon className="w-4 h-4 text-blue-600" />
                        </div>
                        <div>
                          <div className="font-semibold text-ink group-hover:text-blue-600">
                            {p.plantName}
                          </div>
                          <div className="text-xs text-ink-3">{p.location}</div>
                        </div>
                      </Link>
                    </td>
                    <td className="px-5 py-4 text-ink-2">{p.asset_type}</td>
                    <td className="px-5 py-4 text-ink-2 font-medium">
                      {p.capacity_MW.toFixed(1)} MW
                    </td>
                    <td className="px-5 py-4 text-ink-2">
                      {p.metrics.availability_pct.toFixed(1)}%
                    </td>
                    <td className="px-5 py-4 text-ink-2">
                      {(p.metrics.performance_ratio * 100).toFixed(1)}%
                    </td>
                    <td className="px-5 py-4 text-ink font-medium">
                      {fmtEur(p.financials.annual_revenue_eur)}
                    </td>
                    <td className="px-5 py-4 text-signal-critical font-medium">
                      {fmtEur(p.financials.revenue_at_risk_eur)}
                    </td>
                    <td className="px-5 py-4">
                      <span
                        className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-semibold ${pill.bg} ${pill.text}`}
                      >
                        <span
                          className={`w-1.5 h-1.5 rounded-full ${
                            p.riskScore.level === 'low'
                              ? 'bg-emerald-500'
                              : p.riskScore.level === 'medium'
                                ? 'bg-amber-500'
                                : 'bg-red-500'
                          }`}
                        />
                        {p.riskScore.level} ({p.riskScore.overall})
                      </span>
                    </td>
                    <td className="px-5 py-4">
                      <Link
                        href={`/showcase/plant/${p.plantId}`}
                        className="text-blue-600 hover:text-blue-800"
                      >
                        <ArrowRight className="w-4 h-4" />
                      </Link>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
