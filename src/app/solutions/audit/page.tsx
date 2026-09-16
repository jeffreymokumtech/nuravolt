'use client';

import Link from 'next/link';
import { motion } from 'framer-motion';
import {
  Gauge,
  FileCheck,
  Scale,
  CheckCircle,
  ArrowRight,
  Database,
  FlaskConical,
  FileText,
} from 'lucide-react';
import SolutionHero from '@/components/solutions/SolutionHero';
import SolutionCTA from '@/components/solutions/SolutionCTA';
import { MarketingSection } from '@/components/ui/MarketingSection';
import { KPIReadout } from '@/components/ui/KPIReadout';
import { HairlineRule } from '@/components/ui/HairlineRule';
import { Button } from '@/components/ui/button';

const SPECIMEN_BASE = '/showcase/plant/nimbus/audit';

export default function AuditSolutionPage() {
  const offers = [
    {
      icon: Gauge,
      title: 'BESS Optimizer Performance Audit',
      description:
        'Your realized dispatch revenue, day by day, against a perfect-foresight optimum computed on the same market prices, round-trip efficiency, and power limits your asset actually has. The headline is a capture ratio and an annualized revenue gap you can put in front of your route-to-market provider.',
      deliverables: [
        'Capture ratio and annualized revenue gap in euros',
        'Daily register: realized vs benchmark revenue, cycles, spread capture',
        'Worst and median day reconstructions with price, power, and SoC traces',
        'SoC ledger integrity check quantifying measurement drift',
      ],
      specimenHref: `${SPECIMEN_BASE}/optimizer`,
      specimenLabel: 'See a specimen optimizer audit',
    },
    {
      icon: FileCheck,
      title: 'Warranty and Degradation Dossier',
      description:
        'An independent reconstruction of what your battery has actually been through: rainflow cycle counting on state of charge, SoH trajectory against the contractual floor, and a timestamped register of every operating-limit violation. Evidence that stands up in an OEM warranty negotiation.',
      deliverables: [
        'Warranty health score with component breakdown',
        'Equivalent full cycles, throughput, and cycle-depth distribution',
        'SoH projection vs warranty floor, anchored to capacity tests',
        'Violations register: temperature, SoC dwell, HVAC events with measured values',
      ],
      specimenHref: `${SPECIMEN_BASE}/warranty`,
      specimenLabel: 'See a specimen dossier',
    },
    {
      icon: Scale,
      title: 'Compliance Evidence Packs',
      description:
        'The grid code envelope, reporting obligations, and metering policy that apply to your asset in its market, compiled into one pack with citations back to the authoritative regulatory text. Built from our country compliance packs covering Spain, Portugal, Italy, the GCC, and Sub-Saharan Africa.',
      deliverables: [
        'Fault ride-through envelope and frequency window for your grid code',
        'Reporting obligations filtered by capacity and asset type, with deadlines',
        'Metering class, sampling, and retention requirements',
        'Source citations for every rule, ready for lender or regulator review',
      ],
      specimenHref: `${SPECIMEN_BASE}/compliance`,
      specimenLabel: 'See a specimen evidence pack',
    },
  ];

  const steps = [
    {
      icon: Database,
      step: '1',
      title: 'Data handover',
      detail:
        'One telemetry export from your SCADA, BMS, or EMS covering the audit window. No live integration, no software rollout, no access to your systems.',
    },
    {
      icon: FlaskConical,
      step: '2',
      title: 'Independent reconstruction',
      detail:
        'We rebuild cycles, SoC ledgers, and dispatch against market prices with published methodology. Every figure in the deliverable can be re-derived from your data.',
    },
    {
      icon: FileText,
      step: '3',
      title: 'Evidence delivered',
      detail:
        'You receive an interactive audit surface plus a signed PDF dossier. Findings feed directly into operator negotiations, warranty claims, or financing packs.',
    },
  ];

  return (
    <div className="min-h-screen bg-paper">
      <SolutionHero
        asset="bess"
        eyebrow="NuraVolt Audit · fixed-scope engagements"
        headline="Independent BESS audits that turn telemetry into evidence."
        highlight="One engagement, three deliverables you can hand to an OEM, lender, or board."
        sub="NuraVolt Audit is the one-off counterpart to our continuous monitoring platform. Send us one telemetry export and we return a reproducible dossier: how much revenue your optimizer leaves on the table, where your warranty really stands, and the compliance evidence your market requires."
        stats={[
          { value: '90+ days', label: 'Typical audit window' },
          { value: '€/year', label: 'Revenue gap, annualized' },
          { value: '2 weeks', label: 'From data handover to dossier' },
        ]}
        primaryCta={{ label: 'Book an audit call', intent: 'audit' }}
        screenshot={{
          src: '/images/screenshots/bess-warranty.png',
          alt: 'NuraVolt Audit warranty dossier, health score, SoH trajectory and violations register for a BESS asset',
          panelHeader: 'AUDIT · WARRANTY DOSSIER · LFP',
          panelMeta: 'nuravolt.com/solutions/audit',
        }}
      />

      {/* Overview: Monitor and Audit as parallel product lines */}
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
              Monitor watches your asset every day. Audit answers one hard question.
            </h2>
            <p className="text-body text-ink-2 mb-4">
              NuraVolt runs two product lines on the same physics-informed models. Monitor is the
              continuous platform: live dashboards, fault detection, and alerts on your streaming
              data. Audit is a one-off engagement on a single telemetry export, built for the
              moments when you need defensible numbers rather than another dashboard: an operator
              contract renewal, a warranty dispute, a refinancing, an acquisition.
            </p>
            <p className="text-body text-ink-2 mb-8">
              Because both lines share the same engine, an audit is also the lowest-friction way
              to evaluate the platform. Every audit deliverable is reproducible: methodology is
              published, assumptions are stated, and each figure can be re-derived from your own
              data.
            </p>
            <Button size="lg" variant="outline" asChild>
              <Link href={SPECIMEN_BASE}>
                Browse a full specimen audit in the live demo
                <ArrowRight className="w-4 h-4 ml-2" />
              </Link>
            </Button>
          </motion.div>
        </div>
      </MarketingSection>

      <HairlineRule />

      {/* The three offers */}
      <MarketingSection id="offers" size="default" surface="paper-2">
        <div className="text-center mb-12">
          <div className="font-mono text-meta uppercase tracking-[0.08em] text-ink-3 mb-3">
            The offers
          </div>
          <h2 className="text-h1 font-semibold text-ink mb-3">
            Three audit products, one data handover
          </h2>
          <p className="text-body text-ink-2 max-w-3xl mx-auto">
            Commission them individually or as a combined engagement. Each one ships as an
            interactive evidence surface plus a signed PDF.
          </p>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {offers.map((offer, index) => (
            <motion.div
              key={offer.title}
              className="bg-paper rounded border border-divider p-6 flex flex-col hover:border-ink-3/40 transition-colors"
              initial={{ opacity: 0, y: 12 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true }}
              transition={{ delay: index * 0.05 }}
            >
              <div className="flex items-center mb-4">
                <div className="p-3 bg-violet-50 rounded">
                  <offer.icon className="w-5 h-5 text-asset-bess" />
                </div>
              </div>
              <h3 className="text-lg font-semibold text-ink mb-2">{offer.title}</h3>
              <p className="text-ink-2 mb-4 text-sm leading-relaxed">{offer.description}</p>
              <ul className="space-y-2 mb-5">
                {offer.deliverables.map((item) => (
                  <li key={item} className="flex items-start gap-2 text-sm text-ink-2">
                    <CheckCircle className="w-4 h-4 mt-0.5 shrink-0 text-signal-positive" />
                    {item}
                  </li>
                ))}
              </ul>
              <div className="mt-auto">
                <Link
                  href={offer.specimenHref}
                  className="inline-flex items-center gap-1 text-sm font-medium text-asset-bess hover:underline"
                >
                  {offer.specimenLabel}
                  <ArrowRight className="w-4 h-4" />
                </Link>
              </div>
            </motion.div>
          ))}
        </div>
      </MarketingSection>

      {/* How it works */}
      <MarketingSection size="default">
        <div className="text-center mb-12">
          <div className="font-mono text-meta uppercase tracking-[0.08em] text-ink-3 mb-3">
            How it works
          </div>
          <h2 className="text-h1 font-semibold text-ink mb-3">
            No integration. No rollout. One export.
          </h2>
          <p className="text-body text-ink-2 max-w-3xl mx-auto">
            An audit is deliberately lightweight for your team: the entire engagement runs on a
            single historical data export.
          </p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-6 max-w-5xl mx-auto">
          {steps.map((s, index) => (
            <motion.div
              key={s.step}
              className="rounded-sm border border-divider bg-paper p-6"
              initial={{ opacity: 0, y: 12 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true }}
              transition={{ delay: index * 0.05 }}
            >
              <div className="flex items-center justify-between mb-4">
                <div className="p-2.5 bg-violet-50 rounded">
                  <s.icon className="w-5 h-5 text-asset-bess" />
                </div>
                <span className="font-mono text-meta uppercase tracking-[0.08em] text-ink-3">
                  Step {s.step}
                </span>
              </div>
              <h3 className="text-lg font-semibold text-ink mb-2">{s.title}</h3>
              <p className="text-ink-2 text-sm leading-relaxed">{s.detail}</p>
            </motion.div>
          ))}
        </div>
      </MarketingSection>

      {/* Why independent */}
      <MarketingSection size="default" surface="paper-2">
        <div className="max-w-5xl">
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-10 items-start">
            <div className="lg:col-span-7">
              <div className="font-mono text-meta uppercase tracking-[0.08em] text-ink-3 mb-3">
                Why independent
              </div>
              <h2 className="text-h1 font-semibold text-ink mb-5">
                The parties reporting your performance all have a position in it.
              </h2>
              <p className="text-body text-ink-2 mb-4">
                Your optimizer reports its own performance. Your OEM interprets its own warranty.
                Your EPC certifies its own commissioning. An audit puts a third, disinterested
                reconstruction on the table, built only from raw telemetry and public market
                prices, with methodology you can hand to your own engineers to verify.
              </p>
              <p className="text-body text-ink-2">
                That is why audit findings travel well: into route-to-market renegotiations,
                warranty claims backed by timestamped violations, and due-diligence packs where a
                buyer&apos;s technical advisor will re-run the numbers anyway.
              </p>
            </div>
            <div className="lg:col-span-5 border-t border-divider">
              <div className="py-5 border-b border-divider">
                <KPIReadout value="Reproducible" label="Every figure re-derivable from your data" size="lg" />
              </div>
              <div className="py-5 border-b border-divider">
                <KPIReadout value="8 countries" label="Compliance packs with cited sources" size="lg" />
              </div>
              <div className="py-5">
                <KPIReadout value="0 installs" label="Runs on a single telemetry export" size="lg" />
              </div>
            </div>
          </div>
        </div>
      </MarketingSection>

      <SolutionCTA
        eyebrow="Fixed scope, fixed price"
        heading="Put your asset's numbers on the table."
        sub="Tell us about the asset and the question you need answered. We scope the audit on a short call, agree the window and deliverables, and return the dossier within two weeks of data handover."
        primary={{ label: 'Book an audit call', intent: 'audit' }}
        secondary={{ label: 'Explore continuous BESS monitoring →', href: '/solutions/bess-monitoring' }}
      />
    </div>
  );
}
