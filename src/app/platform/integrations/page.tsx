'use client';

import { useRef } from 'react';
import { motion, useInView } from 'framer-motion';
import { Button } from '@/components/ui/button';
import Link from 'next/link';
import { MarketingSection } from '@/components/ui/MarketingSection';
import { HairlineRule } from '@/components/ui/HairlineRule';
import {
  ArrowRight,
  Cable,
  Cloud,
  Database,
  FileSpreadsheet,
  Network,
  Radio,
  Shield,
  Workflow,
  Zap,
} from 'lucide-react';
import IntegrationsLogoGrid from '@/components/landing/IntegrationsLogoGrid';
import AuditLeadForm from '@/components/landing/AuditLeadForm';

const sourceCategories = [
  {
    title: 'Industrial Protocols',
    description: 'Direct plant-side connections, usually over the control network.',
    icon: Cable,
    sources: [
      { name: 'Modbus TCP', detail: 'IP-based over Ethernet. Our default for modern plants.' },
      { name: 'Modbus RTU', detail: 'Serial (RS-485). Bridged via gateway to the platform.' },
      { name: 'OPC-UA', detail: 'Standard for SCADA systems. Certificate-based auth.' },
      { name: 'MQTT', detail: 'Publish/subscribe. Good for rooftop and hybrid fleets.' },
      { name: 'IEC 61850', detail: 'Substation protocol. Available on request.' },
    ],
  },
  {
    title: 'Inverter Cloud APIs',
    description: 'For portfolios without full SCADA, we pull from the vendor portal.',
    icon: Cloud,
    sources: [
      { name: 'Huawei FusionSolar', detail: 'OAuth2. Plant, device, and alarm endpoints.' },
      { name: 'SMA Sunny Portal', detail: 'Per-plant credentials. Historical + live.' },
      { name: 'Sungrow iSolarCloud', detail: 'Full device-tree ingestion.' },
      { name: 'Fronius Solar.web', detail: 'Live + archive via OAuth.' },
      { name: 'SolarEdge', detail: 'Monitoring API with per-inverter resolution.' },
      { name: 'Enphase Enlighten', detail: 'Microinverter-level data.' },
      { name: 'Oxel', detail: 'Utility-scale portal integration.' },
      { name: 'Other brands', detail: 'On request, typical integration 2-3 weeks.' },
    ],
  },
  {
    title: 'Time-Series Databases',
    description: 'Read directly from your existing telemetry store.',
    icon: Database,
    sources: [
      { name: 'InfluxDB 1.x / 2.x', detail: 'Flux and InfluxQL supported.' },
      { name: 'TimescaleDB', detail: 'Native hypertable queries.' },
      { name: 'Prometheus', detail: 'Remote-read API for metrics shared with infra.' },
      { name: 'PI Historian', detail: 'OSIsoft connector (enterprise).' },
    ],
  },
  {
    title: 'Files & Manual Upload',
    description: 'For bootstrapping or archive backfills.',
    icon: FileSpreadsheet,
    sources: [
      { name: 'CSV', detail: 'Schema auto-detection with column mapping wizard.' },
      { name: 'Parquet', detail: 'Bulk imports for historical analysis.' },
      { name: 'SFTP drop', detail: 'Scheduled pickups from your archive server.' },
      { name: 'S3 / GCS / Azure Blob', detail: 'Cloud bucket subscribers.' },
    ],
  },
];

