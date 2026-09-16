'use client';

import { motion } from 'framer-motion';
import { LucideIcon } from 'lucide-react';

interface MetricCardProps {
  icon?: LucideIcon;
  label: string;
  value: string | number;
  description?: string;
  trend?: 'up' | 'down' | 'neutral';
  trendValue?: string;
  color?: 'blue' | 'green' | 'orange' | 'purple';
  className?: string;
}

const colorStyles = {
  blue: {
    bg: 'bg-blue-50',
    border: 'border-blue-200',
    icon: 'text-blue-600',
    text: 'text-blue-900',
    accent: 'text-blue-600'
  },
  green: 'bg-blue-50 border-blue-200 text-blue-600',
  orange: 'bg-blue-50 border-blue-200 text-blue-600',
  purple: 'bg-blue-50 border-blue-200 text-blue-400'
};

export default function MetricCard({
  icon: Icon,
  label,
  value,
  description,
  trend,
  trendValue,
  color = 'blue',
  className = ''
}: MetricCardProps) {
  const styles = colorStyles[color];

  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true }}
      className={`bg-white border-2 ${styles.border} rounded-xl p-6 hover:shadow-lg transition-shadow ${className}`}
    >
      {/* Icon */}
      {Icon && (
        <div className={`w-12 h-12 ${styles.bg} rounded-lg flex items-center justify-center mb-4`}>
          <Icon className={`w-6 h-6 ${styles.icon}`} />
        </div>
      )}

      {/* Label */}
      <p className="text-sm font-medium text-gray-600 mb-2">
        {label}
      </p>

      {/* Value */}
      <div className="flex items-baseline gap-2 mb-2">
        <h3 className={`text-3xl font-bold ${styles.accent}`}>
          {value}
        </h3>
        {trend && trendValue && (
          <span className={`text-sm font-medium ${
            trend === 'up' ? 'text-blue-600' :
            trend === 'down' ? 'text-blue-700' :
            'text-gray-500'
          }`}>
            {trend === 'up' && '↑'}
            {trend === 'down' && '↓'}
            {trendValue}
          </span>
        )}
      </div>

      {/* Description */}
      {description && (
        <p className="text-sm text-gray-600">
          {description}
        </p>
      )}
    </motion.div>
  );
}
