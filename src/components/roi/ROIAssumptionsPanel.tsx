'use client';

import { useState } from 'react';
import { ChevronDown, ChevronUp, FileText, ExternalLink } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { type Assumption } from '@/utils/roiCalculator';

interface ROIAssumptionsPanelProps {
  assumptions: Assumption[];
}

export default function ROIAssumptionsPanel({ assumptions }: ROIAssumptionsPanelProps) {
  const [isExpanded, setIsExpanded] = useState(false);

  // Group assumptions by category
  const groupedAssumptions = assumptions.reduce((acc, assumption) => {
    if (!acc[assumption.category]) {
      acc[assumption.category] = [];
    }
    acc[assumption.category].push(assumption);
    return acc;
  }, {} as Record<string, Assumption[]>);

  const categories = Object.keys(groupedAssumptions);

  return (
    <div className="bg-paper rounded border-2 border-divider overflow-hidden">
      {/* Header - Collapsible */}
      <button
        onClick={() => setIsExpanded(!isExpanded)}
        className="w-full px-8 py-6 flex items-center justify-between hover:bg-paper-2 transition-colors"
      >
        <div className="flex items-center gap-3">
          <FileText className="w-6 h-6 text-primary" />
          <div className="text-left">
            <h3 className="text-xl font-bold text-ink">
              View Detailed Assumptions
            </h3>
            <p className="text-sm text-ink-2">
              All parameters, formulas, and research sources
            </p>
          </div>
        </div>
        {isExpanded ? (
          <ChevronUp className="w-6 h-6 text-ink-3" />
        ) : (
          <ChevronDown className="w-6 h-6 text-ink-3" />
        )}
      </button>

      {/* Expandable Content */}
      <AnimatePresence>
        {isExpanded && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.3 }}
            className="border-t border-divider"
          >
            <div className="p-8 space-y-8">
              {/* Categories */}
              {categories.map((category) => (
                <div key={category}>
                  <h4 className="text-lg font-bold text-ink mb-4 flex items-center gap-2">
                    <span className="w-2 h-2 bg-primary rounded-full"></span>
                    {category}
                  </h4>
                  <div className="bg-paper-2 rounded-lg overflow-hidden">
                    <table className="w-full">
                      <thead>
                        <tr className="bg-paper-2 border-b border-divider">
                          <th className="px-4 py-3 text-left text-sm font-semibold text-ink-2">Parameter</th>
                          <th className="px-4 py-3 text-left text-sm font-semibold text-ink-2">Value</th>
                          <th className="px-4 py-3 text-left text-sm font-semibold text-ink-2">Source</th>
                        </tr>
                      </thead>
                      <tbody>
                        {groupedAssumptions[category].map((assumption, idx) => (
                          <tr
                            key={idx}
                            className="border-b border-divider last:border-b-0 hover:bg-paper-2 transition-colors"
                          >
                            <td className="px-4 py-3 text-sm font-medium text-ink">
                              {assumption.parameter}
                            </td>
                            <td className="px-4 py-3 text-sm text-primary font-semibold">
                              {assumption.value}
                            </td>
                            <td className="px-4 py-3 text-sm text-ink-2">
                              {assumption.source}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              ))}

              {/* Link to Full Documentation */}
              <div className="bg-primary rounded-lg p-6 text-center">
                <h4 className="text-white font-bold mb-2">
                  Want to see the complete methodology?
                </h4>
                <p className="text-data-fg-2 mb-4 text-sm">
                  Read our comprehensive documentation with all formulas, research citations, and calculation logic
                </p>
                <a
                  href="/ROI_ASSUMPTIONS.md"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-2 bg-paper text-primary px-6 py-3 rounded-lg font-semibold hover:bg-paper-2 transition-colors"
                >
                  <FileText className="w-5 h-5" />
                  View ROI_ASSUMPTIONS.md
                  <ExternalLink className="w-4 h-4" />
                </a>
              </div>

              {/* Research Sources */}
              <div className="bg-paper-2 border border-divider rounded-lg p-6">
                <h4 className="font-bold text-ink mb-3">Research Sources</h4>
                <ul className="space-y-2 text-sm text-ink-2">
                  <li className="flex items-start gap-2">
                    <span className="text-primary font-bold mt-1">•</span>
                    <span><span className="font-semibold">NREL Solar Resource Database:</span> Global solar irradiance data</span>
                  </li>
                  <li className="flex items-start gap-2">
                    <span className="text-primary font-bold mt-1">•</span>
                    <span><span className="font-semibold">IEA PVPS Task 13:</span> Soiling rates and performance benchmarks</span>
                  </li>
                  <li className="flex items-start gap-2">
                    <span className="text-primary font-bold mt-1">•</span>
                    <span><span className="font-semibold">Sandia National Labs:</span> PV degradation and reliability studies</span>
                  </li>
                  <li className="flex items-start gap-2">
                    <span className="text-primary font-bold mt-1">•</span>
                    <span><span className="font-semibold">NuraVolt Case Studies:</span> Validated customer results (2022-2024)</span>
                  </li>
                </ul>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