export default function PlatformIntegrationsPage() {
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
          <div className="font-mono text-meta uppercase tracking-[0.08em] text-ink-3 mb-3 flex items-center gap-2">
            <Network className="w-3.5 h-3.5" />
            Data & Integrations
          </div>
          <h1 className="text-h1 sm:text-display font-semibold text-ink mb-6">
            We speak the protocols your plant already speaks.
          </h1>
          <p className="text-body text-ink-2 mb-8 max-w-2xl">
            Modbus, OPC-UA, MQTT, inverter clouds, time-series databases, CSV, whatever
            your fleet looks like today, we integrate in 2-3 weeks without hardware
            changes.
          </p>
        </motion.div>
      </MarketingSection>

      <HairlineRule />

      {/* Logo grid, brand recognition above the technical deep-dive */}
      <IntegrationsLogoGrid />

      {/* Modbus, featured section */}
      <section className="py-16 sm:py-24 bg-paper">
        <div className="container mx-auto px-4 sm:px-6 lg:px-8">
          <div className="max-w-5xl mx-auto">
            <div className="flex items-start gap-4 mb-8">
              <div className="inline-flex p-3 rounded-lg bg-paper-2 flex-shrink-0">
                <Radio className="w-8 h-8 text-primary" />
              </div>
              <div>
                <div className="text-sm font-semibold text-primary uppercase tracking-wider mb-2">
                  Featured Integration
                </div>
                <h2 className="text-3xl sm:text-4xl font-bold text-ink">
                  Modbus, the backbone of utility-scale solar
                </h2>
              </div>
            </div>

            <div className="prose prose-lg max-w-none text-ink-2 leading-relaxed space-y-6">
              <p>
                Nearly every string inverter, transformer, weather station, and power
                meter in a utility-scale PV or BESS plant exposes its registers over
                Modbus. It's simple, battle-tested, and unglamorous, which is exactly
                why it runs the fleet.
              </p>
              <p>
                The platform reads Modbus through two transports:
              </p>
            </div>

            <div className="grid md:grid-cols-2 gap-6 mt-8">
              <div className="rounded p-6 bg-paper-2 border border-divider">
                <div className="flex items-center gap-3 mb-3">
                  <div className="p-2 rounded-lg bg-primary">
                    <Network className="w-5 h-5 text-white" />
                  </div>
                  <h3 className="text-xl font-bold text-ink">Modbus TCP</h3>
                </div>
                <p className="text-ink-2 mb-3">
                  IP-based. The modern default. Runs over the control-network VLAN or a
                  cellular tunnel to a plant-side gateway.
                </p>
                <ul className="text-sm text-ink-2 space-y-1 list-disc list-inside">
                  <li>Port 502 (standard) or custom</li>
                  <li>Slave ID per device; unit IDs discoverable</li>
                  <li>Works behind NAT with a secure outbound tunnel</li>
                </ul>
              </div>

              <div className="rounded p-6 bg-paper-2 border border-divider">
                <div className="flex items-center gap-3 mb-3">
                  <div className="p-2 rounded-lg bg-data-bg-2">
                    <Cable className="w-5 h-5 text-white" />
                  </div>
                  <h3 className="text-xl font-bold text-ink">Modbus RTU</h3>
                </div>
                <p className="text-ink-2 mb-3">
                  Serial RS-485 daisy-chained between devices. Still the reality for many
                  legacy plants. Bridged via a Modbus-RTU-to-TCP gateway or an edge
                  collector.
                </p>
                <ul className="text-sm text-ink-2 space-y-1 list-disc list-inside">
                  <li>9600, 19200, 38400, or 115200 baud</li>
                  <li>8N1 / 8E1 / 8O1 frame configurations</li>
                  <li>Up to 247 devices per chain</li>
                </ul>
              </div>
            </div>

            <h3 className="text-2xl font-bold text-ink mt-12 mb-4">
              How our Modbus adapter works
            </h3>
            <div className="rounded border border-divider overflow-hidden">
              <div className="grid grid-cols-1 md:grid-cols-4 divide-y md:divide-y-0 md:divide-x divide-gray-200">
                {[
                  {
                    step: '1. Discover',
                    text: 'Auto-probe unit IDs in your address range. Match device signatures to our library (Huawei SUN2000, SMA Sunny Tripower, Sungrow SG, Fronius Tauro, ABB PVS, Power Electronics, etc.).',
                  },
                  {
                    step: '2. Map',
                    text: 'Apply a pre-built register map for known devices, or use our mapping wizard for unknown ones. Every register gets a normalised name (e.g. active_power_kw, dc_voltage_v).',
                  },
                  {
                    step: '3. Scale',
                    text: 'Apply scaling factor, unit conversion, and bit-pack decoding (16/32/64-bit, big/little-endian, signed/unsigned). One wrong gain factor kills a whole analysis, we catch those early.',
                  },
                  {
                    step: '4. Poll',
                    text: 'Configurable intervals per register group. Hot metrics every 5 s, cold metrics every 5 min. Back-pressure and retries. Compresses on the wire.',
                  },
                ].map((s) => (
                  <div key={s.step} className="p-5">
                    <div className="text-xs font-bold text-primary uppercase tracking-wider mb-2">
                      {s.step}
                    </div>
                    <p className="text-sm text-ink-2 leading-relaxed">{s.text}</p>
                  </div>
                ))}
              </div>
            </div>

            <div className="mt-10 rounded bg-signal-warning/5 border border-amber-200 p-6">
              <div className="flex items-start gap-3">
                <Zap className="w-6 h-6 text-signal-warning flex-shrink-0 mt-0.5" />
                <div>
                  <h4 className="font-bold text-ink mb-2">
                    Why this matters for the ML
                  </h4>
                  <p className="text-ink-2 leading-relaxed">
                    A physics-ML digital twin is only as good as the data feeding it. If
                    register scaling is wrong, or one inverter reports in W while another
                    reports in kW, the residuals are junk and every alert is a false
                    positive. Our adapter catches scaling and unit mismatches during
                    discovery, before a single prediction runs.
                  </p>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* All data sources */}
      <section id="data-sources" className="scroll-mt-24 py-16 sm:py-24 bg-paper-2">
        <div className="container mx-auto px-4 sm:px-6 lg:px-8">
          <div className="text-center mb-12">
            <h2 className="text-3xl sm:text-4xl font-bold text-ink mb-4">
              Every way your data shows up
            </h2>
            <p className="text-xl text-ink-2 max-w-3xl mx-auto">
              From legacy SCADA to inverter-vendor clouds to a folder of CSV files.
            </p>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-6 max-w-6xl mx-auto">
            {sourceCategories.map((cat) => (
              <motion.div
                key={cat.title}
                className="rounded bg-paper border border-divider p-6 shadow-sm"
                initial={{ opacity: 0, y: 20 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true }}
              >
                <div className="flex items-center gap-3 mb-4">
                  <div className="p-2 rounded-lg bg-paper-2">
                    <cat.icon className="w-5 h-5 text-primary" />
                  </div>
                  <div>
                    <h3 className="text-lg font-bold text-ink">{cat.title}</h3>
                    <p className="text-sm text-ink-3">{cat.description}</p>
                  </div>
                </div>
                <ul className="divide-y divide-gray-100">
                  {cat.sources.map((s) => (
                    <li key={s.name} className="py-2.5 flex justify-between items-start gap-3">
                      <span className="font-semibold text-ink">{s.name}</span>
                      <span className="text-sm text-ink-3 text-right">{s.detail}</span>
                    </li>
                  ))}
                </ul>
              </motion.div>
            ))}
          </div>
        </div>
      </section>

      {/* Integration workflow */}
      <section className="py-16 sm:py-24 bg-paper">
        <div className="container mx-auto px-4 sm:px-6 lg:px-8">
          <div className="max-w-4xl mx-auto">
            <div className="text-center mb-12">
              <div className="inline-flex items-center gap-2 text-primary font-semibold mb-3">
                <Workflow className="w-5 h-5" />
                <span className="text-sm uppercase tracking-wider">How integration works</span>
              </div>
              <h2 className="text-3xl sm:text-4xl font-bold text-ink mb-4">
                From kick-off to live data in 2-3 weeks
              </h2>
            </div>

            <div className="relative">
              <div className="absolute left-4 top-4 bottom-4 w-0.5 bg-paper-2 hidden md:block" />
              <div className="space-y-8">
                {[
                  {
                    week: 'Week 0',
                    title: 'Scoping',
                    detail:
                      'Share an inverter model list, SCADA diagram (if any), existing credentials, and network topology. 30-minute call.',
                  },
                  {
                    week: 'Week 1',
                    title: 'Connect',
                    detail:
                      'We stand up the connector, open a secure tunnel if needed, and auto-discover your devices. First registers start flowing.',
                  },
                  {
                    week: 'Week 2',
                    title: 'Validate',
                    detail:
                      'Side-by-side comparison against your existing monitoring for a sanity check. Fix register scaling, unit mismatches, timezone drift.',
                  },
                  {
                    week: 'Week 3',
                    title: 'Go live',
                    detail:
                      'Alerts armed, dashboards populated, reports scheduled. Historical backfill continues in the background.',
                  },
                ].map((s, i) => (
                  <motion.div
                    key={s.week}
                    className="flex gap-4 md:gap-6"
                    initial={{ opacity: 0, x: -20 }}
                    whileInView={{ opacity: 1, x: 0 }}
                    viewport={{ once: true }}
                    transition={{ delay: i * 0.1 }}
                  >
                    <div className="flex-shrink-0 w-8 h-8 rounded-full bg-primary text-white font-bold text-sm flex items-center justify-center relative z-10">
                      {i + 1}
                    </div>
                    <div className="flex-1 pb-2">
                      <div className="text-xs font-semibold text-primary uppercase tracking-wider mb-1">
                        {s.week}
                      </div>
                      <h3 className="text-lg font-bold text-ink mb-1">{s.title}</h3>
                      <p className="text-ink-2 leading-relaxed">{s.detail}</p>
                    </div>
                  </motion.div>
                ))}
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* Security blurb */}
      <section className="py-16 bg-paper-2">
        <div className="container mx-auto px-4 sm:px-6 lg:px-8">
          <div className="max-w-4xl mx-auto rounded bg-paper border border-divider p-8 flex flex-col md:flex-row items-center gap-8">
            <div className="flex-shrink-0">
              <div className="inline-flex p-4 rounded bg-signal-positive/10">
                <Shield className="w-10 h-10 text-signal-positive" />
              </div>
            </div>
            <div className="flex-1">
              <h3 className="text-2xl font-bold text-ink mb-3">
                Security by default
              </h3>
              <p className="text-ink-2 leading-relaxed">
                Outbound-only tunnels. Credentials encrypted at rest. No inbound ports on
                your plant network. Deploy in our managed cloud or fully on-premise
                behind your firewall, the platform runs the same either way. SOC 2 Type
                II controls available for enterprise deployments.
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* CTA, audit lead form */}
      <section className="py-16 sm:py-24 bg-paper-2">
        <div className="container mx-auto px-4 sm:px-6 lg:px-8">
          <div className="max-w-3xl mx-auto text-center mb-10">
            <h2 className="text-3xl sm:text-4xl font-bold text-ink mb-4">
              Don&apos;t see your stack? Tell us what you run.
            </h2>
            <p className="text-lg text-ink-2">
              If your inverter brand, SCADA, or data warehouse isn&apos;t above, drop the
              details below. Most new connectors are 2-3 weeks to go-live, and the
              scoping call is free.
            </p>
          </div>
          <AuditLeadForm variant="embedded" source="integrations_page" />
          <div className="mt-8 text-center">
            <Link
              href="/showcase"
              className="inline-flex items-center gap-1 text-sm font-semibold text-primary hover:text-primary"
            >
              Or see a live demo first <ArrowRight className="w-3.5 h-3.5" />
            </Link>
          </div>
        </div>
      </section>
    </div>
  );
}
