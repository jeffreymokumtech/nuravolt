'use client';

import { motion } from 'framer-motion';

/**
 * SectionSkeleton - Loading skeleton for lazy-loaded demo sections
 * Provides visual feedback with shimmer effect while sections are being loaded
 */

interface SectionSkeletonProps {
  title: string;
}

// Shimmer animation overlay
function ShimmerOverlay() {
  return (
    <motion.div
      className="absolute inset-0 -translate-x-full bg-gradient-to-r from-transparent via-white/60 to-transparent"
      animate={{ translateX: ['100%', '-100%'] }}
      transition={{
        repeat: Infinity,
        duration: 1.5,
        ease: 'linear',
      }}
    />
  );
}

// Individual skeleton element with shimmer
function SkeletonBox({ className }: { className: string }) {
  return (
    <div className={`relative overflow-hidden bg-gray-200 rounded ${className}`}>
      <ShimmerOverlay />
    </div>
  );
}

export default function SectionSkeleton({ title }: SectionSkeletonProps) {
  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      className="space-y-6"
    >
      {/* Header skeleton */}
      <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-6">
        <SkeletonBox className="h-8 w-1/3 mb-4" />
        <SkeletonBox className="h-4 w-2/3" />
      </div>

      {/* KPI Cards skeleton */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {[1, 2, 3, 4, 5, 6].map((i) => (
          <motion.div
            key={i}
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: i * 0.05 }}
            className="bg-white rounded-lg border border-gray-200 p-4 h-32"
          >
            <SkeletonBox className="h-4 w-1/2 mb-2" />
            <SkeletonBox className="h-8 w-3/4 mt-3" />
            <SkeletonBox className="h-3 w-1/3 mt-2" />
          </motion.div>
        ))}
      </div>

      {/* Main content skeleton */}
      <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-6 h-96">
        <div className="h-full bg-gray-50 rounded flex items-center justify-center relative overflow-hidden">
          <div className="absolute inset-0">
            {/* Chart-like skeleton lines */}
            <div className="absolute bottom-8 left-8 right-8 h-64 flex items-end gap-1">
              {[...Array(24)].map((_, i) => (
                <motion.div
                  key={i}
                  className="flex-1 bg-gray-200 rounded-t relative overflow-hidden"
                  initial={{ height: 0 }}
                  animate={{ height: `${20 + Math.random() * 60}%` }}
                  transition={{ delay: i * 0.02, duration: 0.4 }}
                >
                  <ShimmerOverlay />
                </motion.div>
              ))}
            </div>
          </div>
          <div className="relative z-10 text-center">
            <motion.div
              className="inline-block rounded-full h-10 w-10 border-2 border-blue-600 border-t-transparent mb-3"
              animate={{ rotate: 360 }}
              transition={{ repeat: Infinity, duration: 1, ease: 'linear' }}
            />
            <p className="text-gray-500 font-medium">{title}</p>
          </div>
        </div>
      </div>
    </motion.div>
  );
}
