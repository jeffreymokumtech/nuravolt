'use client';

import type { WarrantyTerms } from '@/types/bess';
import {
  Shield,
  Repeat,
  Thermometer,
  Zap,
  Battery,
  Clock,
} from 'lucide-react';

interface WarrantyTermsCardProps {
  terms: WarrantyTerms | null;
  loading?: boolean;
}

export default function WarrantyTermsCard({ terms, loading }: WarrantyTermsCardProps) {
  if (loading) {
    return (
      <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-6">
        <div className="animate-pulse">
          <div className="h-6 bg-gray-200 rounded w-48 mb-4" />
          <div className="grid grid-cols-2 gap-4">
            {Array.from({ length: 6 }).map((_, i) => (
              <div key={i}>
                <div className="h-4 bg-gray-200 rounded w-24 mb-2" />
                <div className="h-5 bg-gray-200 rounded w-16" />
              </div>
            ))}
          </div>
        </div>
      </div>
    );
  }

  if (!terms) {
    return (
      <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-6">
        <p className="text-gray-500 text-center">No warranty terms available</p>
      </div>
    );
  }

  const items: Array<{
    icon: typeof Shield;
    label: string;
    value: string;
    color: string;
  }> = [
    {
      icon: Shield,
      label: 'Capacity Guarantee',
      value: `${terms.capacityGuaranteePct <= 1 ? (terms.capacityGuaranteePct * 100).toFixed(0) : terms.capacityGuaranteePct}% after ${terms.warrantyYears} years`,
      color: 'text-blue-600',
    },
    {
      icon: Repeat,
      label: 'Max Cycles',
      value: terms.maxCycles ? terms.maxCycles.toLocaleString() : 'Unlimited',
      color: 'text-purple-600',
    },
    {
      icon: Thermometer,
      label: 'Operating Temperature',
      value:
        terms.operatingTempMinC != null && terms.operatingTempMaxC != null
          ? `${terms.operatingTempMinC} - ${terms.operatingTempMaxC} C`
          : '-',
      color: 'text-orange-600',
    },
    {
      icon: Zap,
      label: 'C-Rate Limit',
      value: terms.maxCRateContinuous != null
        ? `${terms.maxCRateContinuous}C continuous${terms.maxCRatePeak ? ` / ${terms.maxCRatePeak}C peak` : ''}`
        : '-',
      color: 'text-amber-600',
    },
    {
      icon: Battery,
      label: 'SoC Range',
      value:
        terms.minSoc != null || terms.maxAvgSoc != null
          ? `${terms.minSoc != null ? `Min ${(terms.minSoc * 100).toFixed(0)}%` : ''}${terms.minSoc != null && terms.maxAvgSoc != null ? ' / ' : ''}${terms.maxAvgSoc != null ? `Avg max ${(terms.maxAvgSoc * 100).toFixed(0)}%` : ''}`
          : '-',
      color: 'text-green-600',
    },
    {
      icon: Clock,
      label: 'Min Round-Trip Eff.',
      value: terms.minRte != null
        ? `${(terms.minRte <= 1 ? terms.minRte * 100 : terms.minRte).toFixed(1)}%`
        : '-',
      color: 'text-teal-600',
    },
  ];

  return (
    <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-6">
      <h3 className="text-lg font-semibold text-gray-900 mb-4">Warranty Contract Terms</h3>
      <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
        {items.map((item) => {
          const Icon = item.icon;
          return (
            <div key={item.label} className="p-3 rounded-lg bg-gray-50 border border-gray-100">
              <div className="flex items-center gap-2 mb-1">
                <Icon className={`w-4 h-4 ${item.color}`} />
                <span className="text-xs font-medium text-gray-500 uppercase tracking-wide">
                  {item.label}
                </span>
              </div>
              <p className="text-sm font-semibold text-gray-900">{item.value}</p>
            </div>
          );
        })}
      </div>
      {terms.maxThroughputMwh && (
        <div className="mt-3 px-3 py-2 rounded-lg bg-gray-50 border border-gray-100 text-sm">
          <span className="text-gray-500">Max Throughput: </span>
          <span className="font-semibold text-gray-900">
            {terms.maxThroughputMwh.toLocaleString()} MWh
          </span>
        </div>
      )}
    </div>
  );
}
