'use client';

import { useState } from 'react';
import { motion } from 'framer-motion';
import PublicLayout from '@/components/layouts/PublicLayout';
import WhitepaperCard from '@/components/resources/WhitepaperCard';
import { FileText, BookOpen, CheckSquare, Lightbulb, Filter } from 'lucide-react';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';

const resources = [
  // NEW: Comprehensive Technical Whitepapers (PDF-ready)
  {
    slug: 'soiling-intelligence',
    title: 'Soiling Intelligence: Detection, Forecasting & Cleaning Optimization',
    description: 'Complete technical specification for physics-informed soiling detection achieving 94-97% accuracy, with cleaning schedule optimization delivering 30-35% cost reduction.',
    type: 'whitepaper' as const,
    category: 'Technical Specification',
    pages: 12,
    isPdfReady: true,
    insights: [
      '94-97% detection accuracy validated across 3 global deployments',
      'Physics-ML hybrid approach using pvlib + LightGBM',
      'Cleaning optimization: 767% ROI, 2.7-month payback',
      'No hardware required - software-only solution'
    ]
  },
  {
    slug: 'fault-detection-spec',
    title: 'Fault Detection: Predictive & Reactive Capabilities',
    description: 'Precise specifications for solar PV fault detection distinguishing predictive faults (70-75%, 2-15 days warning) from reactive faults (25-30%, real-time only).',
    type: 'whitepaper' as const,
    category: 'Technical Specification',
    pages: 15,
    isPdfReady: true,
    insights: [
      '95%+ detection accuracy with <5% false positives',
      'Inverter faults: 2-15 day advance warning',
      'String faults: CV-based degradation prediction',
      'Digital twin advantages over PR monitoring'
    ]
  },
  {
    slug: 'transfer-learning',
    title: 'Transfer Learning: 50+ GW Pre-Trained Models for Rapid Deployment',
    description: 'How NuraVolt deploys accurate ML models in 3-6 months vs 12+ months industry standard using transfer learning from the largest solar dataset.',
    type: 'whitepaper' as const,
    category: 'Technical Specification',
    pages: 14,
    isPdfReady: true,
    insights: [
      '50+ GW pre-training dataset, 10+ years historical data',
      '92-96% accuracy vs 85-90% for traditional ML',
      '3-stage pipeline: pre-train → adapt → continuous learning',
      'Public datasets: NREL PVDAQ, IEA PVPS, IEEE PVEL-AD'
    ]
  },
  {
    slug: 'forecasting-365day',
    title: '365-Day Soiling Forecast System',
    description: 'Physics-ML hybrid forecasting with uncertainty quantification and optimal cleaning schedule optimization for maximum ROI.',
    type: 'whitepaper' as const,
    category: 'Implementation Guide',
    pages: 10,
    isPdfReady: true,
    insights: [
      '365-day forecast horizon with growing uncertainty bands',
      'Physics baseline + ML corrections for accuracy',
      'Exhaustive search optimizer for 1-5 cleanings/year',
      '1013% typical ROI with optimized schedules'
    ]
  },
  {
    slug: 'digital-twin-config',
    title: 'Digital Twin Configuration Guide',
    description: 'Complete reference for configuring, tuning, and experimenting with NuraVolt digital twin models including CatBoost hyperparameters.',
    type: 'whitepaper' as const,
    category: 'Implementation Guide',
    pages: 8,
    isPdfReady: true,
    insights: [
      '11 physics-informed features across 4 categories',
      'CatBoost hyperparameter tuning reference',
      'Data quality vs quantity tradeoff guidance',
      'R² > 0.70 and MAE < 50 kW quality thresholds'
    ]
  },

  // Existing Technical Whitepapers
  {
    slug: 'irradiation-data-quality',
    title: 'Irradiation Data Quality: Validation Methods for Reliable PV Operations',
    description: 'Comprehensive guide on sensor calibration, validation techniques, and data quality best practices for solar operations across diverse climate conditions.',
    type: 'whitepaper' as const,
    category: 'Technical Guide',
    pages: 5,
    insights: [
      'Physics-based validation methods for irradiation sensors',
      'Calibration schedules and sensor selection criteria',
      'Real-world examples from international installations',
      'ROI framework for data quality improvements'
    ]
  },
  {
    slug: 'inverter-failures-detection',
    title: 'Predictive Fault Detection for Solar Inverters: Early Warning Systems',
    description: 'Learn how physics-informed ML models detect inverter failures 2-4 weeks before traditional SCADA alarms, reducing O&M costs and maximizing uptime.',
    type: 'whitepaper' as const,
    category: 'Technical Guide',
    pages: 4,
    insights: [
      'Early detection methods for seven critical failure modes',
      'Physics-informed ML approach explained accessibly',
      'Integration roadmap with existing SCADA systems',
      'Cost-benefit analysis framework'
    ]
  },
  {
    slug: 'inverter-faults-ml-vs-traditional',
    title: '5 Inverter Faults Better Visible with ML than Traditional Monitoring',
    description: 'Comparative analysis showing how machine learning detects DC arc faults, thermal degradation, MPPT drift, phase imbalance, and capacitor aging days to weeks before SCADA alarms.',
    type: 'whitepaper' as const,
    category: 'Technical Guide',
    pages: 5,
    insights: [
      'DC arc fault detection: 3-7 days advance warning vs. traditional methods',
      'Thermal degradation patterns invisible to standard monitoring',
      'MPPT tracking drift: 25% reduction in false alarms with ML',
      'Phase imbalance early detection through pattern recognition',
      'Capacitor aging prediction: 2-4 weeks advance notice',
      'Real-world comparison: ML vs. SCADA detection timelines'
    ]
  },
  {
    slug: 'bess-thermal-runaway',
    title: 'Battery Energy Storage Reliability: Monitoring Best Practices for Safe Operations',
    description: 'Safety-first monitoring guide covering thermal runaway detection, performance optimization KPIs, and warranty compliance strategies for BESS assets.',
    type: 'whitepaper' as const,
    category: 'Technical Guide',
    pages: 6,
    insights: [
      'Safety-critical KPIs: internal resistance, temperature trends, cell imbalance',
      'Early detection framework for thermal runaway precursors',
      'Warranty optimization through proactive monitoring',
      'Operational best practices from industry research (EPRI/NREL)'
    ]
  },

  // Practical Checklists
  {
    slug: 'pv-data-checklist',
    title: '5-Step PV Data Quality Checklist',
    description: 'Quick, actionable checklist for sensor calibration, timestamp synchronization, outlier detection, and data validation protocols.',
    type: 'checklist' as const,
    category: 'Practical Tool',
    pages: 1,
    insights: [
      'Sensor calibration protocols (quarterly verification)',
      'Timestamp synchronization validation steps',
      'Missing data handling and interpolation rules',
      'Irradiation normalization (GHI vs POA consistency)'
    ]
  },
  {
    slug: 'inverter-checklist',
    title: '7 Hidden Causes of Inverter Underperformance',
    description: 'Diagnostic checklist for identifying phase imbalance, DC cable mismatch, MPPT tracking errors, and other silent performance degradation issues.',
    type: 'checklist' as const,
    category: 'Practical Tool',
    pages: 1,
    insights: [
      'Phase imbalance detection (3-phase current deviation)',
      'DC cable resistance and string mismatch inspection',
      'MPPT tracking error vs expected curve comparison',
      'Thermal derating and voltage deviation monitoring'
    ]
  },
  {
    slug: 'bess-checklist',
    title: 'BESS Performance Health Checklist',
    description: 'Comprehensive monitoring checklist for SOC drift, temperature gradients, voltage deviation, and cycle aging to ensure long-term battery reliability.',
    type: 'checklist' as const,
    category: 'Practical Tool',
    pages: 1,
    insights: [
      'Temperature gradient monitoring (<3°C between cells)',
      'Voltage deviation tracking (<50mV per cell)',
      'SOC drift calibration and cycle aging rate',
      'BMS alert review protocol and efficiency monitoring'
    ]
  },

  // Documentation
  {
    slug: 'roi-assumptions',
    title: 'ROI Calculator Methodology & Assumptions',
    description: 'Complete transparency on ROI calculation methodology with all formulas, regional parameters, research sources, and conservative assumptions used in the NuraVolt ROI calculator.',
    type: 'documentation' as const,
    category: 'Reference Documentation',
    pages: 15,
    insights: [
      'Complete ROI formula documentation with step-by-step examples',
      'Regional parameters for UAE, GCC, Netherlands, Spain, Europe, Africa',
      'Research citations: NREL, IEA PVPS, Sandia Labs',
      'Conservative bias principle: 15% power recovery (actual: 20-30%)',
      'Power recovery, O&M savings, and soiling optimization calculations',
      'Transparent disclaimers and calculation limitations'
    ],
    downloadUrl: '/ROI_ASSUMPTIONS.md',
    isDirectDownload: true
  }
];

