'use client';

import { useRef, useState, type KeyboardEvent } from 'react';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { motion, AnimatePresence } from 'framer-motion';
import { ArrowRight, ArrowDown } from 'lucide-react';
import Image from 'next/image';
import { DataPanel } from '@/components/ui/DataPanel';
import { KPIReadout } from '@/components/ui/KPIReadout';
import { MarketingSection } from '@/components/ui/MarketingSection';
import { goToLeadForm } from './leadFormIntent';

/**
 * HeroSection, agent-first: Shams (the AI agent) leads, and the BESS↔PV
 * tablist below is the proof section, the depth a thin "agent" page can't
 * show. BESS stays the default tab; no auto-rotation (auto-swapping content
 * mid-read is hostile to readers).
 *
 * Copy rules: sentence case, no em/en dashes, no emoji, no invented metrics.
 * The "fifteen tools" stat is grounded in the MCP catalogue
 * (src/app/mcp/_components/catalogue.ts).
 */

const HERO_VARIANTS = [
  {
    id: 'bess' as const,
    label: 'BESS',
    trustPill: 'Continuous BESS analytics · one-off audits · data integration',
    headline: 'Continuous SoH, equivalent-cycle accounting, and warranty defense, on your live data.',
    highlight: 'Or get a one-off audit.',
    sub: 'Plug NuraVolt into your live SCADA, BMS, and inverter data. Track SoH trajectory, equivalent-cycle accounting, degradation-aware dispatch, and CSRD-ready evidence, every day. Prefer a fixed-scope diagnostic first? We run those too.',
    stats: [
      { value: 'Daily', label: 'SoH + equivalent-cycle accounting' },
      { value: '€/cycle', label: 'Degradation costed per arbitrage cycle' },
      { value: 'CSRD', label: 'Battery Regulation evidence baked in' },
    ],
    ctaPrimary: { label: 'Start continuous monitoring', intent: 'monitoring' as const },
    ctaSecondary: { label: 'Or get a one-off audit', intent: 'audit' as const },
    foundationLink: 'Plant under 20 MW or no SCADA? See Data Foundation →',
    pricingLine: 'Monitoring · Audit · Data Foundation, scoped to your plant',
    screenshot: {
      src: '/images/screenshots/bess-nimbus-overview.png',
      alt: 'NuraVolt BESS Intelligence dashboard, Nimbus Storage, LFP, 100 MW / 200 MWh, warranty health and SoH trajectory',
      panelHeader: 'NIMBUS · 100MW/200MWh · LFP · UK',
      panelMeta: 'nuravolt.com/plant/nimbus',
    },
  },
  {
    id: 'pv' as const,
    label: 'PV',
    trustPill: 'Continuous PV monitoring · one-off audits · data integration',
    headline: 'Continuous soiling, fault detection, and €/day loss tracking, on your live data.',
    highlight: 'Or get a one-off audit.',
    sub: 'Plug NuraVolt into your inverters, SCADA, or CSV exports. 365-day soiling forecasts, predictive fault detection, ROI-priced cleaning, every day. Prefer a fixed-scope Plant Performance Audit first? We run those too.',
    stats: [
      { value: 'Daily', label: 'Soiling ratio + fault sweep' },
      { value: '3-8%', label: 'Annual revenue typically recoverable' },
      { value: '€/day', label: 'Loss quantified per fault' },
    ],
    ctaPrimary: { label: 'Start continuous monitoring', intent: 'monitoring' as const },
    ctaSecondary: { label: 'Or get a one-off audit', intent: 'audit' as const },
    foundationLink: 'Plant under 20 MW or no SCADA? See Data Foundation →',
    pricingLine: 'Monitoring · Audit · Data Foundation, scoped to your plant',
    screenshot: {
      src: '/images/screenshots/soiling-intelligence.png',
      alt: 'NuraVolt PV Intelligence dashboard, Helios, soiling ratio 96.0%, 30-day ML forecast and cleaning optimisation',
      panelHeader: 'HELIOS · 30MW · SPAIN',
      panelMeta: 'nuravolt.com/plant/helios',
    },
  },
] as const;

type HeroVariantId = (typeof HERO_VARIANTS)[number]['id'];

