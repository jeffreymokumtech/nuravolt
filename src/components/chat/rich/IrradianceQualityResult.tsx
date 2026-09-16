'use client';

import { RichToolCard, StatCell } from './RichToolCard';

/**
 * Inline sensor-vs-model irradiance quality card for
 * `tool-getIrradianceQuality` outputs. Stat row + severity-toned alerts +
 * a monthly bias mini-chart (plain divs around a zero baseline).
 */

interface IrradianceQualityOutput {
  plant?: { slug?: string; name?: string };
  period?: { start?: string; end?: string } | null;
  sensor?: string | null;
  reference?: string | null;
  overall?: {
    correlation?: number | null;
    r_squared?: number | null;
    bias_pct?: number | null;
    bias_w_m2?: number | null;
    rmse_w_m2?: number | null;
    sample_count?: number;
  };
  alerts?: Array<{
    type: string;
    severity: string;
    message: string;
    recommendation?: string | null;
  }>;
  monthly?: {
    months: string[];
    bias_pct: Array<number | null>;
  } | null;
}

const severityTone: Record<string, string> = {
  high: 'bg-red-50 text-red-700 ring-red-200',
  medium: 'bg-amber-50 text-amber-700 ring-amber-200',
  low: 'bg-gray-50 text-gray-600 ring-gray-200',
};

export function IrradianceQualityResult({ output }: { output: IrradianceQualityOutput }) {
  const overall = output.overall ?? {};
  const alerts = Array.isArray(output.alerts) ? output.alerts : [];
  const worst = alerts.some((a) => a.severity === 'high')
    ? 'alarm'
    : alerts.some((a) => a.severity === 'medium')
      ? 'warn'
      : 'ok';

  const months = output.monthly?.months ?? [];
  const bias = output.monthly?.bias_pct ?? [];
  const maxAbsBias = Math.max(1, ...bias.map((b) => (b == null ? 0 : Math.abs(b))));

  return (
    <RichToolCard
      title={`Irradiance data quality · ${output.plant?.name ?? output.plant?.slug ?? 'plant'}`}
      badge={alerts.length ? `${alerts.length} quality alert${alerts.length > 1 ? 's' : ''}` : 'No alerts'}
      badgeTone={worst}
      raw={output}
    >
      <div className="mb-2 text-[10px] text-gray-500">
        {output.sensor ?? 'On-site sensor'} vs {output.reference ?? 'reference model'}
        {output.period?.start ? ` · ${output.period.start} to ${output.period.end}` : ''}
      </div>

      <div className="mb-2 grid grid-cols-3 gap-2">
        <StatCell
          label="Correlation"
          value={overall.correlation != null ? overall.correlation.toFixed(2) : 'n/a'}
        />
        <StatCell
          label="Bias"
          value={
            overall.bias_pct != null
              ? `${overall.bias_pct > 0 ? '+' : ''}${overall.bias_pct.toFixed(1)}%`
              : 'n/a'
          }
        />
        <StatCell
          label="RMSE"
          value={overall.rmse_w_m2 != null ? `${Math.round(overall.rmse_w_m2)} W/m2` : 'n/a'}
        />
      </div>

      {months.length > 1 && (
        <div className="mb-2">
          <div className="mb-1 text-[10px] text-gray-500">Monthly bias vs model (%)</div>
          <div className="flex h-14 items-stretch gap-[2px]">
            {months.map((m, i) => {
              const b = bias[i];
              const h = b == null ? 0 : (Math.abs(b) / maxAbsBias) * 50;
              const up = (b ?? 0) >= 0;
              return (
                <div
                  key={m || i}
                  className="group relative flex flex-1 flex-col"
                  title={b != null ? `${m}: ${b > 0 ? '+' : ''}${b.toFixed(1)}%` : m}
                >
                  <div className="flex flex-1 items-end justify-center">
                    {up && b != null && (
                      <div
                        className={`w-full rounded-sm ${Math.abs(b) > 15 ? 'bg-amber-400' : 'bg-sky-300'}`}
                        style={{ height: `${Math.max(2, h)}%` }}
                      />
                    )}
                  </div>
                  <div className="h-px bg-gray-200" />
                  <div className="flex flex-1 items-start justify-center">
                    {!up && b != null && (
                      <div
                        className={`w-full rounded-sm ${Math.abs(b) > 15 ? 'bg-amber-400' : 'bg-sky-300'}`}
                        style={{ height: `${Math.max(2, h)}%` }}
                      />
                    )}
                  </div>
                </div>
              );
            })}
          </div>
          <div className="mt-0.5 flex justify-between text-[9px] text-gray-400">
            <span>{months[0]}</span>
            <span>{months[months.length - 1]}</span>
          </div>
        </div>
      )}

      {alerts.length > 0 && (
        <ul className="space-y-1">
          {alerts.map((a, i) => (
            <li key={i} className="flex items-start gap-1.5">
              <span
                className={`mt-px shrink-0 rounded-full px-1.5 py-0.5 text-[9px] font-medium ring-1 ${severityTone[a.severity] ?? severityTone.low}`}
              >
                {a.severity}
              </span>
              <span className="text-[11px] leading-snug text-gray-700">
                {a.message}
                {a.recommendation ? (
                  <span className="text-gray-400"> {a.recommendation}.</span>
                ) : null}
              </span>
            </li>
          ))}
        </ul>
      )}
    </RichToolCard>
  );
}
