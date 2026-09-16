'use client';

import { motion } from 'framer-motion';
import { LucideIcon } from 'lucide-react';
import { cn } from '@/helpers/utils';

export interface SimpleKpiCardProps {
  title: string;
  value: string | number;
  subtitle?: string;
  color?: 'blue' | 'green' | 'yellow' | 'red' | 'purple' | 'emerald' | 'amber';
  index?: number;
  icon?: LucideIcon;
}

const colorClasses: Record<string, { bg: string; border: string; valueColor: string; iconBg: string; iconColor: string }> = {
  blue: {
    bg: 'bg-white',
    border: 'border-slate-200',
    valueColor: 'text-slate-900',
    iconBg: 'bg-blue-50',
    iconColor: 'text-blue-600',
  },
  green: {
    bg: 'bg-white',
    border: 'border-slate-200',
    valueColor: 'text-slate-900',
    iconBg: 'bg-emerald-50',
    iconColor: 'text-emerald-600',
  },
  emerald: {
    bg: 'bg-white',
    border: 'border-slate-200',
    valueColor: 'text-slate-900',
    iconBg: 'bg-emerald-50',
    iconColor: 'text-emerald-600',
  },
  yellow: {
    bg: 'bg-white',
    border: 'border-slate-200',
    valueColor: 'text-slate-900',
    iconBg: 'bg-amber-50',
    iconColor: 'text-amber-600',
  },
  amber: {
    bg: 'bg-white',
    border: 'border-slate-200',
    valueColor: 'text-slate-900',
    iconBg: 'bg-amber-50',
    iconColor: 'text-amber-600',
  },
  red: {
    bg: 'bg-white',
    border: 'border-slate-200',
    valueColor: 'text-slate-900',
    iconBg: 'bg-red-50',
    iconColor: 'text-red-600',
  },
  purple: {
    bg: 'bg-white',
    border: 'border-slate-200',
    valueColor: 'text-slate-900',
    iconBg: 'bg-purple-50',
    iconColor: 'text-purple-600',
  },
};

export default function SimpleKpiCard({
  title,
  value,
  subtitle,
  color = 'blue',
  index = 0,
  icon: Icon,
}: SimpleKpiCardProps) {
  const colors = colorClasses[color] || colorClasses.blue;

  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{
        duration: 0.3,
        delay: index * 0.05,
        ease: 'easeOut',
      }}
      className={cn(
        "relative overflow-hidden bg-white border border-slate-200 rounded-xl p-5 shadow-sm hover:shadow-md transition-shadow duration-200",
        // Subtle accent line at the top
        color === 'red' && "border-t-red-500 border-t-2",
        color === 'emerald' && "border-t-emerald-500 border-t-2",
        color === 'amber' && "border-t-amber-500 border-t-2",
        color === 'blue' && "border-t-blue-500 border-t-2"
      )}
    >
      <div className="flex justify-between items-start">
        <div>
          <div className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-1">
            {title}
          </div>
          <div className={cn("text-2xl font-bold tracking-tight text-slate-900")}>
            {value}
          </div>
        </div>
        {Icon && (
          <div className={cn("p-2 rounded-lg", colors.iconBg, colors.iconColor)}>
            <Icon className="w-5 h-5" />
          </div>
        )}
      </div>
      {subtitle && (
        <div className="text-xs text-slate-500 mt-2 flex items-center gap-1">
          {subtitle}
        </div>
      )}
    </motion.div>
  );
}
