'use client';

import { motion } from 'framer-motion';
import {
  Clock,
  Database,
  Activity,
  AlertTriangle,
  CheckCircle,
  BarChart3,
  Sun,
  Cloud,
  Bell,
  Bot,
  Power,
  Server,
} from 'lucide-react';
import SolutionSection from '@/components/landing/SolutionSection';
import TransformationSection from '@/components/landing/TransformationSection';
import ROISection from '@/components/landing/ROISection';
import HowItWorksSection from '@/components/landing/HowItWorksSection';
import ResourceCTA from '@/components/resources/ResourceCTA';
import SolutionHero from '@/components/solutions/SolutionHero';
import SolutionCTA from '@/components/solutions/SolutionCTA';
import { MarketingSection } from '@/components/ui/MarketingSection';

export default function PVMonitoringPage() {

  const features = [
    {
      icon: Activity,
      title: 'Real-Time Performance Monitoring',
      description: 'Track power output, efficiency, and performance ratios in real-time with 1-15 minute granularity.',
      benefit: 'Identify issues within minutes, not hours'
    },
    {
      icon: AlertTriangle,
      title: 'Predictive Fault Detection',
      description: 'Physics-informed ML models predict inverter failures and string outages days to weeks before they impact revenue by analyzing patterns in your existing SCADA data.',
      benefit: 'Catch failures before revenue impact'
    },
    {
      icon: Sun,
      title: 'Climate-Adaptive Algorithms',
      description: 'Models calibrated for diverse conditions: soiling and extreme heat (60°C) in hot climates, vegetation growth and cloud variability in temperate regions, seasonal irradiance changes across latitudes.',
      benefit: '40% more accurate than generic algorithms'
    },
    {
      icon: Database,
      title: 'Works With or Without SCADA',
      description: 'Have SCADA? We integrate via Modbus TCP/RTU, OPC UA, or MQTT in 2-3 weeks. No SCADA? We connect directly to your inverter cloud portal (Huawei, SMA, Sungrow, Fronius, SolarEdge, Enphase, Oxel). No hardware changes required either way.',
      benefit: 'Integrated in 2-3 weeks, zero disruption'
    },
    {
      icon: Cloud,
      title: 'Soiling Intelligence & Cleaning Schedule Optimization',
      description: 'Physics-informed models track soiling accumulation rates specific to your location and season. Optimize cleaning schedules by balancing energy loss against water, labor, and equipment costs. Distinguish soiling losses from equipment faults, preventing false alarms and wasted investigations. Reduce cleaning costs by 30-40% while maintaining optimal performance.',
      benefit: 'Optimize cleaning ROI, reduce water consumption, catch real faults'
    },
    {
      icon: Clock,
      title: 'Pre-trained Models for Rapid Deployment',
      description: 'Our ML models are pre-trained on diverse installations across similar climates and configurations. Get production-ready fault detection in 3-6 months instead of the traditional 12+ month cold-start period required by conventional systems.',
      benefit: 'Predictions in months, not years'
    },
    {
      icon: BarChart3,
      title: 'Comprehensive Analytics Dashboard',
      description: 'Customizable dashboards with KPIs that matter to your operations team and executive reporting.',
      benefit: 'Data-driven O&M decisions'
    },
    {
      icon: Bell,
      title: 'Multi-Channel Alert Routing',
      description: 'Configurable notifications via SMS, Email, Microsoft Teams, Google Chat, and WhatsApp. Set per-user alert preferences, severity filters, and escalation rules.',
      benefit: 'Alerts wherever your team works'
    },
    {
      icon: Bot,
      title: 'AI-Powered O&M Assistant',
      description: 'LLM-based agent that interprets anomaly alerts in plain language, explains root causes, and recommends specific corrective actions with urgency levels.',
      benefit: 'Actionable advice from every alert'
    },
    {
      icon: Power,
      title: 'Emergency Control Actions',
      description: 'Configure automatic shutdown or isolation commands for critical events like overheating or arc faults. Integration with inverter control APIs and SCADA systems ensures rapid response.',
      benefit: 'Millisecond response to critical faults'
    },
    {
      icon: Server,
      title: 'Cloud or On-Premise Deployment',
      description: 'Deploy in our managed cloud, your private cloud (AWS, Azure, GCP), or fully on-premise behind your firewall. Same platform, same features, your choice of infrastructure.',
      benefit: 'Meet any security or regulatory requirement'
    }
  ];

  const integrations = [
    { name: 'Modbus TCP/RTU', type: 'SCADA Protocol' },
    { name: 'OPC UA', type: 'SCADA Protocol' },
    { name: 'REST APIs', type: 'SCADA Protocol' },
    { name: 'MQTT', type: 'SCADA Protocol' },
    { name: 'Huawei FusionSolar', type: 'Inverter Cloud API' },
    { name: 'SMA Sunny Portal', type: 'Inverter Cloud API' },
    { name: 'Sungrow iSolarCloud', type: 'Inverter Cloud API' },
    { name: 'Fronius Solar.web', type: 'Inverter Cloud API' },
    { name: 'SolarEdge', type: 'Inverter Cloud API' },
    { name: 'Enphase', type: 'Inverter Cloud API' },
    { name: 'Oxel', type: 'Inverter Cloud API' },
    { name: 'Other brands', type: 'On request' }
  ];

  return (
    <div className="min-h-screen bg-paper">
      <SolutionHero
        asset="solar"
        eyebrow="PV monitoring · audit · data foundation"
        headline="Continuous soiling, fault detection, and €/day loss tracking, on your live PV data."
        highlight="Or get a one-off Plant Performance Audit."
        sub="Plug NuraVolt into your inverters, SCADA, or CSV exports. 365-day soiling forecasts, predictive fault detection, ROI-priced cleaning, every day. Calibrated for the climates you actually operate in."
        stats={[
          { value: 'Daily', label: 'Soiling ratio + fault sweep' },
          { value: '3-8%', label: 'Annual revenue typically recoverable' },
          { value: '€/day', label: 'Loss quantified per fault' },
        ]}
        primaryCta={{ label: 'Start continuous monitoring', intent: 'monitoring' }}
        secondaryCta={{ label: 'Or get a one-off audit', intent: 'audit' }}
        screenshot={{
          src: '/images/screenshots/soiling-intelligence.png',
          alt: 'NuraVolt PV Intelligence dashboard, Helios, soiling ratio 96.0% with 30-day ML forecast and cleaning optimisation',
          panelHeader: 'HELIOS · 30MW · SPAIN',
          panelMeta: 'nuravolt.com/plant/helios',
        }}
      />

      {/* Professional Introduction Section */}
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
                PV performance monitoring, calibrated to your climate.
              </h2>
              <p className="text-body text-ink-2 mb-4">
                NuraVolt's PV monitoring platform combines physics-informed machine learning with climate-adaptive algorithms to deliver real visibility into your solar operations. We integrate with your existing SCADA or connect directly to inverter cloud portals (Huawei, SMA, Sungrow, and more), predictive fault detection, soiling intelligence, and actionable insights whether you have a full SCADA system or just an inverter portal.
              </p>
              <p className="text-body text-ink-2">
                Calibrated for the environments you actually operate in: extreme heat and soiling in arid climates, vegetation growth and cloud variability in temperate regions, seasonal irradiance shifts across latitudes.
              </p>
            </motion.div>

            {/* Issues We Help Solve */}
            <motion.div
              className="mt-12 rounded-sm border border-divider bg-paper-2 p-8"
              initial={{ opacity: 0, y: 20 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true }}
              transition={{ duration: 0.8, delay: 0.2 }}
            >
              <h3 className="text-h2 font-semibold text-ink mb-5 flex items-center">
                <AlertTriangle className="w-5 h-5 text-asset-solar mr-2" />
                Critical Issues We Solve
              </h3>
              <div className="grid md:grid-cols-2 gap-4">
                <div className="flex items-start space-x-3">
                  <div className="flex-shrink-0 w-2 h-2 bg-primary rounded-full mt-2"></div>
                  <p className="text-ink"><strong>Undetected Performance Degradation:</strong> Slow capacity loss going unnoticed until significant revenue impact</p>
                </div>
                <div className="flex items-start space-x-3">
                  <div className="flex-shrink-0 w-2 h-2 bg-primary rounded-full mt-2"></div>
                  <p className="text-ink"><strong>Late Fault Detection:</strong> Inverter and module failures discovered weeks after they begin affecting output</p>
                </div>
                <div className="flex items-start space-x-3">
                  <div className="flex-shrink-0 w-2 h-2 bg-primary rounded-full mt-2"></div>
                  <p className="text-ink"><strong>Suboptimal Cleaning Schedules:</strong> Over-cleaning (wasting water/labor) or under-cleaning (losing energy)</p>
                </div>
                <div className="flex items-start space-x-3">
                  <div className="flex-shrink-0 w-2 h-2 bg-primary rounded-full mt-2"></div>
                  <p className="text-ink"><strong>Non-Adaptive Algorithms:</strong> One-size-fits-all systems failing to account for regional climate differences</p>
                </div>
                <div className="flex items-start space-x-3">
                  <div className="flex-shrink-0 w-2 h-2 bg-primary rounded-full mt-2"></div>
                  <p className="text-ink"><strong>Poor Data Quality:</strong> Inaccurate irradiation sensors leading to false alarms and wasted investigations</p>
                </div>
                <div className="flex items-start space-x-3">
                  <div className="flex-shrink-0 w-2 h-2 bg-primary rounded-full mt-2"></div>
                  <p className="text-ink"><strong>Reactive Maintenance:</strong> Fixing problems after failure instead of preventing them proactively</p>
                </div>
                <div className="flex items-start space-x-3">
                  <div className="flex-shrink-0 w-2 h-2 bg-primary rounded-full mt-2"></div>
                  <p className="text-ink"><strong>Manual Performance Analysis:</strong> Operations teams drowning in data without actionable insights</p>
                </div>
                <div className="flex items-start space-x-3">
                  <div className="flex-shrink-0 w-2 h-2 bg-primary rounded-full mt-2"></div>
                  <p className="text-ink"><strong>Contractor SLA Disputes:</strong> No objective data to validate O&M performance guarantees</p>
                </div>
              </div>
            </motion.div>

            {/* Practical ML Detection Section */}
            <motion.div
              className="mt-12 rounded-sm border border-divider bg-paper-2 p-8"
              initial={{ opacity: 0, y: 20 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true }}
              transition={{ duration: 0.8, delay: 0.3 }}
            >
              <h3 className="text-h2 font-semibold text-ink mb-5 flex items-center">
                <CheckCircle className="w-5 h-5 text-asset-solar mr-2" />
                What Our ML Models Actually Detect
              </h3>
              <p className="text-ink-2 mb-6">
                Our physics-informed ML models detect the faults responsible for 80% of revenue losses using standard monitoring equipment you already have,no expensive hardware additions required.
              </p>
              <div className="grid md:grid-cols-2 gap-4 mb-6">
                <div className="flex items-start space-x-3">
                  <div className="flex-shrink-0 w-2 h-2 bg-primary rounded-full mt-2"></div>
                  <p className="text-ink"><strong>Inverter Failures</strong> (30% of all faults), Detectable days in advance with standard SCADA data</p>
                </div>
                <div className="flex items-start space-x-3">
                  <div className="flex-shrink-0 w-2 h-2 bg-primary rounded-full mt-2"></div>
                  <p className="text-ink"><strong>String Outages</strong> (0.9% power loss), Identifiable with string-level monitoring</p>
                </div>
                <div className="flex items-start space-x-3">
                  <div className="flex-shrink-0 w-2 h-2 bg-primary rounded-full mt-2"></div>
                  <p className="text-ink"><strong>Module Degradation</strong>, Tracked through performance ratio trending and pattern analysis</p>
                </div>
                <div className="flex items-start space-x-3">
                  <div className="flex-shrink-0 w-2 h-2 bg-primary rounded-full mt-2"></div>
                  <p className="text-ink"><strong>Ground Faults</strong>, Caught through isolation resistance monitoring</p>
                </div>
                <div className="flex items-start space-x-3">
                  <div className="flex-shrink-0 w-2 h-2 bg-primary rounded-full mt-2"></div>
                  <p className="text-ink"><strong>Soiling Intelligence & Cleaning Optimization</strong>, Advanced physics models detect soiling accumulation, optimize cleaning schedules based on performance impact vs. cost, and distinguish dust losses from equipment faults. Reduces water consumption while maximizing energy yield.</p>
                </div>
                <div className="flex items-start space-x-3">
                  <div className="flex-shrink-0 w-2 h-2 bg-yellow-600 rounded-full mt-2"></div>
                  <p className="text-ink"><strong>Arc Faults</strong>, Requires specialized 10-100 kHz hardware (optional add-on, recommended when economically justified)</p>
                </div>
              </div>
              <p className="text-ink-2 text-sm italic">
                We're transparent about capabilities and costs. We'll only recommend additional hardware when the ROI clearly justifies the investment.
              </p>
            </motion.div>
          </div>
      </MarketingSection>

      {/* Solution Section - Why choose us */}
      <SolutionSection />

      {/* Features Grid */}
      <MarketingSection id="features" size="default" surface="paper-2">
          <div className="text-center mb-16">
            <div className="font-mono text-meta uppercase tracking-[0.08em] text-ink-3 mb-3">
              Capabilities
            </div>
            <h2 className="text-h1 font-semibold text-ink mb-3">
              Advanced PV monitoring capabilities
            </h2>
            <p className="text-body text-ink-2 max-w-3xl mx-auto">
              Comprehensive monitoring and analytics platform calibrated to your climate.
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
                  <div className="p-3 bg-blue-50 rounded">
                    <feature.icon className="w-5 h-5 text-asset-solar" />
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

      {/* Transformation Section - What changes after implementation */}
      <TransformationSection />

      {/* ROI Section - Financial benefits */}
      <ROISection />

      {/* How It Works Section - Implementation process */}
      <HowItWorksSection />

      {/* Integration Section */}
      <MarketingSection size="default" surface="paper-2">
          <div className="text-center mb-12">
            <div className="font-mono text-meta uppercase tracking-[0.08em] text-ink-3 mb-3">
              Integrations
            </div>
            <h2 className="text-h1 font-semibold text-ink mb-3">
              Connects to what you already run
            </h2>
            <p className="text-body text-ink-2 max-w-3xl mx-auto">
              Via SCADA, or directly through your inverter cloud portal. No SCADA required. Typical integration: 2-3 weeks.
            </p>
          </div>

          <div className="max-w-4xl mx-auto">
            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-5 gap-3">
              {integrations.map((integration, index) => (
                <motion.div
                  key={index}
                  className="bg-paper rounded border border-divider p-3 text-center"
                  initial={{ opacity: 0, scale: 0.95 }}
                  whileInView={{ opacity: 1, scale: 1 }}
                  viewport={{ once: true }}
                  transition={{ delay: index * 0.03 }}
                >
                  <div className="text-sm font-semibold text-ink mb-1">{integration.name}</div>
                  <div className="text-[11px] uppercase tracking-wide text-ink-3">{integration.type}</div>
                </motion.div>
              ))}
            </div>
          </div>
      </MarketingSection>

      {/* Resource CTA Section */}
      <MarketingSection size="compact">
          <ResourceCTA
            title="Download: Irradiation Data Quality - Validation Methods for Reliable Operations"
            description="Free 5-page technical guide on sensor calibration, validation techniques, and data quality best practices for diverse climate conditions."
            resourceSlug="irradiation-data-quality"
            variant="banner"
          />
          <div className="mt-8">
            <ResourceCTA
              title="Free Checklist: 7 Hidden Causes of Inverter Underperformance"
              description="Diagnostic checklist for phase imbalance, DC mismatch, and MPPT errors"
              resourceSlug="inverter-checklist"
              variant="card"
            />
          </div>
      </MarketingSection>

      <SolutionCTA
        eyebrow="Start with your live data"
        heading="Continuous monitoring, a one-off audit, or a Data Foundation engagement."
        sub="Pick the path that fits your plant. We'll integrate, surface findings, and price recovery in your data, usually within two weeks of getting access."
        primary={{ label: 'Start continuous monitoring', intent: 'monitoring' }}
        secondary={{ label: 'Explore Battery Monitoring →', href: '/solutions/bess-monitoring' }}
      />
    </div>
  );
}
