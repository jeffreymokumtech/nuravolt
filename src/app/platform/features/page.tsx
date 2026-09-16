'use client';

import { useRef } from 'react';
import { motion, useInView } from 'framer-motion';
import { Button } from '@/components/ui/button';
import Link from 'next/link';
import { ArrowRight } from 'lucide-react';
import { MarketingSection } from '@/components/ui/MarketingSection';
import { HairlineRule } from '@/components/ui/HairlineRule';
import {
  Activity,
  AlertTriangle,
  BarChart3,
  BatteryCharging,
  Bell,
  Bot,
  Cloud,
  Cpu,
  Database,
  FileCheck,
  FileText,
  GitBranch,
  LayoutDashboard,
  LineChart,
  Lock,
  Scale,
  Shield,
  Ticket,
  TrendingUp,
  Zap,
} from 'lucide-react';

const featureGroups = [
  {
    title: 'Performance & Digital Twin',
    description:
      'Every inverter, MPPT, and string has a live physics-ML model that predicts what it should be producing right now. Residuals become alerts.',
    accent: 'blue',
    items: [
      {
        icon: Activity,
        title: 'Live Performance Monitoring',
        description:
          '1-15 minute granularity across power, irradiance, temperature, availability, and performance ratio. Fleet and asset views.',
      },
      {
        icon: LineChart,
        title: 'Hybrid Physics-ML Digital Twin',
        description:
          'Per-inverter predicted-vs-measured for current, voltage, and power. Seasonal-aware. Calibrated against SCADA history.',
      },
      {
        icon: Zap,
        title: 'Loss Disaggregation',
        description:
          'Waterfall breakdown of reference → net energy: soiling, temperature, spectral, inverter, wiring, and degradation losses.',
      },
    ],
  },
  {
    title: 'Soiling Intelligence',
    description:
      'Soiling is not a single number. We track accumulation per array, predict future loss, and optimise cleaning windows against labour and water costs.',
    accent: 'amber',
    items: [
      {
        icon: Cloud,
        title: '365-Day Soiling Forecasts',
        description:
          'Site-specific forecasts driven by AOD, DustIQ (where present), transfer learning, and weather history.',
      },
      {
        icon: GitBranch,
        title: 'Cleaning Schedule Optimisation',
        description:
          'Given your cleaning cost, water cost, and tariff, we recommend a cleaning plan that maximises net energy recovered.',
      },
      {
        icon: AlertTriangle,
        title: 'Soiling vs Fault Separation',
        description:
          'Distinguish soiling losses from equipment faults so you stop dispatching techs to clean panels that are actually broken.',
      },
    ],
  },
  {
    title: 'Fault Detection & RUL',
    description:
      'Thermal, electrical, and structural signatures are tracked against baselines. Days-to-weeks lead time on the 80% of faults you care about.',
    accent: 'red',
    items: [
      {
        icon: Shield,
        title: 'Predictive Fault Detection',
        description:
          'Inverter failures, string outages, MPPT errors, ground faults, phase imbalance, surfaced before they impact revenue.',
      },
      {
        icon: Cpu,
        title: 'Thermal RUL',
        description:
          'Remaining-useful-life models on inverters and transformers. Schedule replacements before the failure, not after.',
      },
      {
        icon: Bot,
        title: 'AI O&M Assistant',
        description:
          'LLM-based agent that reads the alert, cross-references the data, and writes a diagnosis + recommended action in plain language.',
      },
    ],
  },
  {
    title: 'Operations & Workflow',
    description:
      'The platform turns alerts into tickets, tickets into validated work, and validated work into compliance-ready evidence.',
    accent: 'indigo',
    items: [
      {
        icon: Ticket,
        title: 'O&M Ticketing',
        description:
          'Alert → Validation → Assignment → In Progress → Done. Audit trail per plant. Severity routing. Contractor SLA tracking.',
      },
      {
        icon: Bell,
        title: 'Multi-Channel Alerts',
        description:
          'SMS, email, Microsoft Teams, Google Chat, WhatsApp. Per-user severity filters and escalation rules.',
      },
      {
        icon: FileText,
        title: 'Audit Trail & Validation',
        description:
          'Every state change, comment, and decision on a ticket is captured. Export on demand for regulator or lender queries.',
      },
    ],
  },
  {
    title: 'Reporting & Dashboards',
    description:
      'An interactive dashboard builder with scheduled PDF delivery and read-only share links. Compliance packs per country.',
    accent: 'emerald',
    items: [
      {
        icon: LayoutDashboard,
        title: 'Interactive Reporter',
        description:
          'Drag-and-drop widgets. Pick time range, plants, and components. Save, share, or schedule delivery.',
      },
      {
        icon: BarChart3,
        title: 'Portfolio & Financial Views',
        description:
          'Fleet-wide KPIs, revenue-at-risk, budget deviation, loss totals. Roll up or drill down.',
      },
      {
        icon: Shield,
        title: 'Compliance Packs',
        description:
          '8 country packs (ES, PT, IT, AE, SA, KE, NG, ZA) with grid codes, reporting obligations, metering policies, and inspection cadence.',
      },
    ],
  },
  {
    title: 'Compliance Intelligence',
    description:
      'The EU regulations that now shape every plant data stack, CSRD, AI Act, EU Battery Regulation, built in, not bolted on.',
    accent: 'indigo',
    items: [
      {
        icon: FileCheck,
        title: 'ESRS E1 data pack generator',
        description:
          'Auto-generates the plant-level ESRS E1-5 (energy) and E1-6 (GHG) data pack from your existing generation + availability telemetry. XBRL-tagged output your auditor can ingest directly.',
      },
      {
        icon: Scale,
        title: 'AI Act model cards per model',
        description:
          'Every forecasting, dispatch, or fault-detection model ships with an auto-generated model card: intended use, training data, accuracy metrics, known limitations, human-oversight points. Ready for Annex III critical-infrastructure classification.',
      },
      {
        icon: BatteryCharging,
        title: 'EU Battery Passport data feed',
        description:
          'Performance, degradation, and SoH history for every BESS \u2265 2 kWh, packaged in the format the EU Battery Regulation requires from Feb 2027.',
      },
      {
        icon: Lock,
        title: 'Tamper-evident fault attribution log',
        description:
          'Every LLM-generated fault explanation is hash-chained and signed. Court-admissible for insurance disputes, warranty claims, and lender reviews.',
      },
      {
        icon: TrendingUp,
        title: 'Revenue-weighted availability',
        description:
          'Instead of raw uptime %, report availability weighted by the hourly electricity price \u2014 downtime during a \u20ac200/MWh noon peak costs 10\u00d7 what it does at 2 AM.',
      },
    ],
  },
  {
    title: 'Data Foundation',
    description:
      'Batteries of connectors, a normalised data model, and a tiered storage strategy built for PV plants that run for 25 years.',
    accent: 'slate',
    items: [
      {
        icon: Database,
        title: 'Multi-Source Connectors',
        description:
          'Modbus RTU/TCP, OPC-UA, MQTT, Huawei FusionSolar, SMA, Sungrow, Fronius, SolarEdge, Enphase, InfluxDB, CSV uploads.',
      },
      {
        icon: GitBranch,
        title: 'Tiered Storage',
        description:
          'Hot path in TimescaleDB hypertables. Long-tail in Parquet + DuckDB. Continuous aggregates for dashboards.',
      },
      {
        icon: Shield,
        title: 'Cloud or On-Premise',
        description:
          'Managed cloud, your private cloud (AWS, Azure, GCP), or fully on-premise behind your firewall. Same features, your infrastructure.',
      },
    ],
  },
];

