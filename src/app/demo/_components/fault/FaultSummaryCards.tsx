'use client';

import { Zap, TrendingDown, AlertTriangle, Clock } from 'lucide-react';
import type { FaultSummary } from '@/types/faults';

interface FaultSummaryCardsProps {
  summary: FaultSummary | null;
  loading?: boolean;
}

export default function FaultSummaryCards({ summary, loading }: FaultSummaryCardsProps) {
  const formatCurrency = (value: number, currency: string) => {
    const formatter = new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency,
      minimumFractionDigits: 0,
      maximumFractionDigits: 0,
    });
    return formatter.format(value);
  };

  const formatNumber = (value: number) => {
    return new Intl.NumberFormat('en-US', {
      minimumFractionDigits: 0,
      maximumFractionDigits: 0,
    }).format(value);
  };

  const cards = [
    {
      id: 'current-loss',
      label: 'Current Loss',
      value: summary ? `${formatNumber(summary.current_loss_kwh)} kWh` : '-',
      subValue: summary ? formatCurrency(summary.current_loss_value, summary.currency) : '-',
      icon: Zap,
      iconBg: 'bg-signal-critical/10',
      iconColor: 'text-signal-critical',
      borderColor: 'border-l-red-500',
    },
    {
      id: 'projected-loss',
      label: 'Projected Loss',
      value: summary ? `${formatNumber(summary.projected_loss_kwh)} kWh` : '-',
      subValue: summary ? formatCurrency(summary.projected_loss_value, summary.currency) : '-',
      icon: TrendingDown,
      iconBg: 'bg-orange-100',
      iconColor: 'text-orange-600',
      borderColor: 'border-l-orange-500',
    },
    {
      id: 'reactive-count',
      label: 'Active Faults',
      value: summary ? summary.reactive_count.toString() : '-',
      subValue: `${summary?.critical_count ?? 0} critical`,
      icon: AlertTriangle,
      iconBg: 'bg-yellow-100',
      iconColor: 'text-signal-warning',
      borderColor: 'border-l-yellow-500',
    },
    {
      id: 'predictive-count',
      label: 'Predicted Faults',
      value: summary ? summary.predictive_count.toString() : '-',
      subValue: `${summary?.urgent_count ?? 0} urgent`,
      icon: Clock,
      iconBg: 'bg-blue-100',
      iconColor: 'text-blue-600',
      borderColor: 'border-l-blue-500',
    },
  ];

  if (loading) {
    return (
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        {[1, 2, 3, 4].map((i) => (
          <div key={i} className="bg-white rounded-xl border border-divider p-4 animate-pulse">
            <div className="h-4 bg-divider rounded w-24 mb-3"></div>
            <div className="h-8 bg-divider rounded w-32 mb-2"></div>
            <div className="h-3 bg-divider rounded w-20"></div>
          </div>
        ))}
      </div>
    );
  }

  return (
    <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
      {cards.map((card) => {
        const Icon = card.icon;
        return (
          <div
            key={card.id}
            className={`bg-white rounded-xl border border-divider border-l-4 ${card.borderColor} p-4 hover:shadow-md transition-shadow`}
          >
            <div className="flex items-start justify-between mb-3">
              <span className="text-sm font-medium text-ink-2">{card.label}</span>
              <div className={`p-2 rounded-lg ${card.iconBg}`}>
                <Icon className={`w-4 h-4 ${card.iconColor}`} />
              </div>
            </div>
            <div className="text-2xl font-bold text-ink mb-1">
              {card.value}
            </div>
            <div className="text-sm text-ink-3">
              {card.subValue}
            </div>
          </div>
        );
      })}
    </div>
  );
}
