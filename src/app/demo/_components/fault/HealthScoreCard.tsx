'use client';

import { motion } from 'framer-motion';
import { TrendingUp, TrendingDown, Minus, Activity } from 'lucide-react';
import type { HealthScore, HealthStatus, HealthTrend } from '@/types/faults';

interface HealthScoreCardProps {
  healthScore: HealthScore | null | undefined;
  loading?: boolean;
}

const STATUS_CONFIG: Record<HealthStatus, { color: string; bgColor: string; label: string }> = {
  healthy: { color: 'text-signal-positive', bgColor: 'bg-signal-positive/10', label: 'Healthy' },
  attention_needed: { color: 'text-signal-warning', bgColor: 'bg-yellow-50', label: 'Attention Needed' },
  degraded: { color: 'text-orange-600', bgColor: 'bg-orange-50', label: 'Degraded' },
  critical: { color: 'text-signal-critical', bgColor: 'bg-signal-critical/10', label: 'Critical' },
};

const TREND_CONFIG: Record<HealthTrend, { icon: typeof TrendingUp; color: string; label: string }> = {
  improving: { icon: TrendingUp, color: 'text-emerald-500', label: 'Improving' },
  stable: { icon: Minus, color: 'text-ink-3', label: 'Stable' },
  degrading: { icon: TrendingDown, color: 'text-red-500', label: 'Degrading' },
};

function getScoreColor(value: number): string {
  if (value >= 80) return '#10b981'; // emerald-500
  if (value >= 60) return '#eab308'; // yellow-500
  if (value >= 40) return '#f97316'; // orange-500
  return '#ef4444'; // red-500
}

function CircularGauge({ value, size = 120 }: { value: number; size?: number }) {
  const strokeWidth = 10;
  const radius = (size - strokeWidth) / 2;
  const circumference = 2 * Math.PI * radius;
  const progress = (value / 100) * circumference;
  const color = getScoreColor(value);

  return (
    <div className="relative" style={{ width: size, height: size }}>
      <svg width={size} height={size} className="transform -rotate-90">
        {/* Background circle */}
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke="#e5e7eb"
          strokeWidth={strokeWidth}
        />
        {/* Progress arc */}
        <motion.circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke={color}
          strokeWidth={strokeWidth}
          strokeLinecap="round"
          strokeDasharray={circumference}
          initial={{ strokeDashoffset: circumference }}
          animate={{ strokeDashoffset: circumference - progress }}
          transition={{ duration: 1, ease: 'easeOut' }}
        />
      </svg>
      {/* Center value */}
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <motion.span
          className="text-3xl font-bold text-ink"
          initial={{ opacity: 0, scale: 0.5 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={{ delay: 0.5 }}
        >
          {Math.round(value)}
        </motion.span>
        <span className="text-xs text-ink-3 uppercase tracking-wide">Health</span>
      </div>
    </div>
  );
}

export default function HealthScoreCard({ healthScore, loading }: HealthScoreCardProps) {
  if (loading) {
    return (
      <div className="bg-white rounded-xl border border-divider p-6 animate-pulse">
        <div className="flex items-center gap-2 mb-4">
          <div className="h-5 bg-divider rounded w-32"></div>
        </div>
        <div className="flex items-center justify-center">
          <div className="w-[120px] h-[120px] bg-divider rounded-full"></div>
        </div>
        <div className="mt-4 space-y-2">
          <div className="h-4 bg-divider rounded w-24 mx-auto"></div>
          <div className="h-3 bg-divider rounded w-20 mx-auto"></div>
        </div>
      </div>
    );
  }

  if (!healthScore) {
    return (
      <div className="bg-white rounded-xl border border-divider p-6">
        <div className="flex items-center gap-2 mb-4">
          <Activity className="w-5 h-5 text-ink-3" />
          <h3 className="text-sm font-semibold text-ink">Plant Health</h3>
        </div>
        <div className="flex items-center justify-center h-[120px]">
          <span className="text-ink-3">No data available</span>
        </div>
      </div>
    );
  }

  // Fixture data crosses a trust boundary, an unknown status/trend must
  // degrade gracefully, not white-screen the whole plant page.
  const statusConfig = STATUS_CONFIG[healthScore.status] ?? STATUS_CONFIG.healthy;
  const trendConfig = TREND_CONFIG[healthScore.trend] ?? TREND_CONFIG.stable;
  const TrendIcon = trendConfig.icon;

  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      className="bg-white rounded-xl border border-divider p-6 hover:shadow-md transition-shadow"
    >
      {/* Header */}
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <Activity className="w-5 h-5 text-ink-2" />
          <h3 className="text-sm font-semibold text-ink">Plant Health</h3>
        </div>
        <div className={`flex items-center gap-1 text-xs ${trendConfig.color}`}>
          <TrendIcon className="w-3 h-3" />
          <span>{trendConfig.label}</span>
        </div>
      </div>

      {/* Gauge */}
      <div className="flex justify-center mb-4">
        <CircularGauge value={healthScore.value} />
      </div>

      {/* Status badge */}
      <div className="flex justify-center mb-4">
        <span className={`px-3 py-1 rounded-full text-xs font-medium ${statusConfig.bgColor} ${statusConfig.color}`}>
          {statusConfig.label}
        </span>
      </div>

      {/* Penalty breakdown */}
      <div className="border-t border-divider pt-3 space-y-1">
        <div className="flex justify-between text-xs">
          <span className="text-ink-3">Anomaly penalty</span>
          <span className="text-ink-2 font-medium">-{healthScore.anomaly_penalty}</span>
        </div>
        <div className="flex justify-between text-xs">
          <span className="text-ink-3">Fault penalty</span>
          <span className="text-ink-2 font-medium">-{healthScore.fault_penalty}</span>
        </div>
        <div className="flex justify-between text-xs">
          <span className="text-ink-3">RUL penalty</span>
          <span className="text-ink-2 font-medium">-{healthScore.rul_penalty}</span>
        </div>
      </div>
    </motion.div>
  );
}
