'use client';

import { useRef } from 'react';
import { motion, useInView } from 'framer-motion';
import { Button } from '@/components/ui/button';
import Link from 'next/link';
import {
  ArrowRight,
  BookOpen,
  CheckCircle2,
  Clock,
  FileCheck,
  Gauge,
  Globe,
  Scale,
  ShieldCheck,
  Zap,
} from 'lucide-react';

const COUNTRIES = [
  { iso: 'ES', flag: '🇪🇸', name: 'Spain', regulator: 'CNMC', grid: 'REE' },
  { iso: 'PT', flag: '🇵🇹', name: 'Portugal', regulator: 'ERSE', grid: 'REN' },
  { iso: 'IT', flag: '🇮🇹', name: 'Italy', regulator: 'ARERA', grid: 'Terna' },
  { iso: 'AE', flag: '🇦🇪', name: 'UAE', regulator: 'DEWA / ADWEA', grid: 'DEWA / TRANSCO' },
  { iso: 'SA', flag: '🇸🇦', name: 'Saudi Arabia', regulator: 'WERA', grid: 'SEC' },
  { iso: 'KE', flag: '🇰🇪', name: 'Kenya', regulator: 'EPRA', grid: 'KETRACO' },
  { iso: 'NG', flag: '🇳🇬', name: 'Nigeria', regulator: 'NERC', grid: 'TCN' },
  { iso: 'ZA', flag: '🇿🇦', name: 'South Africa', regulator: 'NERSA', grid: 'Eskom' },
];

const INSIDE_EACH_PACK = [
  {
    icon: Zap,
    title: 'Grid-code envelope',
    detail:
      'LVRT/HVRT ride-through curves, frequency band, reactive-power range, ramp-rate limits, anti-islanding standard. Bound to the plant on onboarding.',
  },
  {
    icon: FileCheck,
    title: 'Reporting obligations',
    detail:
      'Every periodic report you owe the regulator and grid operator, monthly, quarterly, annual, with deadline, recipient, and source clause.',
  },
  {
    icon: Gauge,
    title: 'Metering & data retention',
    detail:
      'Meter class, sampling interval, retention window, calibration cadence. Drives data-ingest validation and archive policies.',
  },
  {
    icon: ShieldCheck,
    title: 'Inspection cadence',
    detail:
      'Mandatory periodic inspections (OCA, O&M audit, certification renewal) with the authority responsible and the minimum interval.',
  },
  {
    icon: BookOpen,
    title: 'Source citations',
    detail:
      'Every rule links back to the authoritative text, royal decree article, grid-code section, regulator circular.',
  },
  {
    icon: Scale,
    title: 'Environmental reporting',
    detail:
      'Guarantees of origin, green certificates, and emissions-avoided declarations wired to the right registry.',
  },
];

