'use client';

import { motion } from 'framer-motion';
import {
  Battery,
  TrendingUp,
  Shield,
  AlertTriangle,
  Activity,
  Gauge,
  Zap,
  Clock,
  CheckCircle,
  BarChart3,
  ThermometerSun,
  CircuitBoard,
  Bell,
} from 'lucide-react';
import BatteryAnalyticsSection from '@/components/landing/BatteryAnalyticsSection';
import ResourceCTA from '@/components/resources/ResourceCTA';
import SolutionHero from '@/components/solutions/SolutionHero';
import SolutionCTA from '@/components/solutions/SolutionCTA';
import { MarketingSection } from '@/components/ui/MarketingSection';
import { KPIReadout } from '@/components/ui/KPIReadout';
import { HairlineRule } from '@/components/ui/HairlineRule';

export default function BESSMonitoringPage() {

  const features = [
    {
      icon: Battery,
      title: 'State of Health (SOH) Estimation',
      description: 'Monitor battery degradation and estimate capacity fade with physics-informed ML models (LightGBM). Achieve sub-1% estimation accuracy with minimal training data, calibrated for LFP, NMC, and NCA chemistries.',
      benefit: 'Precise SOH estimation from day one'
    },
    {
      icon: AlertTriangle,
      title: 'Multi-Tier Thermal Runaway Prediction',
      description: 'Three-tier detection: rule-based thresholds for immediate response, Isolation Forest anomaly detection for early warning, and residual monitoring for predictive alerts. Detects thermal runaway risks 10-30 seconds to days in advance.',
      benefit: 'Layered protection from seconds to days'
    },
    {
      icon: Zap,
      title: 'Dispatch Optimization (LP/MPC)',
      description: 'Mathematical optimization (Linear Programming) for optimal charge/discharge scheduling. Model Predictive Control adapts in real-time to price forecasts while respecting SoC limits, efficiency, and degradation costs.',
      benefit: 'Maximize arbitrage revenue by up to 60%'
    },
    {
      icon: Shield,
      title: 'Warranty Tracking & Compliance',
      description: 'Independent monitoring of warranty KPIs: Equivalent Full Cycles (EFC), throughput, high-SoC time, and temperature stress. Empirical degradation models forecast warranty threshold dates with LFP/NMC/NCA chemistry-specific parameters.',
      benefit: 'Document warranty claims objectively'
    },
    {
      icon: ThermometerSun,
      title: 'Climate-Adaptive Thermal Management',
      description: 'Monitor cell-level temperatures and cooling system performance across diverse climates: extreme heat (60°C) in hot regions, cold-weather battery performance in Europe, and thermal cycling challenges across all zones.',
      benefit: 'Optimized for diverse temperature ranges'
    },
    {
      icon: Gauge,
      title: 'Efficiency & Round-Trip Analysis',
      description: 'Track charging/discharging efficiency, round-trip efficiency, and energy throughput metrics. Degradation-aware dispatch penalizes deep cycles to extend battery life.',
      benefit: 'Optimize charge/discharge strategies'
    },
    {
      icon: Activity,
      title: 'Intelligent False Alarm Reduction',
      description: 'Reduce false alarms by 25-50% through multi-sensor cross-validation. Combines voltage monitoring, temperature tracking, and z-score analysis to confirm anomalies before alerting operations teams.',
      benefit: 'Higher confidence, fewer false alarms'
    },
    {
      icon: CircuitBoard,
      title: 'Flexible BESS Integration',
      description: 'For hybrid PV+BESS from the same brand (Huawei, Sungrow, SolarEdge), data comes through the existing inverter cloud API. For standalone BESS, we integrate with your BMS or EMS via Modbus TCP, CAN bus, or manufacturer APIs. Every setup is different, we work with you to find the right connection.',
      benefit: 'Works with your existing BMS or inverter API'
    },
    {
      icon: Bell,
      title: 'Multi-Channel Alerts & Automated Reports',
      description: 'Configurable notifications via SMS, Email, Teams, Google Chat, and WhatsApp. Scheduled daily/weekly/monthly KPI reports. Emergency shutdown commands for thermal runaway events.',
      benefit: 'Alerts and reports wherever your team works'
    }
  ];

  const bessTypes = [
    {
      title: 'Lithium-Ion (NMC, LFP, NCA)',
      description: 'Comprehensive monitoring for lithium-based systems',
      icon: Battery,
      color: 'blue'
    },
    {
      title: 'Flow Batteries (Vanadium)',
      description: 'Long-duration energy storage analytics',
      icon: Activity,
      color: 'blue'
    },
    {
      title: 'Hybrid PV+Storage',
      description: 'Integrated solar and battery optimization',
      icon: Zap,
      color: 'blue'
    },
    {
      title: 'Grid-Scale BESS',
      description: 'MW-scale utility battery systems',
      icon: BarChart3,
      color: 'blue'
    }
  ];

  const mlFeatures = [
    {
      title: 'Capacity Fade Estimation',
      description: 'LightGBM models with physics constraints estimate remaining capacity with sub-1% error. Trained on NASA Li-ion and CALCE datasets, calibrated for LFP, NMC, and NCA chemistries with chemistry-specific degradation coefficients.',
      metric: 'Sub-1% SOH error',
      icon: TrendingUp
    },
    {
      title: 'Three-Tier Thermal Protection',
      description: 'Tier 1: Rule-based thresholds (no ML). Tier 2: Isolation Forest anomaly detection. Tier 3: LSTM-based residual monitoring. Provides 10-30 second to weeks advance warning depending on failure mode.',
      metric: '3 layers of protection',
      icon: ThermometerSun
    },
    {
      title: 'Dispatch Optimization',
      description: 'Linear Programming optimizer with cvxpy for day-ahead arbitrage. Model Predictive Control re-optimizes at each timestep with updated price forecasts. Degradation costs built into objective function.',
      metric: 'Up to 60% revenue gain',
      icon: Zap
    },
    {
      title: 'Warranty Analytics',
      description: 'Track Equivalent Full Cycles (EFC), throughput, high-SoC hours, and temperature stress. Empirical degradation models (cyclic + calendar aging) project when warranty thresholds will be reached.',
      metric: 'Independent OEM validation',
      icon: Shield
    }
  ];

  return (
    <div className="min-h-screen bg-paper">
      <SolutionHero
        asset="bess"
        eyebrow="BESS monitoring · audit · data foundation"
        headline="Continuous SoH, equivalent-cycle accounting, and warranty defense, on your live BESS data."
        highlight="Or get a one-off BESS audit."
        sub="Plug NuraVolt into your live SCADA, BMS, and inverter data. Track SoH trajectory, equivalent-cycle accounting, degradation-aware dispatch, and CSRD-ready evidence, every day. Calibrated for the chemistries and climates you actually run."
        stats={[
          { value: 'Daily', label: 'SoH + equivalent-cycle accounting' },
          { value: '€/cycle', label: 'Degradation costed per arbitrage cycle' },
          { value: 'CSRD', label: 'Battery Regulation evidence baked in' },
        ]}
        primaryCta={{ label: 'Start continuous monitoring', intent: 'monitoring' }}
        secondaryCta={{ label: 'Or get a one-off audit', intent: 'audit' }}
        screenshot={{
          src: '/images/screenshots/bess-nimbus-overview.png',
          alt: 'NuraVolt BESS Intelligence dashboard, Nimbus Storage, LFP, 100 MW / 200 MWh, warranty health and SoH trajectory',
          panelHeader: 'NIMBUS · 100MW/200MWh · LFP · UK',
          panelMeta: 'nuravolt.com/plant/nimbus',
        }}
      />

      {/* Overview */}
      <MarketingSection size="default">
        <div className="max-w-4xl">
          <motion.div
            initial={{ opacity: 0, y: 12 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }}
            transition={{ duration: 0.4 }}
          >
            <div className="font-mono text-meta uppercase tracking-[0.08em] text-ink-3 mb-3">
              Overview
            </div>
            <h2 className="text-h1 font-semibold text-ink mb-5">
              Battery analytics across diverse chemistries and climates.
            </h2>
            <p className="text-body text-ink-2 mb-4">
              NuraVolt's BESS Monitoring & Management platform delivers comprehensive battery analytics engineered for diverse operational environments. Physics-informed ML models estimate capacity fade with sub-1% accuracy, detect thermal runaway risks seconds to weeks before failures, and optimise charge/discharge strategies to extend battery life while preventing catastrophic events.
            </p>
            <p className="text-body text-ink-2">
              From extreme heat (60°C) in hot climates to cold-weather battery performance in European winters, NuraVolt integrates with all major BMS via Modbus, CAN bus, and proprietary protocols, providing real-time SoH estimation, multi-timescale fault detection, and warranty-grade evidence.
            </p>
          </motion.div>

          {/* Critical issues, calm card, asset accent */}
          <motion.div
            className="mt-10 rounded-sm border border-divider bg-paper-2 p-8"
            initial={{ opacity: 0, y: 12 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }}
            transition={{ duration: 0.4, delay: 0.1 }}
          >
            <h3 className="text-h2 font-semibold text-ink mb-5 flex items-center">
              <AlertTriangle className="w-5 h-5 text-asset-bess mr-2" />
              Critical issues we solve
            </h3>
            <div className="grid md:grid-cols-2 gap-4">
              {[
                ['Undetected Capacity Degradation', 'Gradual battery capacity fade going unnoticed until warranty thresholds are exceeded.'],
                ['Thermal Runaway Risks', 'Cell-level thermal anomalies in challenging climates that can lead to catastrophic failures.'],
                ['Suboptimal Charge/Discharge Cycles', 'Inefficient cycling strategies that accelerate degradation and reduce lifetime.'],
                ['Cell Imbalance Detection Delays', 'BMS alerts that come too late to prevent revenue-impacting failures.'],
                ['Lack of Predictive Maintenance', 'Reactive maintenance approaches leading to unplanned downtime and emergency replacements.'],
                ['Poor Round-Trip Efficiency', 'Energy losses during charge/discharge cycles reducing project economics.'],
                ['Warranty Claim Uncertainty', 'Insufficient data to support manufacturer warranty claims for underperforming batteries.'],
                ['Complex Multi-Chemistry Management', 'Difficulty optimising operations across different battery technologies (Li-ion, flow, hybrid).'],
              ].map(([title, body]) => (
                <div key={title} className="flex items-start gap-3">
                  <div className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-asset-bess" />
                  <p className="text-sm text-ink-2"><strong className="text-ink">{title}:</strong> {body}</p>
                </div>
              ))}
            </div>
          </motion.div>
        </div>
      </MarketingSection>

      {/* Battery Analytics Section, landing component, already on-brand */}
      <BatteryAnalyticsSection />

      <HairlineRule />

      {/* Features Grid */}
      <MarketingSection id="features" size="default" surface="paper-2">
        <div className="text-center mb-12">
          <div className="font-mono text-meta uppercase tracking-[0.08em] text-ink-3 mb-3">
            Capabilities
          </div>
          <h2 className="text-h1 font-semibold text-ink mb-3">
            Advanced BESS monitoring capabilities
          </h2>
          <p className="text-body text-ink-2 max-w-3xl mx-auto">
            Comprehensive battery analytics across utility-scale, commercial, and hybrid PV+storage installations globally.
          </p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {features.map((feature, index) => (
            <motion.div
              key={index}
              className="bg-paper rounded border border-divider p-6 hover:border-ink-3/40 transition-colors"
              initial={{ opacity: 0, y: 12 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true }}
              transition={{ delay: index * 0.05 }}
            >
              <div className="flex items-center mb-4">
                <div className="p-3 bg-violet-50 rounded">
                  <feature.icon className="w-5 h-5 text-asset-bess" />
                </div>
              </div>
              <h3 className="text-lg font-semibold text-ink mb-2">{feature.title}</h3>
              <p className="text-ink-2 mb-3 text-sm leading-relaxed">{feature.description}</p>
              <div className="flex items-center text-sm text-signal-positive font-medium">
                <CheckCircle className="w-4 h-4 mr-2" />
                {feature.benefit}
              </div>
            </motion.div>
          ))}
        </div>
      </MarketingSection>

      {/* BESS Types */}
      <MarketingSection size="default">
        <div className="text-center mb-12">
          <div className="font-mono text-meta uppercase tracking-[0.08em] text-ink-3 mb-3">
            Chemistries
          </div>
          <h2 className="text-h1 font-semibold text-ink mb-3">
            Supported battery technologies
          </h2>
          <p className="text-body text-ink-2 max-w-3xl mx-auto">
            All major battery chemistries and configurations across utility-scale, commercial, and hybrid systems.
          </p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
          {bessTypes.map((type, index) => (
            <motion.div
              key={index}
              className="rounded-sm border border-divider bg-paper p-6 text-center"
              initial={{ opacity: 0, scale: 0.95 }}
              whileInView={{ opacity: 1, scale: 1 }}
              viewport={{ once: true }}
              transition={{ delay: index * 0.05 }}
            >
              <div className="inline-flex p-3 rounded bg-violet-50 mb-4">
                <type.icon className="w-5 h-5 text-asset-bess" />
              </div>
              <h3 className="text-base font-semibold text-ink mb-1">{type.title}</h3>
              <p className="text-ink-2 text-sm">{type.description}</p>
            </motion.div>
          ))}
        </div>
      </MarketingSection>

      {/* ML Features */}
      <MarketingSection size="default" surface="paper-2">
        <div className="text-center mb-12">
          <div className="font-mono text-meta uppercase tracking-[0.08em] text-ink-3 mb-3">
            ML stack
          </div>
          <h2 className="text-h1 font-semibold text-ink mb-3">
            AI/ML features that add value over classic monitoring
          </h2>
          <p className="text-body text-ink-2 max-w-3xl mx-auto">
            Physics-informed ML catches the issues traditional BMS monitoring misses.
          </p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          {mlFeatures.map((feature, index) => (
            <motion.div
              key={index}
              className="rounded-sm border border-divider bg-paper p-6"
              initial={{ opacity: 0, x: index % 2 === 0 ? -10 : 10 }}
              whileInView={{ opacity: 1, x: 0 }}
              viewport={{ once: true }}
              transition={{ delay: index * 0.05 }}
            >
              <div className="flex items-start justify-between mb-3">
                <div className="p-2.5 bg-violet-50 rounded">
                  <feature.icon className="w-5 h-5 text-asset-bess" />
                </div>
                <span className="font-mono text-meta uppercase tracking-[0.08em] text-ink-3">
                  {feature.metric}
                </span>
              </div>
              <h3 className="text-lg font-semibold text-ink mb-2">{feature.title}</h3>
              <p className="text-ink-2 text-sm leading-relaxed">{feature.description}</p>
            </motion.div>
          ))}
        </div>
      </MarketingSection>

      {/* Market, paper rhythm with KPIReadouts */}
      <MarketingSection size="default">
        <div className="max-w-5xl">
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-10 items-start">
            <div className="lg:col-span-7">
              <div className="font-mono text-meta uppercase tracking-[0.08em] text-ink-3 mb-3">
                Why now
              </div>
              <h2 className="text-h1 font-semibold text-ink mb-5 flex items-center gap-3">
                <Battery className="w-7 h-7 text-asset-bess" />
                Built for global energy-storage expansion
              </h2>
              <p className="text-body text-ink-2 mb-4">
                Energy storage deployment is accelerating across UAE/GCC, Europe, and Africa. The UAE and Saudi Arabia are targeting 50+ GWh by 2030; Europe is rapidly expanding grid-scale storage to support renewable integration; Africa's off-grid and microgrid markets are growing exponentially.
              </p>
              <p className="text-body text-ink-2">
                Our integrated PV + Battery analytics platform adapts to diverse operational environments, extreme heat in hot climates, cold-weather battery performance in Europe, hybrid solar+storage. Pre-trained models enable production-ready monitoring across hundreds of installations.
              </p>
            </div>
            <div className="lg:col-span-5 border-t border-divider">
              <div className="py-5 border-b border-divider">
                <KPIReadout value="50+ GWh" label="UAE/GCC 2030 target" size="lg" />
              </div>
              <div className="py-5 border-b border-divider">
                <KPIReadout value="200+ GWh" label="Europe grid storage" size="lg" />
              </div>
              <div className="py-5">
                <KPIReadout value="−20 to +60°C" label="Operating range across the fleet" size="lg" />
              </div>
            </div>
          </div>
        </div>
      </MarketingSection>

      {/* Resource CTA Section */}
      <MarketingSection size="compact">
        <ResourceCTA
          title="Download: Battery Energy Storage Reliability - Monitoring Best Practices"
          description="Free 6-page safety-first guide covering thermal runaway detection, performance KPIs, and warranty compliance strategies for BESS operations."
          resourceSlug="bess-thermal-runaway"
          variant="banner"
        />
        <div className="mt-8">
          <ResourceCTA
            title="Free Checklist: BESS Performance Health Checklist"
            description="Monitor SOC drift, temperature gradients, voltage deviation, and cycle aging for maximum reliability"
            resourceSlug="bess-checklist"
            variant="card"
          />
        </div>
      </MarketingSection>

      <SolutionCTA
        eyebrow="Pilot one site, prove the value"
        heading="Optimize your battery storage operations."
        sub="Start with a customised pilot. We integrate with your BMS, prove the value on your actual battery data, and provide custom ROI projections within two weeks of getting access."
        primary={{ label: 'Start continuous monitoring', intent: 'monitoring' }}
        secondary={{ label: 'Explore PV Monitoring →', href: '/solutions/pv-monitoring' }}
      />
    </div>
  );
}