export default function ResourcesPage() {
  const [filterType, setFilterType] = useState<string>('all');

  const filteredResources = filterType === 'all'
    ? resources
    : resources.filter(r => r.type === filterType);

  return (
    <PublicLayout>
      <div className="min-h-screen bg-paper-2">
        {/* Hero Section */}
        <section className="py-20 px-4 sm:px-6 lg:px-8">
          <div className="container mx-auto max-w-7xl">
            <motion.div
              initial={{ opacity: 0, y: 30 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.6 }}
              className="text-center max-w-4xl mx-auto mb-16"
            >
              <div className="flex items-center justify-center mb-6">
                <div className="bg-paper-2 rounded-full p-4">
                  <Lightbulb className="w-12 h-12 text-primary" />
                </div>
              </div>
              <h1 className="text-4xl sm:text-5xl font-bold text-ink mb-6">
                Technical Resources & Industry Insights
              </h1>
              <p className="text-xl text-ink-2 mb-4">
                Professional guides, technical whitepapers, and practical tools for solar and battery storage operations across UAE/GCC, Europe, and Africa.
              </p>
              <p className="text-lg text-ink-3">
                Educational content developed from real-world operational data across 100+ MWp of solar and BESS assets in diverse climate conditions.
              </p>
            </motion.div>

            {/* ROI Calculator CTA Banner */}
            <motion.div
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.2 }}
              className="mb-12 bg-paper-2 rounded p-8 text-white text-center"
            >
              <h3 className="text-2xl font-bold mb-3">
                Calculate Your Monitoring ROI
              </h3>
              <p className="text-data-fg-2 mb-6 max-w-2xl mx-auto">
                Free calculator with conservative estimates based on NREL research. See how much you can save with energy intelligence.
              </p>
              <div className="flex flex-wrap gap-4 justify-center">
                <a
                  href="/roi-calculator"
                  className="inline-block bg-paper text-primary px-6 py-3 rounded-lg font-semibold hover:bg-paper-2 transition-colors"
                >
                  Calculate ROI →
                </a>
                <a
                  href="/case-studies"
                  className="inline-block bg-primary text-white px-6 py-3 rounded-lg font-semibold hover:bg-data-bg transition-colors border-2 border-white/20"
                >
                  View Case Studies
                </a>
              </div>
            </motion.div>

            {/* Filter Dropdown */}
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ delay: 0.3 }}
              className="flex items-center justify-center gap-4 mb-12"
            >
              <Filter className="w-5 h-5 text-ink-2" />
              <Select value={filterType} onValueChange={setFilterType}>
                <SelectTrigger className="w-64 border-divider focus:border-divider focus:ring-ring">
                  <SelectValue placeholder="Filter resources" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Resources</SelectItem>
                  <SelectItem value="whitepaper">Technical Whitepapers</SelectItem>
                  <SelectItem value="checklist">Practical Checklists</SelectItem>
                  <SelectItem value="documentation">Reference Documentation</SelectItem>
                </SelectContent>
              </Select>
            </motion.div>

          {/* Technical Guides Section */}
          {(filterType === 'all' || filterType === 'whitepaper') && (
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ delay: 0.3 }}
              className="mb-16"
            >
              <div className="flex items-center mb-8">
                <FileText className="w-6 h-6 text-primary mr-2" />
                <h2 className="text-2xl font-bold text-ink">Technical Guides & Whitepapers</h2>
                <span className="ml-3 text-sm text-ink-3">(Educational resources for operations teams)</span>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-8">
                {filteredResources
                  .filter(r => r.type === 'whitepaper')
                  .map((resource, index) => (
                    <motion.div
                      key={resource.slug}
                      initial={{ opacity: 0, y: 20 }}
                      animate={{ opacity: 1, y: 0 }}
                      transition={{ delay: 0.1 * index }}
                    >
                      <WhitepaperCard {...resource} />
                    </motion.div>
                  ))}
              </div>
            </motion.div>
          )}

          {/* Practical Tools Section */}
          {(filterType === 'all' || filterType === 'checklist') && (
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ delay: 0.5 }}
              className="mb-16"
            >
              <div className="flex items-center mb-8">
                <CheckSquare className="w-6 h-6 text-primary mr-2" />
                <h2 className="text-2xl font-bold text-ink">Practical Checklists & Tools</h2>
                <span className="ml-3 text-sm text-ink-3">(Actionable diagnostics and monitoring protocols)</span>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-8">
                {filteredResources
                  .filter(r => r.type === 'checklist')
                  .map((resource, index) => (
                    <motion.div
                      key={resource.slug}
                      initial={{ opacity: 0, y: 20 }}
                      animate={{ opacity: 1, y: 0 }}
                      transition={{ delay: 0.1 * index }}
                    >
                      <WhitepaperCard {...resource} />
                    </motion.div>
                  ))}
              </div>
            </motion.div>
          )}

          {/* Reference Documentation Section */}
          {(filterType === 'all' || filterType === 'documentation') && (
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ delay: 0.7 }}
              className="mb-16"
            >
              <div className="flex items-center mb-8">
                <BookOpen className="w-6 h-6 text-primary mr-2" />
                <h2 className="text-2xl font-bold text-ink">Reference Documentation</h2>
                <span className="ml-3 text-sm text-ink-3">(Methodology and technical references)</span>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-8">
                {filteredResources
                  .filter(r => r.type === 'documentation')
                  .map((resource, index) => (
                    <motion.div
                      key={resource.slug}
                      initial={{ opacity: 0, y: 20 }}
                      animate={{ opacity: 1, y: 0 }}
                      transition={{ delay: 0.1 * index }}
                    >
                      <WhitepaperCard {...resource} />
                    </motion.div>
                  ))}
              </div>
            </motion.div>
          )}

          {/* CTA Section */}
          <motion.div
            initial={{ opacity: 0, y: 30 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.8 }}
            className="mt-20 bg-paper-2 rounded p-12 text-center text-white"
          >
            <h3 className="text-3xl font-bold mb-4">
              Need Custom Analysis for Your Operations?
            </h3>
            <p className="text-xl text-data-fg-2 mb-8 max-w-2xl mx-auto">
              Our international team provides complimentary 15-minute data quality audits and custom ROI analysis for solar and BESS facilities across UAE/GCC, Europe, and Africa.
            </p>
            <a
              href="mailto:contact@nuravolt.com"
              className="inline-block bg-paper text-primary hover:bg-paper-2 px-8 py-4 rounded-lg font-semibold text-lg transition-colors"
            >
              Contact Us →
            </a>
          </motion.div>
        </div>
      </section>
      </div>
    </PublicLayout>
  );
}
