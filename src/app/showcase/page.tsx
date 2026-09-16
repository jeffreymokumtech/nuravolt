'use client';

import Link from 'next/link';
import {
  ArrowRight,
  Battery,
  Cloud,
  FileText,
  LayoutDashboard,
  Sun,
  Wind,
  Zap,
} from 'lucide-react';

/**
 * Showcase landing page.
 *
 * Sets expectations (this is sample data, not live) and hands visitors off to
 * the two plant surfaces + the reports hub. Deliberately short, the product
 * is the demo itself, not this page.
 */
export default function ShowcaseLandingPage() {
  return (
    <div className="mx-auto max-w-[1400px] px-4 sm:px-6 py-10">
      {/* Hero */}
      <section className="rounded-2xl bg-gradient-to-br from-blue-600 via-indigo-600 to-purple-700 text-white p-8 sm:p-12 mb-10">
        <div className="max-w-3xl">
          <div className="inline-flex items-center gap-2 px-3 py-1 bg-white/10 backdrop-blur rounded-full text-sm font-medium mb-6">
            <Zap className="w-4 h-4" />
            Live Demo · Sample Data
          </div>
          <h1 className="text-3xl sm:text-4xl lg:text-5xl font-bold mb-4">
            Click through the platform.
          </h1>
          <p className="text-lg sm:text-xl text-blue-100 mb-6 leading-relaxed">
            Two anonymised plants. Real workflows. Every chart, alert, and report is the
            same code running for paying customers, just with scrubbed sample data you
            can share.
          </p>
          <div className="flex flex-wrap gap-3">
            <Link
              href="/showcase/portfolio"
              className="inline-flex items-center gap-2 bg-white text-blue-700 px-5 py-2.5 rounded-lg font-semibold hover:bg-gray-50"
            >
              Open the portfolio <ArrowRight className="w-4 h-4" />
            </Link>
            <Link
              href="/showcase/reports"
              className="inline-flex items-center gap-2 bg-white/10 backdrop-blur border border-white/20 text-white px-5 py-2.5 rounded-lg font-semibold hover:bg-white/20"
            >
              See sample reports
            </Link>
          </div>
        </div>
      </section>

      {/* Plant cards */}
      <section className="mb-10">
        <h2 className="text-xl font-bold text-ink mb-4">Plants in this demo</h2>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
          <Link
            href="/showcase/plant/helios"
            className="group rounded-xl bg-white border border-divider p-6 hover:shadow-md hover:border-blue-300 transition"
          >
            <div className="flex items-start justify-between mb-3">
              <div className="flex items-center gap-3">
                <div className="p-2.5 rounded-lg bg-signal-warning/10">
                  <Sun className="w-6 h-6 text-signal-warning" />
                </div>
                <div>
                  <h3 className="text-lg font-bold text-ink">Helios PV</h3>
                  <p className="text-sm text-ink-3">
                    45 MW · Southern Europe · with co-located BESS
                  </p>
                </div>
              </div>
              <ArrowRight className="w-5 h-5 text-ink-3 group-hover:text-blue-600 group-hover:translate-x-0.5 transition" />
            </div>
            <div className="grid grid-cols-2 gap-3 mt-5">
              <div className="rounded-lg bg-signal-warning/10 px-3 py-2">
                <div className="text-xs text-signal-warning font-semibold">Performance</div>
                <div className="text-sm font-bold text-ink">PR 83.9%</div>
              </div>
              <div className="rounded-lg bg-blue-50 px-3 py-2">
                <div className="text-xs text-blue-700 font-semibold">Availability</div>
                <div className="text-sm font-bold text-ink">99.2%</div>
              </div>
              <div className="rounded-lg bg-signal-critical/10 px-3 py-2">
                <div className="text-xs text-signal-critical font-semibold">At Risk</div>
                <div className="text-sm font-bold text-ink">€142.5k</div>
              </div>
              <div className="rounded-lg bg-purple-50 px-3 py-2">
                <div className="text-xs text-purple-700 font-semibold">BESS</div>
                <div className="text-sm font-bold text-ink">Co-located</div>
              </div>
            </div>
            <div className="mt-5 flex flex-wrap gap-1.5 text-xs text-ink-3">
              <span className="rounded-full bg-paper-2 px-2 py-0.5">Soiling</span>
              <span className="rounded-full bg-paper-2 px-2 py-0.5">Fault Detection</span>
              <span className="rounded-full bg-paper-2 px-2 py-0.5">Digital Twin</span>
              <span className="rounded-full bg-paper-2 px-2 py-0.5">BESS SoH</span>
              <span className="rounded-full bg-paper-2 px-2 py-0.5">Reporting</span>
            </div>
          </Link>

          <Link
            href="/showcase/plant/zephyr"
            className="group rounded-xl bg-white border border-divider p-6 hover:shadow-md hover:border-emerald-300 transition"
          >
            <div className="flex items-start justify-between mb-3">
              <div className="flex items-center gap-3">
                <div className="p-2.5 rounded-lg bg-signal-positive/10">
                  <Wind className="w-6 h-6 text-signal-positive" />
                </div>
                <div>
                  <h3 className="text-lg font-bold text-ink">Zephyr Wind</h3>
                  <p className="text-sm text-ink-3">20 MW · Northern Europe · onshore</p>
                </div>
              </div>
              <ArrowRight className="w-5 h-5 text-ink-3 group-hover:text-emerald-600 group-hover:translate-x-0.5 transition" />
            </div>
            <div className="grid grid-cols-2 gap-3 mt-5">
              <div className="rounded-lg bg-signal-positive/10 px-3 py-2">
                <div className="text-xs text-signal-positive font-semibold">Performance</div>
                <div className="text-sm font-bold text-ink">PR 91.2%</div>
              </div>
              <div className="rounded-lg bg-blue-50 px-3 py-2">
                <div className="text-xs text-blue-700 font-semibold">Availability</div>
                <div className="text-sm font-bold text-ink">97.8%</div>
              </div>
              <div className="rounded-lg bg-signal-critical/10 px-3 py-2">
                <div className="text-xs text-signal-critical font-semibold">At Risk</div>
                <div className="text-sm font-bold text-ink">€48.9k</div>
              </div>
              <div className="rounded-lg bg-paper px-3 py-2">
                <div className="text-xs text-ink-2 font-semibold">Turbines</div>
                <div className="text-sm font-bold text-ink">10 × 2 MW</div>
              </div>
            </div>
            <div className="mt-5 flex flex-wrap gap-1.5 text-xs text-ink-3">
              <span className="rounded-full bg-paper-2 px-2 py-0.5">Turbine Health</span>
              <span className="rounded-full bg-paper-2 px-2 py-0.5">Power Curve</span>
              <span className="rounded-full bg-paper-2 px-2 py-0.5">RUL</span>
              <span className="rounded-full bg-paper-2 px-2 py-0.5">Fault Detection</span>
            </div>
          </Link>
        </div>
      </section>

      {/* What's inside */}
      <section className="mb-10">
        <h2 className="text-xl font-bold text-ink mb-4">What you can click through</h2>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
          {[
            {
              icon: Cloud,
              title: 'Soiling Intelligence',
              detail: '365-day forecast, DustIQ trend, cleaning schedule optimizer.',
            },
            {
              icon: Zap,
              title: 'Digital Twin',
              detail: 'Expected vs measured per inverter, MPPT, and string.',
            },
            {
              icon: Battery,
              title: 'BESS Health',
              detail: 'SoH history, dispatch plan, warranty terms and margin.',
            },
            {
              icon: LayoutDashboard,
              title: 'Reports',
              detail: 'Three pre-built sample dashboards. Read-only.',
            },
          ].map((c) => (
            <div key={c.title} className="rounded-xl bg-white border border-divider p-4">
              <div className="flex items-center gap-2 mb-2">
                <c.icon className="w-4 h-4 text-blue-600" />
                <span className="text-sm font-bold text-ink">{c.title}</span>
              </div>
              <p className="text-xs text-ink-2 leading-relaxed">{c.detail}</p>
            </div>
          ))}
        </div>
      </section>

      {/* Sample data notice */}
      <section className="rounded-xl border border-signal-warning/20 bg-signal-warning/10 p-5 flex items-start gap-4">
        <FileText className="w-5 h-5 text-signal-warning flex-shrink-0 mt-0.5" />
        <div className="text-sm text-signal-warning leading-relaxed">
          <strong>Everything you see is sample data.</strong> The plants, locations, and
          inverter numbers are anonymised. The workflows, charts, and report layouts are
          identical to what the platform runs for real customers, only the identifiers
          have been swapped. Feel free to share this URL.
        </div>
      </section>
    </div>
  );
}
