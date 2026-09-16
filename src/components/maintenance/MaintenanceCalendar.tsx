'use client';

import { useMemo } from 'react';
import type { Classification } from '@/lib/maintenance/types';

interface Props {
  rows: Classification[];
  /** Days to render. Default 90. */
  horizonDays?: number;
  /** Callback when a day cell is clicked, filters the parent table. */
  onDayClick?: (date: string, inverters: Classification[]) => void;
  /** Currently selected date (highlighted). */
  activeDate?: string | null;
}

const CAUSE_DOT: Record<string, string> = {
  SOILING: 'bg-amber-500',
  SHADING: 'bg-amber-400',
  THERMAL: 'bg-orange-500',
  STRING_DEGRADATION: 'bg-orange-400',
  BYPASS_DIODE: 'bg-red-500',
  INVERTER_DERATE: 'bg-rose-500',
  NORMAL: 'bg-emerald-400',
};

/**
 * Compact 90-day calendar of expected maintenance interventions. Each day
 * cell counts how many inverters have an `etaDays` resolving to that day;
 * the most severe recommended action sets the cell tint.
 */
export default function MaintenanceCalendar({
  rows,
  horizonDays = 90,
  onDayClick,
  activeDate,
}: Props) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const grid = useMemo(() => {
    const days: { date: string; key: number; entries: Classification[] }[] = [];
    for (let i = 0; i < horizonDays; i++) {
      const d = new Date(today.getTime() + i * 24 * 60 * 60 * 1000);
      const iso = d.toISOString().split('T')[0];
      days.push({ date: iso, key: i, entries: [] });
    }
    for (const r of rows) {
      if (r.etaDays == null) continue;
      if (r.etaDays < 0 || r.etaDays >= horizonDays) continue;
      days[r.etaDays].entries.push(r);
    }
    return days;
  }, [rows, horizonDays, today]);

  const causeOrder = [
    'BYPASS_DIODE',
    'INVERTER_DERATE',
    'THERMAL',
    'STRING_DEGRADATION',
    'SHADING',
    'SOILING',
  ];

  const cellTint = (entries: Classification[]): string => {
    if (entries.length === 0) return 'bg-white border-gray-100 text-gray-300';
    for (const c of causeOrder) {
      if (entries.some((e) => e.likelyCause === c)) {
        return c === 'BYPASS_DIODE' || c === 'INVERTER_DERATE'
          ? 'bg-red-50 border-red-200 text-red-700 hover:bg-red-100'
          : c === 'THERMAL' || c === 'STRING_DEGRADATION'
          ? 'bg-orange-50 border-orange-200 text-orange-700 hover:bg-orange-100'
          : 'bg-amber-50 border-amber-200 text-amber-700 hover:bg-amber-100';
      }
    }
    return 'bg-emerald-50 border-emerald-200 text-emerald-700 hover:bg-emerald-100';
  };

  return (
    <div className="rounded-xl border border-gray-200 bg-white p-5 shadow-sm">
      <div className="flex items-center justify-between mb-3">
        <div>
          <h3 className="text-base font-semibold text-gray-900">
            Intervention calendar
          </h3>
          <p className="text-xs text-gray-500">
            Next {horizonDays} days · click a day to filter the table below
          </p>
        </div>
        <div className="hidden md:flex flex-wrap items-center gap-2 text-[10px] text-zinc-500">
          {['BYPASS_DIODE', 'THERMAL', 'SOILING', 'INVERTER_DERATE'].map((c) => (
            <span key={c} className="inline-flex items-center gap-1">
              <span className={`inline-block h-2 w-2 rounded-full ${CAUSE_DOT[c]}`} />
              {c.toLowerCase().replace('_', ' ')}
            </span>
          ))}
        </div>
      </div>
      <div className="grid grid-cols-15 gap-1" style={{ gridTemplateColumns: 'repeat(15, minmax(0, 1fr))' }}>
        {grid.map((d) => {
          const tint = cellTint(d.entries);
          const isActive = activeDate === d.date;
          return (
            <button
              key={d.key}
              type="button"
              disabled={d.entries.length === 0}
              onClick={() => onDayClick?.(d.date, d.entries)}
              title={
                d.entries.length === 0
                  ? d.date
                  : `${d.date}, ${d.entries.length} inverter${d.entries.length === 1 ? '' : 's'}: ${d.entries.map((e) => e.inverterId).slice(0, 4).join(', ')}${d.entries.length > 4 ? '…' : ''}`
              }
              className={`relative aspect-square rounded border text-[10px] tabular-nums transition-colors ${tint} ${
                isActive ? 'ring-2 ring-blue-500' : ''
              } ${d.entries.length === 0 ? 'cursor-default' : 'cursor-pointer'}`}
            >
              <span className="absolute left-0.5 top-0.5">{d.key === 0 ? 'Today' : `+${d.key}`}</span>
              {d.entries.length > 0 && (
                <span className="absolute right-0.5 bottom-0.5 font-semibold">
                  {d.entries.length}
                </span>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}
