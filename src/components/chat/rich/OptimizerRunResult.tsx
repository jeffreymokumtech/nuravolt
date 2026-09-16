'use client';

import { RichToolCard, StatCell } from './RichToolCard';
import { useCopilotOptional } from '@/components/copilot/CopilotProvider';

/**
 * Inline scenario-ladder card for `tool-runCleaningOptimizer` outputs: the
 * recommended schedule's headline economics plus the best plan per cleaning
 * count. Adoption happens via the separate proposeCleaningSchedule draft card.
 */

interface OptimizerRunOutput {
  plant?: { slug?: string; name?: string };
  rain_aware?: boolean;
  recommended?: {
    dates?: string[];
    n_cleanings?: number;
    energy_recovered_mwh?: number | null;
    net_benefit_eur?: number | null;
    roi_pct?: number | null;
    payback_days?: number | null;
  };
  scenarios?: Array<{
    n_cleanings: number;
    first_date: string | null;
    net_benefit_eur: number;
    roi_pct: number;
  }>;
  warnings?: string[];
}

const eur = (v: number | null | undefined) =>
  v == null ? '–' : `€${Math.round(v).toLocaleString('en-US')}`;

export function OptimizerRunResult({ output }: { output: OptimizerRunOutput }) {
  const copilot = useCopilotOptional();
  const rec = output.recommended ?? {};
  const scenarios = output.scenarios ?? [];
  const bestN = rec.n_cleanings;
  const plantRef = output.plant?.slug ?? output.plant?.name;
  const canAdopt = Boolean(copilot && plantRef && rec.dates && rec.dates.length > 0);

  return (
    <RichToolCard
      title={`Cleaning optimizer · ${output.plant?.name ?? output.plant?.slug ?? ''}`}
      badge={output.rain_aware ? 'Rain-aware' : 'No rain forecast'}
      badgeTone={output.rain_aware ? 'ok' : 'info'}
      raw={output}
    >
      <div className="grid grid-cols-4 gap-3">
        <StatCell label="Cleanings" value={rec.n_cleanings ?? '–'} />
        <StatCell
          label="Energy recovered"
          value={
            rec.energy_recovered_mwh != null
              ? `${Math.round(rec.energy_recovered_mwh)} MWh`
              : '–'
          }
        />
        <StatCell label="Net benefit" value={eur(rec.net_benefit_eur)} />
        <StatCell
          label="ROI"
          value={rec.roi_pct != null ? `${Math.round(rec.roi_pct)}%` : '–'}
        />
      </div>

      {rec.dates && rec.dates.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1">
          {rec.dates.map((d) => (
            <span
              key={d}
              className="rounded-full border border-gray-200 bg-gray-50 px-2 py-0.5 font-mono text-[10px] text-gray-700"
            >
              {d}
            </span>
          ))}
        </div>
      )}

      {scenarios.length > 1 && (
        <table className="mt-3 w-full text-[11px]">
          <thead>
            <tr className="text-left text-[10px] uppercase tracking-wide text-gray-400">
              <th className="pb-1 font-medium">Cleanings</th>
              <th className="pb-1 font-medium">First date</th>
              <th className="pb-1 text-right font-medium">Net benefit</th>
              <th className="pb-1 text-right font-medium">ROI</th>
            </tr>
          </thead>
          <tbody>
            {scenarios.map((s) => (
              <tr
                key={s.n_cleanings}
                className={`border-t border-gray-100 ${
                  s.n_cleanings === bestN ? 'font-semibold text-gray-900' : 'text-gray-600'
                }`}
              >
                <td className="py-1">
                  {s.n_cleanings}
                  {s.n_cleanings === bestN ? ' · best' : ''}
                </td>
                <td className="py-1 font-mono">{s.first_date ?? '–'}</td>
                <td className="py-1 text-right font-mono">{eur(s.net_benefit_eur)}</td>
                <td className="py-1 text-right font-mono">{Math.round(s.roi_pct)}%</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {(output.warnings?.length ?? 0) > 0 && (
        <div className="mt-2 rounded border border-amber-200 bg-amber-50 px-2 py-1 text-[10px] text-amber-800">
          {output.warnings!.join(' ')}
        </div>
      )}

      {canAdopt && (
        <div className="mt-3 flex justify-end">
          <button
            type="button"
            onClick={() =>
              copilot!.seedNextMessage(
                `Adopt the cleaning schedule for ${plantRef} on these dates: ${rec.dates!.join(', ')}.` +
                  (rec.net_benefit_eur != null ? ` Estimated net benefit ${eur(rec.net_benefit_eur)}.` : ''),
              )
            }
            className="rounded bg-purple-600 px-3 py-1 text-[11px] font-medium text-white hover:bg-purple-500"
          >
            Adopt this plan
          </button>
        </div>
      )}
    </RichToolCard>
  );
}
