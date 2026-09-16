'use client';

import { ReactNode, useRef } from 'react';
import { motion, useInView } from 'framer-motion';

interface AnimatedChartProps {
  children: ReactNode;
  className?: string;
  delay?: number;
}

/**
 * Wrapper component that adds entrance animation to charts
 * Fades in and scales up when the chart enters the viewport
 */
export default function AnimatedChart({
  children,
  className = '',
  delay = 0
}: AnimatedChartProps) {
  const ref = useRef<HTMLDivElement>(null);
  const isInView = useInView(ref, { once: true, amount: 0.3 });

  return (
    <motion.div
      ref={ref}
      initial={{ opacity: 0, scale: 0.95, y: 20 }}
      animate={isInView ? { opacity: 1, scale: 1, y: 0 } : { opacity: 0, scale: 0.95, y: 20 }}
      transition={{
        duration: 0.5,
        delay,
        ease: [0.25, 0.1, 0.25, 1],
      }}
      className={className}
    >
      {children}
    </motion.div>
  );
}

/**
 * Wrapper for chart containers with loading state support
 */
interface AnimatedChartContainerProps {
  children: ReactNode;
  loading?: boolean;
  title?: string;
  subtitle?: string;
  className?: string;
  headerAction?: ReactNode;
}

export function AnimatedChartContainer({
  children,
  loading = false,
  title,
  subtitle,
  className = '',
  headerAction,
}: AnimatedChartContainerProps) {
  const ref = useRef<HTMLDivElement>(null);
  const isInView = useInView(ref, { once: true, amount: 0.2 });

  return (
    <motion.div
      ref={ref}
      initial={{ opacity: 0, y: 20 }}
      animate={isInView ? { opacity: 1, y: 0 } : { opacity: 0, y: 20 }}
      transition={{ duration: 0.4, ease: 'easeOut' }}
      className={`bg-white rounded-xl shadow-sm border border-gray-200 overflow-hidden ${className}`}
    >
      {(title || headerAction) && (
        <div className="px-6 py-4 border-b border-gray-100 flex items-center justify-between">
          <div>
            {title && <h3 className="text-lg font-semibold text-gray-900">{title}</h3>}
            {subtitle && <p className="text-sm text-gray-500 mt-0.5">{subtitle}</p>}
          </div>
          {headerAction}
        </div>
      )}
      <div className="p-6">
        {loading ? (
          <div className="flex items-center justify-center h-64">
            <motion.div
              className="w-10 h-10 border-3 border-blue-600 border-t-transparent rounded-full"
              animate={{ rotate: 360 }}
              transition={{ repeat: Infinity, duration: 1, ease: 'linear' }}
            />
          </div>
        ) : (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: 0.3, delay: 0.2 }}
          >
            {children}
          </motion.div>
        )}
      </div>
    </motion.div>
  );
}
