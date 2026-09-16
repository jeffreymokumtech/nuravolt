'use client';

import { useEffect, useState, useRef } from 'react';
import { motion, useInView, useSpring, useTransform } from 'framer-motion';

interface AnimatedCounterProps {
  value: number;
  duration?: number;
  decimals?: number;
  prefix?: string;
  suffix?: string;
}

function AnimatedCounter({
  value,
  duration = 1.5,
  decimals = 0,
  prefix = '',
  suffix = ''
}: AnimatedCounterProps) {
  const ref = useRef<HTMLSpanElement>(null);
  const isInView = useInView(ref, { once: true, amount: 0.5 });

  const spring = useSpring(0, {
    duration: duration * 1000,
    bounce: 0,
  });

  const display = useTransform(spring, (current) => {
    return `${prefix}${current.toFixed(decimals)}${suffix}`;
  });

  const [displayValue, setDisplayValue] = useState(`${prefix}0${suffix}`);

  useEffect(() => {
    if (isInView) {
      spring.set(value);
    }
  }, [isInView, spring, value]);

  useEffect(() => {
    const unsubscribe = display.on('change', (latest) => {
      setDisplayValue(latest);
    });
    return unsubscribe;
  }, [display]);

  return <span ref={ref}>{displayValue}</span>;
}

// Parse value to extract number and suffix/prefix
function parseValue(value: string | number): {
  numericValue: number;
  prefix: string;
  suffix: string;
  decimals: number;
} {
  if (typeof value === 'number') {
    return { numericValue: value, prefix: '', suffix: '', decimals: 0 };
  }

  const str = String(value);

  // Match patterns like "94.3%", "€1,234", "1.5 MW", etc.
  const match = str.match(/^([€$£¥]?)([0-9,.]+)\s*(.*)$/);

  if (match) {
    const prefix = match[1] || '';
    const numStr = match[2].replace(/,/g, '');
    const suffix = match[3] || '';
    const numericValue = parseFloat(numStr) || 0;
    const decimals = numStr.includes('.') ? (numStr.split('.')[1]?.length || 0) : 0;

    return { numericValue, prefix, suffix: suffix ? ` ${suffix}`.trimStart() : '', decimals };
  }

  // If no number found, return 0
  return { numericValue: 0, prefix: '', suffix: str, decimals: 0 };
}

export interface AnimatedKpiCardProps {
  title: string;
  value: string | number;
  subtitle?: string;
  color?: 'blue' | 'green' | 'yellow' | 'red' | 'purple' | 'emerald' | 'amber';
  index?: number; // For stagger animation
  animateValue?: boolean;
}

const colorClasses: Record<string, { gradient: string; border: string; valueColor: string }> = {
  blue: {
    gradient: 'from-blue-100 to-blue-50',
    border: 'border-blue-200',
    valueColor: 'text-blue-700',
  },
  green: {
    gradient: 'from-green-100 to-green-50',
    border: 'border-green-200',
    valueColor: 'text-green-700',
  },
  emerald: {
    gradient: 'from-emerald-100 to-emerald-50',
    border: 'border-emerald-200',
    valueColor: 'text-emerald-700',
  },
  yellow: {
    gradient: 'from-amber-100 to-amber-50',
    border: 'border-amber-200',
    valueColor: 'text-amber-700',
  },
  amber: {
    gradient: 'from-amber-100 to-amber-50',
    border: 'border-amber-200',
    valueColor: 'text-amber-700',
  },
  red: {
    gradient: 'from-red-100 to-red-50',
    border: 'border-red-200',
    valueColor: 'text-red-700',
  },
  purple: {
    gradient: 'from-purple-100 to-purple-50',
    border: 'border-purple-200',
    valueColor: 'text-purple-700',
  },
};

export default function AnimatedKpiCard({
  title,
  value,
  subtitle,
  color = 'blue',
  index = 0,
  animateValue = true,
}: AnimatedKpiCardProps) {
  const colors = colorClasses[color] || colorClasses.blue;
  const parsed = parseValue(value);

  return (
    <motion.div
      initial={{ opacity: 0, y: 20, scale: 0.95 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      transition={{
        duration: 0.4,
        delay: index * 0.08,
        ease: [0.25, 0.1, 0.25, 1],
      }}
      whileHover={{
        y: -4,
        scale: 1.02,
        boxShadow: '0 12px 24px -8px rgba(0, 0, 0, 0.15)',
      }}
      className={`bg-gradient-to-br ${colors.gradient} ${colors.border} border rounded-xl p-5 shadow-sm cursor-default transition-shadow`}
    >
      <div className="text-sm text-gray-600 font-medium uppercase tracking-wide">
        {title}
      </div>
      <div className={`text-3xl font-bold mt-2 ${colors.valueColor}`}>
        {animateValue && parsed.numericValue !== 0 ? (
          <AnimatedCounter
            value={parsed.numericValue}
            decimals={parsed.decimals}
            prefix={parsed.prefix}
            suffix={parsed.suffix}
          />
        ) : (
          value
        )}
      </div>
      {subtitle && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: (index * 0.08) + 0.3 }}
          className="text-xs text-gray-500 mt-1"
        >
          {subtitle}
        </motion.div>
      )}
    </motion.div>
  );
}

// Export AnimatedCounter for use in other components
export { AnimatedCounter };
