'use client';

import { motion } from 'framer-motion';
import {
  Wind,
  TrendingUp,
  Settings,
  AlertTriangle,
  Activity,
  Gauge,
  Zap,
  CheckCircle,
  BarChart3,
  ThermometerSun,
  Waves,
  Target,
  Bell,
} from 'lucide-react';
import SolutionHero from '@/components/solutions/SolutionHero';
import SolutionCTA from '@/components/solutions/SolutionCTA';
import { MarketingSection } from '@/components/ui/MarketingSection';
import { KPIReadout } from '@/components/ui/KPIReadout';
import { HairlineRule } from '@/components/ui/HairlineRule';

export default function WindMonitoringPage() {

  const features = [
    {
      icon: TrendingUp,
      title: 'Power Curve Analysis',
      description: 'Compare actual power output against OEM curves with air density correction. IEC 61400-12-1 compliant bin method analysis quantifies underperformance and estimates AEP losses.',
      benefit: 'Analog to PV Performance Ratio'
    },
    {
      icon: Settings,
      title: 'Gearbox Predictive Maintenance',
      description: 'Normal Behavior Modeling (NBM) trains on healthy SCADA data to predict expected temperatures. Large residuals between predicted and actual indicate developing faults 3-12 months in advance.',
      benefit: 'Catch failures before $200K+ repairs'
    },
    {
      icon: Waves,
      title: 'Wake Effect Modeling',
      description: 'Jensen/Park analytical model with wake superposition. Calculate farm-level power accounting for upstream turbine wakes. Direction sweep analysis reveals optimal operating conditions.',
      benefit: 'Recover 1-3% farm output'
    },
    {
      icon: AlertTriangle,
      title: 'Anomaly Detection',
      description: 'Isolation Forest unsupervised detection identifies operating points that deviate from expected power curve behavior. Pinpoints curtailment, icing, yaw misalignment, and degradation.',
      benefit: 'Distinguish fault types automatically'
    },
    {
      icon: ThermometerSun,
      title: 'Drivetrain Health Monitoring',
      description: 'Multi-component monitoring: gearbox bearing temperature, oil temperature, generator bearings (drive-end and non-drive-end). Trend analysis estimates remaining useful life.',
      benefit: 'Full drivetrain visibility'
    },
    {
      icon: Gauge,
      title: 'SCADA Integration',
      description: 'Connects to existing turbine SCADA systems. Uses standard signals: wind speed, power, rotor speed, pitch angle, nacelle temperature. No additional sensors required.',
      benefit: 'Works with your existing data'
    },
    {
      icon: Bell,
      title: 'Multi-Channel Alerts & Automated Reports',
      description: 'Configurable notifications via SMS, Email, Teams, Google Chat, and WhatsApp. Scheduled KPI reports with turbine health summaries. Emergency curtailment commands on critical events.',
      benefit: 'Alerts and reports wherever your team works'
    }
  ];

  const turbineTypes = [
    {
      title: 'Onshore Wind',
      description: 'Utility-scale and community wind farms',
      icon: Wind,
      color: 'blue'
    },
    {
      title: 'Offshore Wind',
      description: 'Higher capacity factors, wake optimization',
      icon: Waves,
      color: 'blue'
    },
    {
      title: 'Hybrid Wind+Storage',
      description: 'Integrated dispatch optimization',
      icon: Zap,
      color: 'blue'
    },
    {
      title: 'Multi-Turbine Farms',
      description: 'Farm-level analytics and optimization',
      icon: BarChart3,
      color: 'blue'
    }
  ];

  const mlFeatures = [
    {
      title: 'Power Curve Efficiency',
      description: 'Calculate efficiency (actual/expected) for every 10-minute interval. Bin method creates reference curve from clean data. Detect underperformance with statistical confidence.',
      metric: 'IEC 61400-12-1 compliant',
      icon: TrendingUp
    },
    {
      title: 'Normal Behavior Modeling',
      description: 'LightGBM models trained on healthy operation predict expected temperatures. Z-score monitoring detects anomalies. Multi-component tracking for gearbox and generator bearings.',
      metric: '3-12 months advance warning',
      icon: Settings
    },
    {
      title: 'Wake-Aware Forecasting',
      description: 'Jensen wake model with linear expansion. Sum-of-squares wake superposition for multiple upwind turbines. Direction-dependent wake loss estimation for farm power forecasting.',
      metric: '10-20% wake loss quantification',
      icon: Waves
    },
    {
      title: 'RUL Estimation',
      description: 'Trend analysis on temperature residuals estimates remaining useful life. Linear regression on daily residual means projects days to failure threshold.',
      metric: 'Months of planning time',
      icon: Target
    }
  ];

  return (
    <div className="min-h-screen bg-paper">
      <SolutionHero
        asset="wind"
        eyebrow="Wind monitoring · audit · data foundation"
        headline="Predict gearbox failures, quantify wake losses, and recover yield, on your turbine SCADA."
        highlight="Or get a one-off Wind Performance Audit."
        sub="Normal Behavior Modelling on your existing SCADA, temperature, power, wind speed. We flag developing drivetrain faults 3-12 months out, quantify wake losses on the farm map, and price recovery turbine by turbine."
        stats={[
          { value: '3-12 mo', label: 'Drivetrain advance warning' },
          { value: '10-20%', label: 'Typical wake-loss recovery' },
          { value: '€200K+', label: 'Per avoided gearbox failure' },
        ]}
        primaryCta={{ label: 'Start continuous monitoring', intent: 'monitoring' }}
        secondaryCta={{ label: 'Or get a one-off audit', intent: 'audit' }}
        screenshot={{
          src: '/images/screenshots/wind-fleet.png',
          alt: 'NuraVolt Wind Intelligence dashboard, turbine fleet view with power curve deviations and drivetrain RUL',
          panelHeader: 'CARE-PORTUGAL · 10MW · WIND',
          panelMeta: 'nuravolt.com/plant/care-portugal',
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
              Physics-informed wind turbine analytics.
            </h2>
            <p className="text-body text-ink-2 mb-4">
              NuraVolt's wind analytics platform brings the same physics-informed ML approach proven on PV to wind energy. Analysing your existing SCADA, we detect gearbox and bearing failures 3-12 months before they occur, saving €200K,500K per avoided failure. Power-curve analysis quantifies underperformance with IEC-compliant methods, and wake modelling optimises farm-level output.
            </p>
            <p className="text-body text-ink-2">
              Built on Normal Behavior Modelling: the platform learns what "healthy" operation looks like for each turbine, then flags deviations that indicate developing faults. No additional sensors required, temperature, power, and wind-speed data you already collect.
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
              <AlertTriangle className="w-5 h-5 text-asset-wind mr-2" />
              Critical issues we solve
            </h3>
            <div className="grid md:grid-cols-2 gap-4">
              {[
                ['Unplanned Gearbox Failures', '€200K,500K repair costs plus weeks of downtime that early detection prevents.'],
                ['Hidden Underperformance', 'Power-curve degradation from blade erosion, yaw misalignment, or pitch errors going undetected.'],
                ['Unquantified Wake Losses', '10-20% of potential output lost to wake interactions without visibility.'],
                ['Reactive Maintenance', 'Fixing failures after they happen instead of preventing them proactively.'],
                ['Bearing Failures', 'Generator and main-bearing failures that escalate to major component damage.'],
                ['Curtailment Confusion', 'Difficulty distinguishing grid curtailment from actual performance issues.'],
                ['Farm-Level Blind Spots', 'Per-turbine monitoring missing aggregate patterns and optimisation opportunities.'],
                ['OEM Data Lock-In', 'Limited access to analytics beyond what turbine manufacturers provide.'],
              ].map(([title, body]) => (
                <div key={title} className="flex items-start gap-3">
                  <div className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-asset-wind" />
                  <p className="text-sm text-ink-2"><strong className="text-ink">{title}:</strong> {body}</p>
                </div>
              ))}
            </div>
          </motion.div>
        </div>
      </MarketingSection>

      <HairlineRule />

      {/* Features Grid */}
      <MarketingSection id="features" size="default" surface="paper-2">
        <div className="text-center mb-12">
          <div className="font-mono text-meta uppercase tracking-[0.08em] text-ink-3 mb-3">
            Capabilities
          </div>
          <h2 className="text-h1 font-semibold text-ink mb-3">
            Advanced wind monitoring capabilities
          </h2>
          <p className="text-body text-ink-2 max-w-3xl mx-auto">
            Comprehensive analytics for onshore and offshore wind farms, built on physics-informed ML.
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
                <div className="p-3 bg-cyan-50 rounded">
                  <feature.icon className="w-5 h-5 text-asset-wind" />
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

      {/* Turbine Types */}
      <MarketingSection size="default">
        <div className="text-center mb-12">
          <div className="font-mono text-meta uppercase tracking-[0.08em] text-ink-3 mb-3">
            Configurations
          </div>
          <h2 className="text-h1 font-semibold text-ink mb-3">
            Supported wind configurations
          </h2>
          <p className="text-body text-ink-2 max-w-3xl mx-auto">
            From single turbines to utility-scale farms, onshore and offshore.
          </p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
          {turbineTypes.map((type, index) => (
            <motion.div
              key={index}
              className="rounded-sm border border-divider bg-paper p-6 text-center"
              initial={{ opacity: 0, scale: 0.95 }}
              whileInView={{ opacity: 1, scale: 1 }}
              viewport={{ once: true }}
              transition={{ delay: index * 0.05 }}
            >
              <div className="inline-flex p-3 rounded bg-cyan-50 mb-4">
                <type.icon className="w-5 h-5 text-asset-wind" />
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
            AI/ML features that add value
          </h2>
          <p className="text-body text-ink-2 max-w-3xl mx-auto">
            Physics-informed models catch the issues that standard SCADA alarms miss.
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
                <div className="p-2.5 bg-cyan-50 rounded">
                  <feature.icon className="w-5 h-5 text-asset-wind" />
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

      {/* Wind market, KPIs on hairline-bounded panel matching the about page */}
      <MarketingSection size="default">
        <div className="max-w-5xl">
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-10 items-start">
            <div className="lg:col-span-7">
              <div className="font-mono text-meta uppercase tracking-[0.08em] text-ink-3 mb-3">
                Why now
              </div>
              <h2 className="text-h1 font-semibold text-ink mb-5 flex items-center gap-3">
                <Wind className="w-7 h-7 text-asset-wind" />
                Built for the growing wind market
              </h2>
              <p className="text-body text-ink-2 mb-4">
                Global wind capacity is growing rapidly, with offshore wind especially expanding in Europe, Asia, and emerging markets. As turbines get larger and more complex, predictive maintenance becomes essential to avoid catastrophic failures.
              </p>
              <p className="text-body text-ink-2">
                Our SCADA-based approach requires no additional hardware investment. By learning normal behaviour patterns per turbine, we detect the subtle temperature anomalies that precede gearbox and bearing failures, months of lead time for maintenance planning.
              </p>
            </div>
            <div className="lg:col-span-5 border-t border-divider">
              <div className="py-5 border-b border-divider">
                <KPIReadout value="67%" label="Failure detection rate" size="lg" />
              </div>
              <div className="py-5 border-b border-divider">
                <KPIReadout value="3-12 mo" label="Advance warning on drivetrain faults" size="lg" />
              </div>
              <div className="py-5">
                <KPIReadout value="€200K+" label="Avoided per gearbox failure" size="lg" />
              </div>
            </div>
          </div>
        </div>
      </MarketingSection>

      <SolutionCTA
        eyebrow="Pilot one farm, prove the value"
        heading="Optimize your wind operations."
        sub="Start with a pilot on a few turbines. We integrate with your SCADA, prove the value with your actual data, and provide ROI projections for farm-wide deployment."
        primary={{ label: 'Start continuous monitoring', intent: 'monitoring' }}
        secondary={{ label: 'Explore PV Monitoring →', href: '/solutions/pv-monitoring' }}
      />
    </div>
  );
}
