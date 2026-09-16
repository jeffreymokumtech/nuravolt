'use client';

import { useRef } from 'react';
import { motion, useInView } from 'framer-motion';
import { Button } from '@/components/ui/button';
import Link from 'next/link';
import { MarketingSection } from '@/components/ui/MarketingSection';
import { HairlineRule } from '@/components/ui/HairlineRule';
import {
  ArrowRight,
  Calendar,
  Download,
  FileText,
  LayoutDashboard,
  Lock,
  Mail,
  Share2,
  Sparkles,
  Users,
} from 'lucide-react';

const capabilities = [
  {
    icon: LayoutDashboard,
    title: 'Drag-and-drop dashboard builder',
    description:
      'Pick from PV, BESS, wind, and portfolio widgets. Scope each widget to a plant, an inverter group, or a single asset. Save, reopen, iterate.',
  },
  {
    icon: Calendar,
    title: 'Scheduled delivery',
    description:
      'Weekly, monthly, quarterly, or custom cadence. Recipients get a PDF in their inbox that matches the on-screen dashboard byte-for-byte.',
  },
  {
    icon: Share2,
    title: 'Public share links',
    description:
      'One-click toggle creates a read-only URL. Share it with a lender, asset manager, or an O&M partner. Rotate or revoke any time.',
  },
  {
    icon: Download,
    title: 'On-demand PDF export',
    description:
      'Landscape A4, branded header and footer, vector-quality charts. Same renderer used for scheduled emails, no layout drift.',
  },
  {
    icon: FileText,
    title: 'Compliance packs',
    description:
      '8 country packs with grid codes, reporting obligations, metering standards, and inspection cadence. Mix into any dashboard.',
  },
  {
    icon: Users,
    title: 'Role-aware views',
    description:
      'Asset manager, O&M contractor, investor, technician, each persona gets the dashboard that matches their scope of control.',
  },
];

const widgets = [
  'Expected vs Measured Power',
  'Loss Disaggregation Waterfall',
  'Fleet Loss Ranking',
  'BESS State-of-Health History',
  'BESS Dispatch Schedule',
  'BESS Warranty Status',
  'Wind Turbine Health',
  'Power Curve Drift',
  'Availability Heatmap',
  'Revenue-at-Risk KPI',
  'Budget Deviation',
  'Compliance Obligations',
];