export default function CompliancePage() {
  const heroRef = useRef(null);
  const heroInView = useInView(heroRef, { once: true });

  return (
    <div className="min-h-screen bg-paper">
      {/* Hero */}
      <section
        ref={heroRef}
        className="relative py-20 sm:py-28 bg-data-bg text-white"
      >
        <div className="container mx-auto px-4 sm:px-6 lg:px-8">
          <motion.div
            className="max-w-4xl mx-auto text-center"
            initial={{ opacity: 0, y: 30 }}
            animate={heroInView ? { opacity: 1, y: 0 } : { opacity: 0, y: 30 }}
            transition={{ duration: 0.8 }}
          >
            <div className="inline-flex items-center gap-2 px-3 py-1 bg-paper/10 backdrop-blur rounded-full text-sm font-medium mb-6">
              <Globe className="w-4 h-4" />
              Compliance Packs
            </div>
            <h1 className="text-4xl sm:text-5xl lg:text-6xl font-bold mb-6">
              Know what you owe the regulator, before they ask.
            </h1>
            <p className="text-xl sm:text-2xl text-ink-3 mb-8">
              Country-specific grid-code, reporting, metering, and inspection obligations
              wired into the platform. Onboard a plant with the right country; every report
              it generates ships with the applicable obligations baked in.
            </p>
            <div className="flex flex-col sm:flex-row gap-4 justify-center">
              <Button size="lg" className="bg-paper text-ink hover:bg-paper-2 px-8 py-4 text-lg" asChild>
                <Link href="/showcase">See it in the demo →</Link>
              </Button>
              <Button
                size="lg"
                variant="outline"
                className="bg-transparent border-2 border-white text-white hover:bg-paper hover:text-ink px-8 py-4 text-lg"
                asChild
              >
                <a href="mailto:contact@nuravolt.com?subject=Compliance%20pack%20request">
                  Request a new country
                </a>
              </Button>
            </div>
          </motion.div>
        </div>
      </section>

      {/* Compliance Intelligence, EU-wide regulations */}
      <section className="py-16 sm:py-20 bg-paper">
        <div className="container mx-auto px-4 sm:px-6 lg:px-8">
          <div className="max-w-5xl mx-auto">
            <div className="text-center mb-10">
              <div className="inline-flex items-center gap-2 px-3 py-1 bg-paper-2 text-primary rounded-full text-sm font-semibold mb-4">
                <ShieldCheck className="w-4 h-4" />
                Compliance Intelligence
              </div>
              <h2 className="text-3xl sm:text-4xl font-bold text-ink mb-3">
                Three EU regulations that now shape every plant&apos;s data stack
              </h2>
              <p className="text-lg text-ink-2 max-w-3xl mx-auto">
                Country grid codes are table-stakes. The stuff that&apos;s actually
                moving CFO and lender budget right now is CSRD, the EU AI Act, and
                the EU Battery Regulation. NuraVolt ships these built-in.
              </p>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-5 mb-10">
              <div className="rounded bg-paper border border-divider p-6 shadow-sm">
                <div className="inline-flex p-3 rounded-lg bg-emerald-100 mb-4">
                  <FileCheck className="w-6 h-6 text-signal-positive" />
                </div>
                <h3 className="text-lg font-bold text-ink mb-2">
                  CSRD E1 reporting
                </h3>
                <p className="text-ink-2 text-sm leading-relaxed mb-3">
                  Every plant has ESRS E1-5 (energy) and E1-6 (GHG) obligations.
                  NuraVolt auto-generates the plant-level data pack from your
                  existing generation + availability telemetry.
                </p>
                <div className="text-xs text-ink-3 font-mono">
                  Auditor-ready · XBRL-tagged · mapped to ESRS E1
                </div>
              </div>

              <div className="rounded bg-paper border border-divider p-6 shadow-sm">
                <div className="inline-flex p-3 rounded-lg bg-indigo-100 mb-4">
                  <Scale className="w-6 h-6 text-primary" />
                </div>
                <h3 className="text-lg font-bold text-ink mb-2">
                  AI Act model cards
                </h3>
                <p className="text-ink-2 text-sm leading-relaxed mb-3">
                  Forecasting, dispatch, and fault-detection models touching
                  &quot;critical infrastructure management&quot; (Annex III)
                  ship with auto-generated model cards covering intended use,
                  accuracy metrics, oversight points, and limitations.
                </p>
                <div className="text-xs text-ink-3 font-mono">
                  Per-model · auto-generated · deadline Aug 2026
                </div>
              </div>

              <div className="rounded bg-paper border border-divider p-6 shadow-sm">
                <div className="inline-flex p-3 rounded-lg bg-amber-100 mb-4">
                  <BookOpen className="w-6 h-6 text-signal-warning" />
                </div>
                <h3 className="text-lg font-bold text-ink mb-2">
                  EU Battery Passport feed
                </h3>
                <p className="text-ink-2 text-sm leading-relaxed mb-3">
                  From Feb 2027 every BESS ≥ 2 kWh needs a digital passport
                  with performance, degradation, and SoH history. NuraVolt
                  already captures this, we package and submit it.
                </p>
                <div className="text-xs text-ink-3 font-mono">
                  BESS ≥ 2 kWh · mandatory Feb 2027
                </div>
              </div>
            </div>

            <div className="text-center">
              <Button size="lg" className="bg-primary hover:bg-primary text-white px-8 py-4 text-lg" asChild>
                <Link href="/engagements#compliance">
                  See the Compliance &amp; Reporting Pack →
                </Link>
              </Button>
            </div>
          </div>
        </div>
      </section>

      {/* Countries covered */}
      <section className="py-16 sm:py-20 bg-paper-2">
        <div className="container mx-auto px-4 sm:px-6 lg:px-8">
          <div className="text-center mb-10">
            <h2 className="text-3xl sm:text-4xl font-bold text-ink mb-3">
              8 country packs. More on request.
            </h2>
            <p className="text-lg text-ink-2 max-w-2xl mx-auto">
              Each pack maps a plant's asset type + capacity to the obligations that
              actually apply. No paging through PDFs.
            </p>
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-4 max-w-5xl mx-auto">
            {COUNTRIES.map((c) => (
              <motion.div
                key={c.iso}
                className="rounded bg-paper border border-divider p-5 hover:shadow-sm hover:border-divider transition"
                initial={{ opacity: 0, scale: 0.95 }}
                whileInView={{ opacity: 1, scale: 1 }}
                viewport={{ once: true }}
              >
                <div className="flex items-center gap-2 mb-3">
                  <span className="text-2xl">{c.flag}</span>
                  <div>
                    <div className="font-bold text-ink">{c.name}</div>
                    <div className="text-xs text-ink-3">ISO {c.iso}</div>
                  </div>
                </div>
                <div className="space-y-1.5 text-xs">
                  <div className="flex justify-between">
                    <span className="text-ink-3">Regulator</span>
                    <span className="font-medium text-ink">{c.regulator}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-ink-3">Grid op.</span>
                    <span className="font-medium text-ink">{c.grid}</span>
                  </div>
                </div>
              </motion.div>
            ))}
          </div>
        </div>
      </section>

      {/* What's inside each pack */}
      <section className="py-16 sm:py-20 bg-paper-2">
        <div className="container mx-auto px-4 sm:px-6 lg:px-8">
          <div className="text-center mb-12">
            <h2 className="text-3xl sm:text-4xl font-bold text-ink mb-3">
              What's inside each pack
            </h2>
            <p className="text-lg text-ink-2 max-w-2xl mx-auto">
              Six layers, normalised across every country so the reporting engine can
              speak a single language.
            </p>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5 max-w-6xl mx-auto">
            {INSIDE_EACH_PACK.map((item, i) => (
              <motion.div
                key={item.title}
                className="rounded bg-paper border border-divider p-6 shadow-sm hover:shadow-sm transition-shadow"
                initial={{ opacity: 0, y: 20 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true }}
                transition={{ delay: i * 0.08 }}
              >
                <div className="inline-flex p-3 rounded-lg bg-paper-2 mb-4">
                  <item.icon className="w-6 h-6 text-primary" />
                </div>
                <h3 className="text-lg font-bold text-ink mb-2">{item.title}</h3>
                <p className="text-ink-2 text-sm leading-relaxed">{item.detail}</p>
              </motion.div>
            ))}
          </div>
        </div>
      </section>

      {/* How it works (lightweight 3-step) */}
      <section className="py-16 sm:py-20 bg-paper">
        <div className="container mx-auto px-4 sm:px-6 lg:px-8">
          <div className="max-w-4xl mx-auto">
            <div className="text-center mb-10">
              <h2 className="text-3xl sm:text-4xl font-bold text-ink mb-3">
                Bound to your plant automatically
              </h2>
              <p className="text-lg text-ink-2">
                Pick a country on onboarding. That's it.
              </p>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
              {[
                {
                  step: '1',
                  title: 'Pick country on onboarding',
                  detail:
                    'Plant wizard asks for country + capacity + asset type. The pack binds automatically.',
                },
                {
                  step: '2',
                  title: 'Obligations resolve',
                  detail:
                    'We filter the pack by your plant, a 200 MW solar farm in Spain sees CECRE telemetry rules; a 50 kW rooftop does not.',
                },
                {
                  step: '3',
                  title: 'Reports include them',
                  detail:
                    'Every scheduled report can include an obligations section: what you owe, when, to whom, with source citations.',
                },
              ].map((s) => (
                <div
                  key={s.step}
                  className="rounded bg-paper border border-divider p-6 flex flex-col"
                >
                  <div className="flex-shrink-0 w-10 h-10 rounded-full bg-primary text-white font-bold text-lg flex items-center justify-center mb-4">
                    {s.step}
                  </div>
                  <h3 className="text-lg font-bold text-ink mb-2">{s.title}</h3>
                  <p className="text-ink-2 text-sm leading-relaxed flex-1">{s.detail}</p>
                </div>
              ))}
            </div>
          </div>
        </div>
      </section>

      {/* What it prevents */}
      <section className="py-16 sm:py-20 bg-paper-2">
        <div className="container mx-auto px-4 sm:px-6 lg:px-8">
          <div className="max-w-4xl mx-auto">
            <div className="text-center mb-10">
              <h2 className="text-3xl sm:text-4xl font-bold text-ink mb-3">
                What you stop losing sleep over
              </h2>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {[
                'Missing the monthly CECRE deadline and triggering a fine',
                'Trying to figure out which ride-through curve applies to a 25 MW plant in Portugal',
                'Hand-compiling a PDF of obligations for every investor or lender audit',
                'Discovering too late that your meter class doesn\'t satisfy the current grid code',
                'Translating Arabic/Italian regulator circulars into an O&M ops plan',
                'Sending the right CSV to the right portal with the right deadline',
              ].map((pain, i) => (
                <motion.div
                  key={pain}
                  className="flex items-start gap-3 rounded bg-paper border border-divider p-4"
                  initial={{ opacity: 0, x: -10 }}
                  whileInView={{ opacity: 1, x: 0 }}
                  viewport={{ once: true }}
                  transition={{ delay: i * 0.05 }}
                >
                  <CheckCircle2 className="w-5 h-5 text-signal-positive flex-shrink-0 mt-0.5" />
                  <span className="text-sm text-ink-2 leading-relaxed">{pain}</span>
                </motion.div>
              ))}
            </div>
          </div>
        </div>
      </section>

      {/* CTA */}
      <section className="py-16 sm:py-24 bg-primary">
        <div className="container mx-auto px-4 sm:px-6 lg:px-8 text-center">
          <h2 className="text-3xl sm:text-4xl font-bold text-white mb-4">
            Compliance doesn't have to be a PDF graveyard.
          </h2>
          <p className="text-xl text-data-fg-2 mb-8 max-w-3xl mx-auto">
            See the obligations module running against a sample plant in the live demo.
          </p>
          <div className="flex flex-col sm:flex-row gap-4 justify-center">
            <Button size="lg" className="bg-paper text-primary hover:bg-paper-2 px-8 py-4 text-lg" asChild>
              <Link href="/showcase">
                Try the Live Demo <ArrowRight className="w-4 h-4 inline ml-1" />
              </Link>
            </Button>
            <Button
              size="lg"
              variant="outline"
              className="bg-transparent border-2 border-white text-white hover:bg-paper hover:text-primary px-8 py-4 text-lg"
              asChild
            >
              <a href="mailto:contact@nuravolt.com">Request a new country pack</a>
            </Button>
          </div>
          <div className="mt-8 inline-flex items-center gap-2 text-sm text-data-fg-2">
            <Clock className="w-4 h-4" />
            New country packs ship in 2-3 weeks once we have the regulator sources.
          </div>
        </div>
      </section>
    </div>
  );
}
