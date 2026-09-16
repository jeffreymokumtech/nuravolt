'use client';

import { motion } from 'framer-motion';
import { notFound } from 'next/navigation';
import PublicLayout from '@/components/layouts/PublicLayout';
import LeadCaptureForm from '@/components/resources/LeadCaptureForm';
import NuraVoltLogo from '@/components/NuraVoltLogo';
import { FileText, CheckCircle, ArrowLeft, Award } from 'lucide-react';
import Link from 'next/link';
import Image from 'next/image';

// Resource definitions
const resourcesData: Record<string, any> = {
  // NEW: Comprehensive Technical Whitepapers (PDF-ready)
  'soiling-intelligence': {
    title: 'Soiling Intelligence: Detection, Forecasting & Cleaning Optimization',
    type: 'whitepaper',
    pages: 12,
    description: 'Complete technical specification for physics-informed soiling detection achieving 94-97% accuracy, with cleaning schedule optimization delivering 30-35% cost reduction.',
    problem: 'Solar plant operators lose €40-90K/year per 100MW from suboptimal cleaning schedules. Traditional PR monitoring achieves only 75-85% accuracy with 15-25% false positive rates, leading to over-cleaning or under-cleaning.',
    insights: [
      '94-97% detection accuracy validated across Spanish 120MW, UAE 50MW, and Australian deployments',
      'Physics-based detection: pvlib clearsky model with Haydavies transposition',
      'ML-enhanced prediction: LightGBM with 15 physics-informed features',
      'Climate-specific thresholds: Arid (5-12%), Semi-arid (3-10%), Temperate (2-7%)',
      'Cleaning optimization: 767% ROI, 2.7-month payback, €109K+ annual savings',
      'No hardware required - software-only using existing SCADA data'
    ],
    downloadUrl: '/resources/pdfs/soiling-intelligence.pdf',
    coverImage: 'https://images.unsplash.com/photo-1509391366360-2e959784a276?w=800&auto=format&fit=crop',
    isPdfReady: true
  },
  'fault-detection-spec': {
    title: 'Fault Detection: Predictive & Reactive Capabilities',
    type: 'whitepaper',
    pages: 15,
    description: 'Precise specifications for solar PV fault detection distinguishing predictive faults (70-75%, 2-15 days warning) from reactive faults (25-30%, real-time only).',
    problem: 'Traditional SCADA monitoring has 70-85% false positive rates and provides no advance warning. Operators miss gradual degradation patterns that lead to expensive failures.',
    insights: [
      'Predictive faults (70-75%): Detectable 1-90 days in advance through gradual degradation patterns',
      'Reactive faults (25-30%): Instantaneous detection only (lightning, surges, mechanical damage)',
      'Inverter faults: 2-15 day warning for capacitor, IGBT, cooling system, control board issues',
      'String faults: CV-based detection for connector corrosion, wire degradation, bypass diode thermal issues',
      'Module degradation: 30-90 day prediction for hot spots, delamination, PID',
      'Digital twin advantage: 200+ data points/MW vs 4-8 for traditional PR monitoring'
    ],
    downloadUrl: '/resources/pdfs/fault-detection-spec.pdf',
    coverImage: 'https://images.unsplash.com/photo-1581092918056-0c4c3acd3789?w=800&auto=format&fit=crop',
    isPdfReady: true
  },
  'transfer-learning': {
    title: 'Transfer Learning: 50+ GW Pre-Trained Models for Rapid Deployment',
    type: 'whitepaper',
    pages: 14,
    description: 'How NuraVolt deploys accurate ML models in 3-6 months vs 12+ months industry standard using transfer learning from the largest solar dataset.',
    problem: 'Traditional ML approaches require 12+ months of site-specific data collection before achieving acceptable accuracy. This cold-start problem delays value delivery and increases deployment costs.',
    insights: [
      '50+ GW pre-training dataset from NREL PVDAQ, IEA PVPS Task 13, IEEE datasets',
      '10+ years historical data across 40+ countries, 15+ inverter OEMs',
      '3-stage pipeline: Pre-training (92%) → Domain adaptation (85-90%) → Continuous learning (92-96%)',
      'Zero-shot performance: 87-90% accuracy without site-specific training',
      '4-stage data quality pipeline retaining 83% of data while improving accuracy by +8-12%',
      'Real-world validation: Spanish 120MW (96.9%), Dutch 85MW (94.8%), UAE 50MW (95.3%)'
    ],
    downloadUrl: '/resources/pdfs/transfer-learning.pdf',
    coverImage: 'https://images.unsplash.com/photo-1518770660439-4636190af475?w=800&auto=format&fit=crop',
    isPdfReady: true
  },
  'forecasting-365day': {
    title: '365-Day Soiling Forecast System',
    type: 'whitepaper',
    pages: 10,
    description: 'Physics-ML hybrid forecasting with uncertainty quantification and optimal cleaning schedule optimization for maximum ROI.',
    problem: 'Fixed cleaning schedules waste money through over-cleaning in wet seasons and under-cleaning in dry seasons. Operators need data-driven scheduling optimized for their specific plant economics.',
    insights: [
      '365-day forecast horizon with physics baseline + ML corrections',
      'Uncertainty quantification: ±2% (30d), ±5% (90d), ±8-12% (365d)',
      'Seasonal modulation: 1.5x dry season (May-Sept), 0.5x wet (Oct-Apr)',
      'Rain cleaning model: >10mm = up to 95% restoration',
      'Exhaustive search optimizer tests 1-5 cleaning scenarios per year',
      'Example: 2 optimized cleanings vs 12 baseline → €109K net benefit, 1013% ROI'
    ],
    downloadUrl: '/resources/pdfs/forecasting-365day.pdf',
    coverImage: 'https://images.unsplash.com/photo-1551288049-bebda4e38f71?w=800&auto=format&fit=crop',
    isPdfReady: true
  },
  'digital-twin-config': {
    title: 'Digital Twin Configuration Guide',
    type: 'whitepaper',
    pages: 8,
    description: 'Complete reference for configuring, tuning, and experimenting with NuraVolt digital twin models including CatBoost hyperparameters.',
    problem: 'Default model configurations may not be optimal for all plants. Operators need guidance on tuning parameters for their specific data quality and operational requirements.',
    insights: [
      '11 physics-informed features: Core (irradiance, temps), Temporal (day/hour/month), Solar geometry, Derived',
      'CatBoost hyperparameters: iterations, learning_rate, depth, L2 regularization, early stopping',
      'Data filtering: MAX_YEARS, MIN_PR, MIN_IRRADIANCE, VALIDATION_SPLIT',
      'Quality thresholds: R² > 0.70, MAE < 50 kW for production deployment',
      'Performance matrix: Parameter changes vs training time, accuracy, overfitting risk',
      'Quick trial guide: --limit 5 --digital-twins-only for rapid experimentation'
    ],
    downloadUrl: '/resources/pdfs/digital-twin-config.pdf',
    coverImage: 'https://images.unsplash.com/photo-1558494949-ef010cbdcc31?w=800&auto=format&fit=crop',
    isPdfReady: true
  },

  // Existing resources
  'irradiation-data-quality': {
    title: 'Irradiation Data Quality: Validation Methods for Reliable PV Operations',
    type: 'whitepaper',
    pages: 5,
    description: 'Comprehensive guide on sensor calibration, validation techniques, and data quality best practices for solar operations across diverse climate conditions.',
    problem: 'Poor irradiance sensor quality, calibration drift, and improper maintenance lead to false alarms and missed performance issues. Industry research shows sensor drift as a leading cause of data quality challenges in solar operations across all climate zones.',
    insights: [
      'Physics-based validation methods for irradiation sensors in diverse climates',
      'Calibration schedules and sensor selection criteria for challenging environments',
      'Integration with existing SCADA systems without hardware changes',
      'ROI framework based on avoided false alarms and improved O&M efficiency'
    ],
    downloadUrl: '/resources/pdfs/irradiation-data-quality.pdf',
    coverImage: 'https://images.unsplash.com/photo-1509391366360-2e959784a276?w=800&auto=format&fit=crop'
  },
  'inverter-failures-detection': {
    title: 'Predictive Fault Detection for Solar Inverters: Early Warning Systems',
    type: 'whitepaper',
    pages: 4,
    description: 'Learn how physics-informed ML models detect inverter failures 2-4 weeks before traditional SCADA alarms, reducing O&M costs and maximizing uptime.',
    problem: 'Traditional SCADA systems often miss early degradation signals in inverters, leading to unexpected downtime and lost generation. Early detection can significantly reduce operational costs and extend equipment life.',
    insights: [
      'Seven critical failure modes detectable with physics-informed ML',
      'Early detection methodologies explained accessibly for operations teams',
      'Phase imbalance, DC string mismatch, and thermal degradation signatures',
      'Integration roadmap for existing SCADA systems (2-3 week deployment)'
    ],
    downloadUrl: '/resources/pdfs/inverter-failures-detection.pdf',
    coverImage: 'https://images.unsplash.com/photo-1473341304170-971dccb5ac1e?w=800&auto=format&fit=crop'
  },
  'inverter-faults-ml-vs-traditional': {
    title: '5 Inverter Faults Better Visible with ML than Traditional Monitoring',
    type: 'whitepaper',
    pages: 5,
    description: 'Comparative analysis showing how machine learning detects DC arc faults, thermal degradation, MPPT drift, phase imbalance, and capacitor aging days to weeks before SCADA alarms.',
    problem: 'Standard SCADA monitoring excels at detecting sudden failures but misses gradual degradation patterns that machine learning can identify weeks in advance. This whitepaper compares detection timelines and false alarm rates for five critical inverter fault types.',
    insights: [
      'DC Arc Fault Detection: ML provides 3-7 days advance warning through high-frequency pattern recognition vs. near-instant SCADA response only after fault occurs',
      'Thermal Degradation Tracking: ML detects subtle temperature drift patterns 2-4 weeks early that standard threshold monitoring misses entirely',
      'MPPT Tracking Drift: ML achieves 25% reduction in false alarms by distinguishing weather effects from actual tracking errors',
      'Phase Imbalance Early Detection: Pattern recognition identifies imbalance developing over days vs. SCADA alarms only after exceeding fixed thresholds',
      'Capacitor Aging Prediction: ML forecasts capacitor failures 2-4 weeks in advance through degradation signatures invisible to traditional monitoring',
      'Real-world case studies: Detection timeline comparisons from operational installations across multiple climate zones'
    ],
    downloadUrl: '/resources/pdfs/inverter-faults-ml-vs-traditional.pdf',
    coverImage: 'https://images.unsplash.com/photo-1581092918056-0c4c3acd3789?w=800&auto=format&fit=crop'
  },
  'bess-thermal-runaway': {
    title: 'Battery Energy Storage Reliability: Monitoring Best Practices for Safe Operations',
    type: 'whitepaper',
    pages: 6,
    description: 'Safety-first monitoring guide covering thermal runaway detection, performance optimization KPIs, and warranty compliance strategies for BESS assets.',
    problem: 'Battery energy storage systems require continuous monitoring of safety-critical KPIs to ensure reliable operations. Industry research from EPRI and PNNL shows that early detection of thermal runaway precursors and systematic performance monitoring can significantly improve asset reliability and longevity while maintaining warranty compliance.',
    insights: [
      'Safety-critical KPIs: internal resistance, temperature trends, and cell imbalance monitoring',
      'Early detection framework for thermal runaway precursors months before incidents',
      'Performance optimization through SOC drift monitoring and capacity fade tracking',
      'Warranty compliance strategies based on operational best practices',
      'Implementation roadmap for 4-week deployment with existing BMS data',
      'Reference standards: IEC 62933, UL 9540A, and industry research findings'
    ],
    downloadUrl: '/resources/pdfs/bess-thermal-runaway.pdf',
    coverImage: 'https://images.unsplash.com/photo-1558618666-fcd25c85cd64?w=800&auto=format&fit=crop'
  },
  'pv-data-checklist': {
    title: '5-Step PV Data Quality Checklist',
    type: 'checklist',
    pages: 1,
    description: 'Quick, actionable checklist for sensor calibration, timestamp sync, outlier detection, and data quality validation.',
    problem: 'Bad data leads to bad decisions. This checklist helps you prevent analytics errors before they cost you money.',
    insights: [
      'Sensor calibration quarterly check protocol',
      'Timestamp synchronization verification steps',
      'Outlier detection and automated clipping setup',
      'Missing data protocol and interpolation rules',
      'Irradiation normalization (GHI vs POA consistency)'
    ],
    downloadUrl: '/resources/pdfs/pv-data-checklist.pdf',
    coverImage: 'https://images.unsplash.com/photo-1454165804606-c3d57bc86b40?w=800&auto=format&fit=crop'
  },
  'inverter-checklist': {
    title: '7 Hidden Causes of Inverter Underperformance',
    type: 'checklist',
    pages: 1,
    description: 'Diagnostic checklist for identifying phase imbalance, DC cable mismatch, MPPT errors, and other silent killers.',
    problem: 'Most inverter issues go undetected until they become expensive failures. This checklist helps you catch them early.',
    insights: [
      'Phase imbalance detection (3-phase current deviation check)',
      'DC cable mismatch inspection (string resistance)',
      'MPPT tracking error comparison to expected curve',
      'Thermal derating analysis (ambient vs rated temp)',
      'Voltage deviation monitoring (DC/AC voltage ranges)',
      'Harmonic distortion measurement (THD %)',
      'Partial shading/soiling detection'
    ],
    downloadUrl: '/resources/pdfs/inverter-checklist.pdf',
    coverImage: 'https://images.unsplash.com/photo-1581094794329-c8112a89af12?w=800&auto=format&fit=crop'
  },
  'bess-checklist': {
    title: 'BESS Performance Health Checklist',
    type: 'checklist',
    pages: 1,
    description: 'Monitor SOC drift, temperature gradients, voltage deviation, and cycle aging to maximize battery reliability.',
    problem: 'Battery degradation sneaks up on operators. This checklist helps you catch issues before warranty limits are breached.',
    insights: [
      'SOC drift monitoring and calibration protocol',
      'Temperature gradient checks (<3°C between cells)',
      'Voltage deviation tracking (<50mV per cell)',
      'Cycle aging rate calculation (capacity fade %/month)',
      'Charge/discharge efficiency monitoring',
      'BMS alert review protocol (weekly alarm logs)'
    ],
    downloadUrl: '/resources/pdfs/bess-checklist.pdf',
    coverImage: 'https://images.unsplash.com/photo-1620288627223-53302f4e8c74?w=800&auto=format&fit=crop'
  }
};

