'use client';

import { motion } from 'framer-motion';
import { TrendingUp, DollarSign, Calendar, BarChart3 } from 'lucide-react';
import { type ROIResults } from '@/utils/roiCalculator';
import { formatCurrency, formatPaybackPeriod, formatROI } from '@/utils/formatters';
import MetricCard from '@/components/shared/MetricCard';

interface ROIResultsDashboardProps {
  results: ROIResults;
  mode: 'simple' | 'advanced';
}

export default function ROIResultsDashboard({ results, mode }: ROIResultsDashboardProps) {
  const maxBreakdownValue = Math.max(
    results.breakdown.powerRecovery,
    results.breakdown.omSavings,
    results.breakdown.soilingOptimization
  );

  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      className="bg-paper rounded border-2 border-divider p-8"
    >
      <div className="mb-8">
        <h2 className="text-2xl font-bold text-ink mb-2">
          Your ROI Results
        </h2>
        <p className="text-ink-2">
          Conservative estimates based on {mode === 'simple' ? 'regional defaults' : 'your custom inputs'}
        </p>
      </div>

      {/* Key Metrics Grid */}
      <div className="grid md:grid-cols-3 gap-6 mb-8">
        <MetricCard
          icon={DollarSign}
          label="Total Annual Savings"
          value={formatCurrency(results.totalBenefits)}
          description="Power recovery + O&M + Soiling"
          color="blue"
        />
        <MetricCard
          icon={TrendingUp}
          label="ROI Ratio"
          value={formatROI(results.roiRatio)}
          description="Benefits / Investment"
          color="blue"
        />
        <MetricCard
          icon={Calendar}
          label="Payback Period"
          value={formatPaybackPeriod(results.paybackMonths)}
          description="Time to recover setup cost"
          color="blue"
        />
      </div>

      {/* Savings Breakdown - Bar Chart */}
      <div className="mb-8">
        <div className="flex items-center gap-2 mb-4">
          <BarChart3 className="w-5 h-5 text-primary" />
          <h3 className="text-lg font-bold text-ink">Savings Breakdown</h3>
        </div>

        <div className="space-y-4">
          {/* Power Recovery Bar */}
          <div>
            <div className="flex justify-between text-sm mb-2">
              <span className="font-medium text-ink-2">Power Recovery</span>
              <span className="font-bold text-primary">
                {formatCurrency(results.breakdown.powerRecovery)}/year
              </span>
            </div>
            <div className="relative h-12 bg-paper-2 rounded-lg overflow-hidden">
              <motion.div
                initial={{ width: 0 }}
                animate={{ width: `${(results.breakdown.powerRecovery / maxBreakdownValue) * 100}%` }}
                transition={{ duration: 1, delay: 0.2 }}
                className="absolute inset-y-0 left-0 bg-primary flex items-center justify-end pr-4"
              >
                <span className="text-white font-semibold text-sm">
                  {((results.breakdown.powerRecovery / results.totalBenefits) * 100).toFixed(0)}%
                </span>
              </motion.div>
            </div>
            <p className="text-xs text-ink-3 mt-1">Early fault detection and rapid response</p>
          </div>

          {/* O&M Savings Bar */}
          <div>
            <div className="flex justify-between text-sm mb-2">
              <span className="font-medium text-ink-2">O&M Savings</span>
              <span className="font-bold text-primary">
                {formatCurrency(results.breakdown.omSavings)}/year
              </span>
            </div>
            <div className="relative h-12 bg-paper-2 rounded-lg overflow-hidden">
              <motion.div
                initial={{ width: 0 }}
                animate={{ width: `${(results.breakdown.omSavings / maxBreakdownValue) * 100}%` }}
                transition={{ duration: 1, delay: 0.4 }}
                className="absolute inset-y-0 left-0 bg-paper-2 flex items-center justify-end pr-4"
              >
                <span className="text-white font-semibold text-sm">
                  {((results.breakdown.omSavings / results.totalBenefits) * 100).toFixed(0)}%
                </span>
              </motion.div>
            </div>
            <p className="text-xs text-ink-3 mt-1">Reduced diagnostic time and site visits</p>
          </div>

          {/* Soiling Optimization Bar */}
          <div>
            <div className="flex justify-between text-sm mb-2">
              <span className="font-medium text-ink-2">Soiling Optimization</span>
              <span className="font-bold text-primary">
                {formatCurrency(results.breakdown.soilingOptimization)}/year
              </span>
            </div>
            <div className="relative h-12 bg-paper-2 rounded-lg overflow-hidden">
              <motion.div
                initial={{ width: 0 }}
                animate={{ width: `${(results.breakdown.soilingOptimization / maxBreakdownValue) * 100}%` }}
                transition={{ duration: 1, delay: 0.6 }}
                className="absolute inset-y-0 left-0 bg-paper-2 flex items-center justify-end pr-4"
              >
                <span className="text-white font-semibold text-sm">
                  {((results.breakdown.soilingOptimization / results.totalBenefits) * 100).toFixed(0)}%
                </span>
              </motion.div>
            </div>
            <p className="text-xs text-ink-3 mt-1">Optimized cleaning schedule and detection</p>
          </div>
        </div>
      </div>

      {/* Important Notes */}
      <div className="bg-paper-2 border border-divider rounded-lg p-6">
        <h4 className="font-bold text-ink mb-3">Important Notes</h4>
        <ul className="space-y-2 text-sm text-ink-2">
          <li className="flex items-start gap-2">
            <span className="text-primary font-bold mt-1">•</span>
            <span>
              <span className="font-semibold">Conservative Estimates:</span> Calculator uses 15% power recovery rate (actual: 20-30%). Most customers exceed these estimates by 20-30%.
            </span>
          </li>
          <li className="flex items-start gap-2">
            <span className="text-primary font-bold mt-1">•</span>
            <span>
              <span className="font-semibold">Investment costs not shown:</span> Contact us for custom pricing based on your specific configuration.
            </span>
          </li>
          <li className="flex items-start gap-2">
            <span className="text-primary font-bold mt-1">•</span>
            <span>
              <span className="font-semibold">No Guarantees:</span> Actual results vary based on site conditions, equipment, and operational practices. This is an illustrative example only.
            </span>
          </li>
        </ul>
      </div>

      {/* CTA */}
      <div className="mt-8 text-center">
        <a
          href="mailto:contact@nuravolt.com"
          className="inline-block bg-primary hover:bg-primary text-white px-8 py-4 rounded-lg font-semibold transition-colors"
        >
          Contact Us for Custom ROI Analysis
        </a>
        <p className="text-sm text-ink-3 mt-3">
          Get a personalized assessment based on your specific site and requirements
        </p>
      </div>
    </motion.div>
  );
}