export default function PlatformReportingPage() {
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
            <Sparkles className="w-3.5 h-3.5" />
            Reporting & Dashboards
          </div>
          <h1 className="text-h1 sm:text-display font-semibold text-ink mb-6">
            Build a report once. Share it with anyone. Keep it fresh forever.
          </h1>
          <p className="text-body text-ink-2 mb-8 max-w-2xl">
            An interactive dashboard builder for solar, wind, and storage, with
            scheduled PDF delivery, public share links, and country-specific compliance
            packs built in.
          </p>
          <div className="flex flex-col sm:flex-row flex-wrap gap-3">
            <Button size="lg" asChild>
              <Link href="/showcase/reports">
                See sample reports
                <ArrowRight className="w-4 h-4 ml-2" />
              </Link>
            </Button>
            <Button size="lg" variant="outline" asChild>
              <Link href="/showcase">Open the full demo</Link>
            </Button>
          </div>
        </motion.div>
      </MarketingSection>

      <HairlineRule />

      {/* Capabilities */}
      <section className="py-16 sm:py-24 bg-paper">
        <div className="container mx-auto px-4 sm:px-6 lg:px-8">
          <div className="text-center mb-14">
            <h2 className="text-3xl sm:text-4xl font-bold text-ink mb-4">
              One reporter. Every audience.
            </h2>
            <p className="text-xl text-ink-2 max-w-3xl mx-auto">
              Asset owners, O&M contractors, investors, and regulators all look at the
              same plant through different lenses. The reporter adapts to each.
            </p>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6 max-w-6xl mx-auto">
            {capabilities.map((cap, i) => (
              <motion.div
                key={cap.title}
                className="rounded bg-paper border border-divider p-6 shadow-sm hover:shadow-sm transition-shadow"
                initial={{ opacity: 0, y: 20 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true }}
                transition={{ delay: i * 0.08 }}
              >
                <div className="inline-flex p-3 rounded-lg bg-blue-50 mb-4">
                  <cap.icon className="w-6 h-6 text-primary" />
                </div>
                <h3 className="text-lg font-bold text-ink mb-2">{cap.title}</h3>
                <p className="text-ink-2 text-sm leading-relaxed">{cap.description}</p>
              </motion.div>
            ))}
          </div>
        </div>
      </section>

      {/* Widget library */}
      <section className="py-16 sm:py-24 bg-paper-2">
        <div className="container mx-auto px-4 sm:px-6 lg:px-8">
          <div className="max-w-5xl mx-auto">
            <div className="text-center mb-10">
              <h2 className="text-3xl sm:text-4xl font-bold text-ink mb-4">
                Widget library
              </h2>
              <p className="text-xl text-ink-2">
                Every widget is live, scoped, and styled for print.
              </p>
            </div>

            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3">
              {widgets.map((w, i) => (
                <motion.div
                  key={w}
                  className="rounded-lg bg-paper border border-divider px-4 py-3 text-sm font-semibold text-ink text-center"
                  initial={{ opacity: 0, scale: 0.95 }}
                  whileInView={{ opacity: 1, scale: 1 }}
                  viewport={{ once: true }}
                  transition={{ delay: i * 0.03 }}
                >
                  {w}
                </motion.div>
              ))}
            </div>

            <p className="text-center text-sm text-ink-3 mt-6">
              New widgets added regularly. Have a specific one in mind? Ask us.
            </p>
          </div>
        </div>
      </section>

      {/* Lifecycle */}
      <section className="py-16 sm:py-24 bg-paper">
        <div className="container mx-auto px-4 sm:px-6 lg:px-8">
          <div className="max-w-4xl mx-auto">
            <div className="text-center mb-12">
              <h2 className="text-3xl sm:text-4xl font-bold text-ink mb-4">
                Build → Share → Schedule
              </h2>
            </div>

            <div className="space-y-4">
              <div className="rounded border border-divider p-6 bg-paper">
                <div className="flex items-start gap-4">
                  <div className="flex-shrink-0 w-8 h-8 rounded-full bg-primary text-white font-bold text-sm flex items-center justify-center">
                    1
                  </div>
                  <div>
                    <h3 className="text-lg font-bold text-ink mb-1">Build</h3>
                    <p className="text-ink-2">
                      Drop widgets onto a grid. Set the time range and the scope once, every widget respects it unless you override. Save with a title and
                      a slug.
                    </p>
                  </div>
                </div>
              </div>

              <div className="rounded border border-divider p-6 bg-paper">
                <div className="flex items-start gap-4">
                  <div className="flex-shrink-0 w-8 h-8 rounded-full bg-primary text-white font-bold text-sm flex items-center justify-center">
                    2
                  </div>
                  <div>
                    <h3 className="text-lg font-bold text-ink mb-1">
                      Share, publicly or privately
                    </h3>
                    <p className="text-ink-2 mb-3">
                      A <Share2 className="inline w-4 h-4 mx-0.5" /> click creates a
                      public URL like{' '}
                      <code className="bg-paper-2 px-1.5 py-0.5 rounded text-sm">
                        /r/&lt;token&gt;
                      </code>
                      . Recipients see a chrome-free, read-only view. Rotate or revoke
                      the token whenever you want.
                    </p>
                    <p className="text-ink-2">
                      <Lock className="inline w-4 h-4 mx-0.5 text-ink-3" /> Prefer to
                      keep it internal? Skip sharing and just send the URL to a logged-in
                      teammate.
                    </p>
                  </div>
                </div>
              </div>

              <div className="rounded border border-divider p-6 bg-paper">
                <div className="flex items-start gap-4">
                  <div className="flex-shrink-0 w-8 h-8 rounded-full bg-primary text-white font-bold text-sm flex items-center justify-center">
                    3
                  </div>
                  <div>
                    <h3 className="text-lg font-bold text-ink mb-1">
                      Schedule PDF delivery
                    </h3>
                    <p className="text-ink-2">
                      <Mail className="inline w-4 h-4 mx-0.5 text-ink-3" /> Pick a
                      cadence and recipients. On each run, the platform renders the
                      dashboard in headless Chrome, PDFs it, and emails it out. No drift,
                      no copy-paste, no manually compiled monthly reports.
                    </p>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      <HairlineRule />

      {/* CTA */}
      <MarketingSection size="default">
        <div className="max-w-3xl">
          <div className="font-mono text-meta uppercase tracking-[0.08em] text-ink-3 mb-3">
            Try it
          </div>
          <h2 className="text-h1 font-semibold text-ink mb-4">
            Click around a few sample reports.
          </h2>
          <p className="text-body text-ink-2 mb-8 max-w-2xl">
            Our public showcase includes three hand-built dashboards, plant-level PV,
            fleet-level wind health, and a 2-plant portfolio roll-up.
          </p>
          <div className="flex flex-col sm:flex-row flex-wrap gap-3">
            <Button size="lg" asChild>
              <Link href="/showcase/reports">
                See the sample reports
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
