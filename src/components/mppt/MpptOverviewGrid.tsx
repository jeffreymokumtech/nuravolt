'use client';

import React from 'react';
import Link from 'next/link';
import { Zap, Circle } from 'lucide-react';
import type { MpptData } from '@/types/mppt';
import { usePlantRoutePrefix } from '@/utils/routePrefix';

interface MpptOverviewGridProps {
  mppts: MpptData[];
  plantId: string;
  inverterId: string;
}

const STATUS_CONFIG: Record<
  MpptData['status'],
  { label: string; bg: string; text: string; border: string }
> = {
  normal: {
    label: 'Normal',
    bg: 'bg-emerald-50',
    text: 'text-emerald-700',
    border: 'border-emerald-200',
  },
  warning: {
    label: 'Warning',
    bg: 'bg-amber-50',
    text: 'text-amber-700',
    border: 'border-amber-200',
  },
  fault: {
    label: 'Fault',
    bg: 'bg-red-50',
    text: 'text-red-700',
    border: 'border-red-200',
  },
  offline: {
    label: 'Offline',
    bg: 'bg-gray-50',
    text: 'text-gray-500',
    border: 'border-gray-200',
  },
};

const STRING_STATUS_COLOR: Record<string, string> = {
  normal: 'text-emerald-500',
  degraded: 'text-amber-500',
  open_circuit: 'text-red-500',
  shorted: 'text-red-600',
  offline: 'text-gray-400',
};

export default function MpptOverviewGrid({
  mppts,
  plantId,
  inverterId,
}: MpptOverviewGridProps) {
  const prefix = usePlantRoutePrefix();
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
      {mppts.map((mppt) => {
        const status = STATUS_CONFIG[mppt.status];

        return (
          <Link
            key={mppt.mpptId}
            href={`${prefix}/plant/${plantId}/inverter/${encodeURIComponent(inverterId)}/mppt/${encodeURIComponent(mppt.mpptId)}`}
            className={`
              block rounded-lg border ${status.border} bg-white
              p-4 shadow-sm transition-all duration-150
              hover:shadow-md hover:border-blue-300 hover:-translate-y-0.5
            `}
          >
            {/* Header: MPPT label and status badge */}
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-2">
                <Zap className="h-4 w-4 text-blue-500" />
                <span className="text-sm font-semibold text-gray-900">
                  {mppt.mpptId}
                </span>
              </div>
              <span
                className={`
                  inline-flex items-center rounded-full px-2 py-0.5
                  text-xs font-medium ${status.bg} ${status.text}
                `}
              >
                {status.label}
              </span>
            </div>

            {/* Electrical readings */}
            <div className="grid grid-cols-3 gap-2 text-center mb-3">
              <div>
                <p className="text-[11px] uppercase tracking-wide text-gray-400">
                  Voltage
                </p>
                <p className="text-sm font-medium text-gray-800">
                  {mppt.voltage_V.toFixed(1)}{' '}
                  <span className="text-gray-400 text-xs">V</span>
                </p>
              </div>
              <div>
                <p className="text-[11px] uppercase tracking-wide text-gray-400">
                  Current
                </p>
                <p className="text-sm font-medium text-gray-800">
                  {mppt.current_A.toFixed(2)}{' '}
                  <span className="text-gray-400 text-xs">A</span>
                </p>
              </div>
              <div>
                <p className="text-[11px] uppercase tracking-wide text-gray-400">
                  Power
                </p>
                <p className="text-sm font-medium text-gray-800">
                  {mppt.power_kW.toFixed(2)}{' '}
                  <span className="text-gray-400 text-xs">kW</span>
                </p>
              </div>
            </div>

            {/* String status indicators */}
            <div className="flex items-center gap-3 pt-2 border-t border-gray-100">
              <span className="text-[11px] text-gray-400">Strings</span>
              <div className="flex items-center gap-2">
                {mppt.strings.map((s) => (
                  <div
                    key={s.stringId}
                    className="flex items-center gap-1"
                    title={`${s.stringId}: ${s.status} (${s.power_kW.toFixed(2)} kW)`}
                  >
                    <Circle
                      className={`h-2.5 w-2.5 fill-current ${
                        STRING_STATUS_COLOR[s.status] ?? 'text-gray-400'
                      }`}
                    />
                    <span className="text-[10px] text-gray-500">
                      {s.stringId.replace(/^.*-/, '')}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          </Link>
        );
      })}
    </div>
  );
}
