'use client';

import { TrendingDown, TrendingUp, Zap } from 'lucide-react';
import type { DispatchScheduleResponse } from '@/types/bess';

/**
 * Degradation-aware dispatch P&L. The optimizer's core insight — trades are
 * only worth taking when revenue beats the battery wear they cause — was
 * computed (expected/degradation/net on every schedule) but only the gross
 * spread ever reached the UI. This card puts the wear cost in the middle of
 * the story: gross revenue − battery wear = net, plus wear as a share of
 * gross so "profitable but hardware-hungry" days stand out.
 */
export default function DispatchPnlCard({
  summary,
}: {
  summary: DispatchScheduleResponse['summary'];
}) {
  const { expectedRevenueEur, degradationCostEur, netRevenueEur, expectedCycles } = summary;
  const wearShare =
    expectedRevenueEur > 0 ? Math.min(100, (degradationCostEur / expectedRevenueEur) * 100) : 0;
  const perCycle = expectedCycles > 0 ? degradationCostEur / expectedCycles : 0;
  const wearTone =
    wearShare >= 50 ? 'text-red-600' : wearShare >= 25 ? 'text-amber-600' : 'text-emerald-600';

  return (
    <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-6">
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-lg font-semibold text-gray-900">Dispatch P&amp;L (degradation-aware)</h3>
        <span className="text-xs text-gray-500">today&apos;s schedule</span>
      </div>

      <div className="grid grid-cols-3 gap-4">
        <div>
          <p className="flex items-center gap-1 text-xs text-gray-500">
            <TrendingUp className="h-3.5 w-3.5 text-emerald-600" /> Gross revenue
          </p>
          <p className="mt-1 text-2xl font-bold text-gray-900">
            €{expectedRevenueEur.toLocaleString(undefined, { maximumFractionDigits: 0 })}
          </p>
        </div>
        <div>
          <p className="flex items-center gap-1 text-xs text-gray-500">
            <TrendingDown className="h-3.5 w-3.5 text-amber-600" /> Battery wear
          </p>
          <p className="mt-1 text-2xl font-bold text-amber-600">
            −€{degradationCostEur.toLocaleString(undefined, { maximumFractionDigits: 0 })}
          </p>
          <p className="text-xs text-gray-500">
            {expectedCycles.toFixed(2)} cycles · €{perCycle.toFixed(0)}/cycle
          </p>
        </div>
        <div>
          <p className="flex items-center gap-1 text-xs text-gray-500">
            <Zap className="h-3.5 w-3.5 text-blue-600" /> Net revenue
          </p>
          <p className={`mt-1 text-2xl font-bold ${netRevenueEur >= 0 ? 'text-gray-900' : 'text-red-600'}`}>
            €{netRevenueEur.toLocaleString(undefined, { maximumFractionDigits: 0 })}
          </p>
        </div>
      </div>

      <div className="mt-4">
        <div className="flex justify-between text-xs text-gray-500">
          <span>Wear share of gross</span>
          <span className={`font-semibold ${wearTone}`}>{wearShare.toFixed(0)}%</span>
        </div>
        <div className="mt-1 h-2 rounded-full bg-gray-100 overflow-hidden">
          <div
            className={`h-full rounded-full ${
              wearShare >= 50 ? 'bg-red-500' : wearShare >= 25 ? 'bg-amber-500' : 'bg-emerald-500'
            }`}
            style={{ width: `${wearShare}%` }}
          />
        </div>
        <p className="mt-2 text-xs text-gray-400">
          A trade is only worth taking when the spread beats the wear it causes —
          days where the bar runs red are burning asset life for thin margin.
        </p>
      </div>
    </div>
  );
}