const HeroSection = () => {
  const containerRef = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState<HeroVariantId>('bess');
  const variant = HERO_VARIANTS.find((v) => v.id === active)!;

  const handleTabKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    const idx = HERO_VARIANTS.findIndex((v) => v.id === active);
    const next =
      e.key === 'ArrowRight'
        ? HERO_VARIANTS[(idx + 1) % HERO_VARIANTS.length]
        : HERO_VARIANTS[(idx - 1 + HERO_VARIANTS.length) % HERO_VARIANTS.length];
    setActive(next.id);
  };

  return (
    <MarketingSection size='hero' surface='paper'>
      <div ref={containerRef}>
        {/* Agent-first lead: Shams above the asset-class proof section. */}
        <div className='mb-14 max-w-3xl'>
          <div className='font-mono text-meta uppercase tracking-[0.08em] text-ink-3 mb-5'>
            Shams AI agent · continuous monitoring · one-off audits
          </div>
          <h1 className='text-h1 sm:text-display font-semibold text-ink mb-6 text-balance'>
            Meet Shams.{' '}
            <span className='text-ink-2 font-normal'>
              The AI agent that runs solar and storage operations with you.
            </span>
          </h1>
          <p className='text-body text-ink-2 mb-8 max-w-2xl text-balance'>
            Shams works on your live SCADA, inverter, and battery data. It explains faults in
            plain language, forecasts soiling, tracks battery health, and drafts the tickets and
            cleaning plans your team approves. Nothing ships without your sign off.
          </p>
          <div className='grid grid-cols-3 gap-8 mb-8 border-t border-b border-divider py-6'>
            <KPIReadout value='Live' label='Answers grounded in your plant data' size='md' delay={0.1} />
            <KPIReadout value='Fifteen' label='Fleet tools Shams can call' size='md' delay={0.2} />
            <KPIReadout value='Fixed' label='Monthly price with the agent included' size='md' delay={0.3} />
          </div>
          <div className='flex flex-col sm:flex-row flex-wrap gap-3'>
            <Button size='lg' asChild>
              <Link href='/agent'>
                See Shams in action
                <ArrowRight className='w-4 h-4 ml-2' />
              </Link>
            </Button>
            <Button size='lg' variant='outline' onClick={() => goToLeadForm('monitoring')}>
              Talk to us about your fleet
            </Button>
          </div>
        </div>

        {/* Asset-class tabs, BESS leading, PV one click away */}
        <div
          role='tablist'
          aria-label='Choose asset class'
          onKeyDown={handleTabKeyDown}
          className='inline-flex items-center gap-1 mb-8 p-1 rounded-sm border border-divider bg-paper'
        >
          {HERO_VARIANTS.map((v) => {
            const isActive = v.id === active;
            return (
              <button
                key={v.id}
                role='tab'
                id={`hero-tab-${v.id}`}
                aria-selected={isActive}
                aria-controls='hero-panel'
                tabIndex={isActive ? 0 : -1}
                onClick={() => setActive(v.id)}
                className={`px-4 py-1.5 font-mono text-meta uppercase tracking-[0.08em] rounded-sm transition-colors ${
                  isActive
                    ? 'bg-ink text-paper'
                    : 'text-ink-3 hover:text-ink'
                }`}
              >
                {v.label}
              </button>
            );
          })}
        </div>

        <div
          role='tabpanel'
          id='hero-panel'
          aria-labelledby={`hero-tab-${active}`}
          className='grid grid-cols-1 lg:grid-cols-2 gap-12 items-center'
        >
          {/* Left: Text Content (swaps per variant) */}
          <AnimatePresence mode='wait'>
            <motion.div
              key={`text-${active}`}
              initial={{ opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -12 }}
              transition={{ duration: 0.25, ease: 'easeOut' }}
              className='text-left'
            >
              <div className='font-mono text-meta uppercase tracking-[0.08em] text-ink-3 mb-5'>
                {variant.trustPill}
              </div>

              {/* h2: the Shams block above carries the page's single h1. */}
              <h2 className='text-h1 font-semibold text-ink mb-6 text-balance'>
                {variant.headline}{' '}
                <span className='text-ink-2 font-normal'>{variant.highlight}</span>
              </h2>

              <p className='text-body text-ink-2 mb-10 max-w-xl text-balance'>{variant.sub}</p>

              {/* Trust stats, mono KPIReadouts, hairline-divided */}
              <div className='grid grid-cols-3 gap-8 mb-10 border-t border-b border-divider py-6'>
                {variant.stats.map((stat, idx) => (
                  <KPIReadout
                    key={stat.label}
                    value={stat.value}
                    label={stat.label}
                    size='md'
                    delay={0.1 + idx * 0.1}
                  />
                ))}
              </div>

              {/* CTA Buttons */}
              <div className='flex flex-col sm:flex-row flex-wrap gap-3'>
                <Button size='lg' onClick={() => goToLeadForm(variant.ctaPrimary.intent)}>
                  {variant.ctaPrimary.label}
                  <ArrowRight className='w-4 h-4 ml-2' />
                </Button>
                <Button
                  size='lg'
                  variant='outline'
                  onClick={() => goToLeadForm(variant.ctaSecondary.intent)}
                >
                  {variant.ctaSecondary.label}
                </Button>
              </div>

              <a
                href='#data-foundation'
                className='mt-4 inline-flex items-center gap-1.5 font-mono text-meta uppercase tracking-[0.08em] text-ink-3 hover:text-ink'
              >
                {variant.foundationLink}
                <ArrowDown className='w-3 h-3' />
              </a>

              <p className='mt-5 font-mono text-meta uppercase tracking-[0.08em] text-ink-3'>
                {variant.pricingLine}
              </p>
            </motion.div>
          </AnimatePresence>

          {/* Right: Product Screenshot (swaps per variant) */}
          <AnimatePresence mode='wait'>
            <motion.div
              key={`screenshot-${active}`}
              initial={{ opacity: 0, x: 30 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: -30 }}
              transition={{ duration: 0.3, ease: 'easeOut' }}
            >
              <DataPanel
                headerLeft={variant.screenshot.panelHeader}
                headerRight={variant.screenshot.panelMeta}
                live
                scanline
              >
                <div className='relative aspect-[16/10] w-full'>
                  <Image
                    src={variant.screenshot.src}
                    alt={variant.screenshot.alt}
                    fill
                    className='object-cover object-top'
                    sizes='(max-width: 768px) 100vw, 50vw'
                    priority={active === 'bess'}
                  />
                </div>
              </DataPanel>
            </motion.div>
          </AnimatePresence>
        </div>
      </div>
    </MarketingSection>
  );
};

export default HeroSection;