export default function ResourcePage({ params }: { params: { slug: string } }) {
  const resource = resourcesData[params.slug];

  if (!resource) {
    notFound();
  }

  const isWhitepaper = resource.type === 'whitepaper';

  return (
    <PublicLayout>
      <div className="min-h-screen bg-paper-2">

      {/* Professional Branding Banner */}
      <div className="bg-primary py-4">
        <div className="container mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex items-center justify-between">
            <div className="flex items-center space-x-4">
              <div className="bg-paper rounded-lg p-2">
                <NuraVoltLogo width={140} height={35} showTagline={false} />
              </div>
              <div className="hidden md:flex items-center space-x-2 text-data-fg-2 text-sm">
                <Award className="w-4 h-4" />
                <span>Trusted by 100+ MWp of Solar & BESS Operations</span>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Back Button */}
      <div className="container mx-auto px-4 sm:px-6 lg:px-8 pt-8">
        <Link
          href="/resources"
          className="inline-flex items-center text-primary hover:text-primary font-medium"
        >
          <ArrowLeft className="w-4 h-4 mr-2" />
          Back to Resources
        </Link>
      </div>

      {/* Hero Section */}
      <section className="py-12 px-4 sm:px-6 lg:px-8">
        <div className="container mx-auto max-w-6xl">
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-12 items-start">
            {/* Left Column - Content */}
            <motion.div
              initial={{ opacity: 0, x: -30 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ duration: 0.6 }}
            >
              <div className="mb-4">
                <span className={`text-xs font-semibold px-3 py-1 rounded-full ${
                  isWhitepaper
                    ? 'bg-paper-2 text-primary'
                    : 'bg-paper-2 text-signal-positive'
                }`}>
                  {isWhitepaper ? 'Technical Whitepaper' : 'Practical Checklist'}
                  {resource.pages && ` • ${resource.pages} page${resource.pages > 1 ? 's' : ''}`}
                </span>
              </div>

              <h1 className="text-3xl sm:text-4xl font-bold text-ink mb-4">
                {resource.title}
              </h1>

              <p className="text-xl text-ink-2 mb-6">
                {resource.description}
              </p>

              {/* Problem Statement */}
              <div className="bg-signal-warning/5 border border-amber-200 rounded-lg p-4 mb-6">
                <h3 className="font-semibold text-amber-900 mb-2">The Problem:</h3>
                <p className="text-amber-800 text-sm">
                  {resource.problem}
                </p>
              </div>

              {/* What You'll Learn */}
              <div className="mb-8">
                <h3 className="font-bold text-ink mb-4 flex items-center">
                  <FileText className="w-5 h-5 mr-2 text-primary" />
                  What You'll Learn:
                </h3>
                <ul className="space-y-3">
                  {resource.insights.map((insight: string, index: number) => (
                    <motion.li
                      key={index}
                      initial={{ opacity: 0, x: -20 }}
                      animate={{ opacity: 1, x: 0 }}
                      transition={{ delay: 0.1 * index }}
                      className="flex items-start"
                    >
                      <CheckCircle className="w-5 h-5 text-signal-positive mr-3 flex-shrink-0 mt-0.5" />
                      <span className="text-ink-2">{insight}</span>
                    </motion.li>
                  ))}
                </ul>
              </div>

              {/* Cover Image (mobile) */}
              <div className="lg:hidden mb-8">
                <div className="relative h-64 rounded-lg overflow-hidden shadow-sm">
                  <Image
                    src={resource.coverImage}
                    alt={resource.title}
                    fill
                    className="object-cover"
                  />
                </div>
              </div>

              {/* Social Proof */}
              <div className="bg-paper-2 border border-divider rounded-lg p-4">
                <p className="text-sm text-ink">
                  <strong>Based on:</strong> Research from NREL, Sandia Labs, IEEE studies, and operational data from 100+ MWp of GCC solar & BESS assets.
                </p>
              </div>
            </motion.div>

            {/* Right Column - Form & Cover */}
            <motion.div
              initial={{ opacity: 0, x: 30 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ duration: 0.6, delay: 0.2 }}
              className="lg:sticky lg:top-8"
            >
              {/* Cover Image (desktop) */}
              <div className="hidden lg:block mb-6">
                <div className="relative h-80 rounded-lg overflow-hidden shadow-sm">
                  <Image
                    src={resource.coverImage}
                    alt={resource.title}
                    fill
                    className="object-cover"
                  />
                </div>
              </div>

              {/* Lead Capture Form */}
              <LeadCaptureForm
                resourceSlug={params.slug}
                resourceType={resource.type}
                resourceTitle={resource.title}
                downloadUrl={resource.downloadUrl}
              />
            </motion.div>
          </div>
        </div>
      </section>

      {/* Additional Value Section */}
      <section className="py-12 px-4 sm:px-6 lg:px-8 bg-paper">
        <div className="container mx-auto max-w-4xl">
          <div className="text-center">
            <h2 className="text-2xl font-bold text-ink mb-4">
              Want Custom Analysis for Your Plant?
            </h2>
            <p className="text-ink-2 mb-6">
              Our UAE-based team can provide a free 15-minute data quality audit and custom ROI calculation.
            </p>
            <a
              href="mailto:contact@nuravolt.com"
              className="inline-block bg-primary hover:bg-primary text-white px-8 py-3 rounded-lg font-semibold transition-colors"
            >
              Contact Us →
            </a>
          </div>
        </div>
      </section>
      </div>
    </PublicLayout>
  );
}
