'use client';

import { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Info, X, ArrowRight } from 'lucide-react';
import Link from 'next/link';

interface DemoModeBannerProps {
  variant?: 'minimal' | 'full';
  showCTA?: boolean;
}

export default function DemoModeBanner({ variant = 'full', showCTA = true }: DemoModeBannerProps) {
  const [dismissed, setDismissed] = useState(false);

  if (dismissed) return null;

  if (variant === 'minimal') {
    return (
      <motion.div
        initial={{ opacity: 0, y: -10 }}
        animate={{ opacity: 1, y: 0 }}
        className="flex items-center justify-center gap-2 py-1.5 px-4 bg-gradient-to-r from-blue-600 to-indigo-600 text-white text-sm"
      >
        <Info className="w-4 h-4" />
        <span className="font-medium">Demo Mode</span>
        <span className="text-blue-100">, Viewing sample plant data</span>
        {showCTA && (
          <>
            <span className="mx-2 text-blue-300">|</span>
            <Link
              href="/#contact"
              className="flex items-center gap-1 text-white hover:text-blue-100 font-medium transition-colors"
            >
              Request Access
              <ArrowRight className="w-3 h-3" />
            </Link>
          </>
        )}
        <button
          onClick={() => setDismissed(true)}
          className="ml-auto p-1 hover:bg-white/10 rounded transition-colors"
        >
          <X className="w-4 h-4" />
        </button>
      </motion.div>
    );
  }

  return (
    <AnimatePresence>
      <motion.div
        initial={{ opacity: 0, y: -20 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, y: -20 }}
        className="relative overflow-hidden"
      >
        {/* Animated background gradient */}
        <div className="absolute inset-0 bg-gradient-to-r from-blue-600 via-indigo-600 to-purple-600" />
        <motion.div
          className="absolute inset-0 bg-gradient-to-r from-transparent via-white/10 to-transparent"
          animate={{ x: ['-100%', '100%'] }}
          transition={{ repeat: Infinity, duration: 3, ease: 'linear' }}
        />

        <div className="relative flex items-center justify-between py-2.5 px-4 md:px-6">
          <div className="flex items-center gap-3">
            <div className="flex items-center gap-2">
              <motion.div
                className="w-2 h-2 bg-green-400 rounded-full"
                animate={{ scale: [1, 1.2, 1] }}
                transition={{ repeat: Infinity, duration: 2 }}
              />
              <span className="text-white font-semibold text-sm md:text-base">
                Demo Mode
              </span>
            </div>
            <span className="hidden sm:inline text-blue-100 text-sm">
              Viewing sample data from a 45 MW solar portfolio
            </span>
            <span className="sm:hidden text-blue-100 text-xs">
              Sample data
            </span>
          </div>

          <div className="flex items-center gap-3">
            {showCTA && (
              <motion.div
                whileHover={{ scale: 1.02 }}
                whileTap={{ scale: 0.98 }}
              >
                <Link
                  href="/#contact"
                  className="hidden sm:flex items-center gap-1.5 px-4 py-1.5 bg-white text-blue-600 rounded-lg text-sm font-semibold hover:bg-blue-50 transition-colors"
                >
                  Get Your Demo
                  <ArrowRight className="w-4 h-4" />
                </Link>
              </motion.div>
            )}
            <button
              onClick={() => setDismissed(true)}
              className="p-1.5 text-white/80 hover:text-white hover:bg-white/10 rounded-lg transition-colors"
              aria-label="Dismiss banner"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>
      </motion.div>
    </AnimatePresence>
  );
}
