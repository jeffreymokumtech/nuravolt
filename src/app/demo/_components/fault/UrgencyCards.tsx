'use client';

import { motion } from 'framer-motion';
import { AlertCircle, Clock, Calendar, Eye } from 'lucide-react';
import type { UrgencySummary, FaultUrgency } from '@/types/faults';

interface UrgencyCardsProps {
  urgencySummary: UrgencySummary | null | undefined;
  loading?: boolean;
}

const URGENCY_CONFIG: Record<FaultUrgency, {
  label: string;
  sublabel: string;
  icon: typeof AlertCircle;
  bgColor: string;
  borderColor: string;
  iconBg: string;
  iconColor: string;
  textColor: string;
}> = {
  urgent: {
    label: 'Urgent',
    sublabel: '< 3 days',
    icon: AlertCircle,
    bgColor: 'bg-signal-critical/10',
    borderColor: 'border-l-red-500',
    iconBg: 'bg-signal-critical/10',
    iconColor: 'text-signal-critical',
    textColor: 'text-signal-critical',
  },
  soon: {
    label: 'Soon',
    sublabel: '3-7 days',
    icon: Clock,
    bgColor: 'bg-orange-50',
    borderColor: 'border-l-orange-500',
    iconBg: 'bg-orange-100',
    iconColor: 'text-orange-600',
    textColor: 'text-orange-700',
  },
  planned: {
    label: 'Planned',
    sublabel: '7-30 days',
    icon: Calendar,
    bgColor: 'bg-blue-50',
    borderColor: 'border-l-blue-500',
    iconBg: 'bg-blue-100',
    iconColor: 'text-blue-600',
    textColor: 'text-blue-700',
  },
  monitoring: {
    label: 'Monitoring',
    sublabel: '> 30 days',
    icon: Eye,
    bgColor: 'bg-paper',
    borderColor: 'border-l-gray-400',
    iconBg: 'bg-paper-2',
    iconColor: 'text-ink-2',
    textColor: 'text-ink-2',
  },
};

const formatCurrency = (value: number) => {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'EUR',
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(value);
};

export default function UrgencyCards({ urgencySummary, loading }: UrgencyCardsProps) {
  if (loading) {
    return (
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        {[1, 2, 3, 4].map((i) => (
          <div key={i} className="bg-white rounded-xl border border-divider p-4 animate-pulse">
            <div className="h-3 bg-divider rounded w-16 mb-2"></div>
            <div className="h-8 bg-divider rounded w-12 mb-2"></div>
            <div className="h-3 bg-divider rounded w-20"></div>
          </div>
        ))}
      </div>
    );
  }

  if (!urgencySummary) {
    return (
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        {(['urgent', 'soon', 'planned', 'monitoring'] as FaultUrgency[]).map((urgency) => {
          const config = URGENCY_CONFIG[urgency];
          const Icon = config.icon;
          return (
            <div
              key={urgency}
              className={`${config.bgColor} rounded-xl border border-divider border-l-4 ${config.borderColor} p-4`}
            >
              <div className="flex items-center justify-between mb-2">
                <span className="text-xs font-medium text-ink-2">{config.label}</span>
                <div className={`p-1.5 rounded-lg ${config.iconBg}`}>
                  <Icon className={`w-3.5 h-3.5 ${config.iconColor}`} />
                </div>
              </div>
              <div className={`text-2xl font-bold ${config.textColor}`}>-</div>
              <div className="text-xs text-ink-3 mt-1">{config.sublabel}</div>
            </div>
          );
        })}
      </div>
    );
  }

  const urgencyOrder: FaultUrgency[] = ['urgent', 'soon', 'planned', 'monitoring'];

  return (
    <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
      {urgencyOrder.map((urgency, index) => {
        const config = URGENCY_CONFIG[urgency];
        const data = urgencySummary?.[urgency] ?? { count: 0, total_revenue_at_risk_eur: 0 };
        const Icon = config.icon;

        return (
          <motion.div
            key={urgency}
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: index * 0.1 }}
            className={`${config.bgColor} rounded-xl border border-divider border-l-4 ${config.borderColor} p-4 hover:shadow-md transition-shadow`}
          >
            <div className="flex items-center justify-between mb-2">
              <span className="text-xs font-medium text-ink-2">{config.label}</span>
              <div className={`p-1.5 rounded-lg ${config.iconBg}`}>
                <Icon className={`w-3.5 h-3.5 ${config.iconColor}`} />
              </div>
            </div>
            <div className={`text-2xl font-bold ${config.textColor}`}>
              {data.count}
            </div>
            <div className="text-xs text-ink-3 mt-1">{config.sublabel}</div>
            {data.total_revenue_at_risk_eur > 0 && (
              <div className="mt-2 pt-2 border-t border-divider">
                <div className="text-xs text-ink-3">At risk</div>
                <div className={`text-sm font-semibold ${config.textColor}`}>
                  {formatCurrency(data.total_revenue_at_risk_eur)}
                </div>
              </div>
            )}
          </motion.div>
        );
      })}
    </div>
  );
}
