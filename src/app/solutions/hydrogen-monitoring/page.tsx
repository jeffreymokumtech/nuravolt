'use client';

import {
  Atom,
  Euro,
  Gauge,
  HeartPulse,
  LineChart,
  Timer,
  Zap,
} from 'lucide-react';
import SolutionHero from '@/components/solutions/SolutionHero';
import SolutionCTA from '@/components/solutions/SolutionCTA';
import { MarketingSection } from '@/components/ui/MarketingSection';
import { HairlineRule } from '@/components/ui/HairlineRule';

/**
 * Green-hydrogen (electrolyzer) analytics. Honest about maturity: the module
 * ships electrolyzer physics, price-responsive production economics and
 * stack-health tracking; claims stay at the physics level (no invented
 * customer results).
 */
export default function HydrogenMonitoringPage() {
  const features = [
    {
      icon: Gauge,
      title: 'Electrolyzer efficiency tracking',
      description:
        'System specific energy consumption (kWh/kg) tracked against beginning-of-life, with the part-load curve modeled — so drift shows up as money, not just a number.',
    },
    {
      icon: HeartPulse,
      title: 'Stack health & remaining life',
      description:
        'SEC drift per 1,000 operating hours mapped to the industry +10% end-of-life convention. Know the replacement year before it surprises your OPEX plan.',
    },
    {
      icon: Euro,
      title: 'Price-responsive production economics',
      description:
        'Daily production margin — merchant H2 revenue against the actual power bill on real day-ahead prices — with the cheap-hours operating strategy made explicit.',
    },
    {
      icon: Zap,
      title: 'Power-to-hydrogen opportunity',
      description:
        'For hybrid sites: what your curtailed PV would be worth as hydrogen instead of being thrown away, computed from your own clip data.',
    },
    {
      icon: LineChart,
      title: 'Day-ahead price integration',
      description:
        'ENTSO-E / energy-charts day-ahead curves drive the economics per bidding zone — the same price engine our BESS dispatch analytics use.',
    },
    {
      icon: Timer,
      title: 'One console for hybrid plants',
      description:
        'Electrolyzers live next to your PV, wind and storage assets in the same fleet view, alerts engine and reporting stack.',
    },
  ];

  return (
    <div>
      <SolutionHero
        asset="hydrogen"
        eyebrow="Green hydrogen · electrolyzer analytics"
        headline="Track electrolyzer efficiency, stack life and production economics in one console."
        highlight="Built on electrolyzer physics, not dashboards-only."
        sub="PEM and alkaline systems drift — specific energy consumption creeps up, margins depend on when you run, and stack replacement is the cost that decides the business case. NuraVolt tracks all three against real day-ahead power prices."
        stats={[
          { value: 'kWh/kg', label: 'SEC tracked vs beginning-of-life' },
          { value: '+10% SEC', label: 'End-of-life convention for stack RUL' },
          { value: 'Real prices', label: 'ENTSO-E / energy-charts day-ahead' },
        ]}
        primaryCta={{ label: 'Talk to us about hydrogen', intent: 'monitoring' }}
        secondaryCta={{ label: 'Or scope a data audit', intent: 'audit' }}
        screenshot={{
          src: '/images/screenshots/hydrogen-console.png',
          alt: 'NuraVolt hydrogen console: electrolyzer production, economics and stack health',
          panelHeader: 'IBERIA-H2 · 5MW PEM · H2',
          panelMeta: 'nuravolt.com/plant/iberia-h2',
        }}
      />

      <HairlineRule />

      <MarketingSection size="default">
        <div className="max-w-3xl">
          <p className="text-sm font-semibold uppercase tracking-wide text-emerald-600 mb-3">
            Why electrolyzer analytics
          </p>
          <h2 className="text-3xl font-bold tracking-tight mb-4">
            The stack is the battery of hydrogen — treat it like one.
          </h2>
          <p className="text-lg opacity-80">
            An electrolyzer&apos;s specific energy consumption rises with every operating
            hour. Left unwatched, that drift silently erodes margin until the stack
            replacement lands as a surprise. The same discipline we apply to battery
            state-of-health — measure, project, price — applies to stacks: track SEC
            against beginning-of-life, project the end-of-life crossing, and run the
            machine in the hours where power is cheapest.
          </p>
        </div>
      </MarketingSection>

      <HairlineRule />

      <MarketingSection id="features" size="default" surface="paper-2">
        <div className="mb-10">
          <h2 className="text-3xl font-bold tracking-tight">What the module does</h2>
        </div>
        <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-3">
          {features.map(({ icon: Icon, title, description }) => (
            <div key={title} className="rounded-xl border border-gray-200 bg-white p-6 shadow-sm">
              <Icon className="mb-3 h-6 w-6 text-emerald-600" />
              <h3 className="mb-1.5 font-semibold text-gray-900">{title}</h3>
              <p className="text-sm text-gray-600">{description}</p>
            </div>
          ))}
        </div>
      </MarketingSection>

      <HairlineRule />

      <MarketingSection size="default">
        <div className="max-w-3xl">
          <div className="mb-3 flex items-center gap-2">
            <Atom className="h-5 w-5 text-emerald-600" />
            <p className="text-sm font-semibold uppercase tracking-wide text-emerald-600">
              Early-access module
            </p>
          </div>
          <h2 className="text-2xl font-bold tracking-tight mb-3">
            Honest about where this is
          </h2>
          <p className="opacity-80">
            The hydrogen module is our newest asset class. The physics layer —
            part-load efficiency curves, SEC drift, stack RUL — and the economics
            engine are live today on Business and Enterprise plans; deep vendor
            telemetry integrations are rolling out with early-access partners. If you
            operate an electrolyzer (or plan to pair one with PV), we&apos;d like to
            build against your data.
          </p>
        </div>
      </MarketingSection>

      <SolutionCTA
        eyebrow="Early access"
        heading="Put your electrolyzer next to your PV and storage."
        sub="One platform for the whole hybrid plant: production economics on real prices, stack health with a replacement horizon, and the same alerting and reporting stack your other assets already use."
        primary={{ label: 'Talk to us about hydrogen', intent: 'monitoring' }}
        secondary={{ label: 'Explore BESS Analytics →', href: '/solutions/bess-monitoring' }}
      />
    </div>
  );
}