const accentClasses: Record<string, { bg: string; iconBg: string; iconText: string; border: string }> = {
  blue: { bg: 'bg-paper-2', iconBg: 'bg-paper-2', iconText: 'text-primary', border: 'border-divider' },
  amber: { bg: 'bg-signal-warning/5', iconBg: 'bg-amber-100', iconText: 'text-signal-warning', border: 'border-amber-100' },
  red: { bg: 'bg-signal-critical/5', iconBg: 'bg-red-100', iconText: 'text-signal-critical', border: 'border-signal-critical/40' },
  indigo: { bg: 'bg-blue-50', iconBg: 'bg-blue-100', iconText: 'text-primary', border: 'border-blue-200' },
  emerald: { bg: 'bg-signal-positive/5', iconBg: 'bg-signal-positive/10', iconText: 'text-signal-positive', border: 'border-signal-positive/20' },
  slate: { bg: 'bg-paper-2', iconBg: 'bg-paper-2', iconText: 'text-ink-2', border: 'border-divider' },
};

export default function PlatformFeaturesPage() {
  const heroRef = useRef(null);
  const heroInView = useInView(heroRef, { once: true });

  return (
    <div className="min-h-screen bg-paper">
      {/* Hero */}
      <MarketingSection size="hero" as="div">
        <motion.div
          ref={heroRef}
          className="max-w-4xl"
          initial={{ opacity: 0, y: 20 }}
          animate={heroInView ? { opacity: 1, y: 0 } : { opacity: 0, y: 20 }}
          transition={{ duration: 0.6 }}
        >
          <div className="font-mono text-meta uppercase tracking-[0.08em] text-ink-3 mb-3">
            The NuraVolt platform
          </div>
          <h1 className="text-h1 sm:text-display font-semibold text-ink mb-6">
            Everything inside the platform.
          </h1>
          <p className="text-body text-ink-2 mb-8 max-w-2xl">
            A single surface for performance monitoring, soiling intelligence, fault
            prediction, O&M workflow, reporting, and compliance, built for renewable
            asset owners who run plants at scale.
          </p>
          <div className="flex flex-col sm:flex-row flex-wrap gap-3">
            <Button size="lg" asChild>
              <Link href="/showcase">
                Open the Live Demo
                <ArrowRight className="w-4 h-4 ml-2" />
              </Link>
            </Button>
            <Button size="lg" variant="outline" asChild>
              <Link href="/platform/integrations">See Integrations</Link>
            </Button>
          </div>
        </motion.div>
      </MarketingSection>

      <HairlineRule />

      {/* Feature groups */}
      {featureGroups.map((group, groupIdx) => {
        const accent = accentClasses[group.accent];
        return (
          <section
            key={group.title}
            className={`py-16 sm:py-20 ${groupIdx % 2 === 0 ? 'bg-paper' : 'bg-paper-2'}`}
          >
            <div className="container mx-auto px-4 sm:px-6 lg:px-8">
              <div className="max-w-3xl mb-12">
                <div className={`inline-block px-3 py-1 rounded-full ${accent.bg} ${accent.iconText} text-sm font-semibold mb-4`}>
                  {group.title}
                </div>
                <h2 className="text-3xl sm:text-4xl font-bold text-ink mb-4">
                  {group.description}
                </h2>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                {group.items.map((item, idx) => (
                  <motion.div
                    key={item.title}
                    className={`rounded p-6 bg-paper border ${accent.border} shadow-sm hover:shadow-sm transition-shadow`}
                    initial={{ opacity: 0, y: 20 }}
                    whileInView={{ opacity: 1, y: 0 }}
                    viewport={{ once: true }}
                    transition={{ delay: idx * 0.08 }}
                  >
                    <div className={`inline-flex p-3 rounded-lg ${accent.iconBg} mb-4`}>
                      <item.icon className={`w-6 h-6 ${accent.iconText}`} />
                    </div>
                    <h3 className="text-lg font-bold text-ink mb-2">{item.title}</h3>
                    <p className="text-ink-2 text-sm leading-relaxed">{item.description}</p>
                  </motion.div>
                ))}
              </div>
            </div>
          </section>
        );
      })}

      <HairlineRule />

      {/* CTA */}
      <MarketingSection size="default">
        <div className="max-w-3xl">
          <div className="font-mono text-meta uppercase tracking-[0.08em] text-ink-3 mb-3">
            Try it
          </div>
          <h2 className="text-h1 font-semibold text-ink mb-4">
            The best way to understand it is to click through it.
          </h2>
          <p className="text-body text-ink-2 mb-8 max-w-2xl">
            Our public showcase mirrors the platform with anonymised sample data, one PV
            plant and one wind plant. No signup, just a link.
          </p>
          <div className="flex flex-col sm:flex-row flex-wrap gap-3">
            <Button size="lg" asChild>
              <Link href="/showcase">
                Explore the Showcase
                <ArrowRight className="w-4 h-4 ml-2" />
              </Link>
            </Button>
            <Button size="lg" variant="outline" asChild>
              <a href="mailto:contact@nuravolt.com">Talk to our team</a>
            </Button>
          </div>
        </div>
      </MarketingSection>
    </div>
  );
}
