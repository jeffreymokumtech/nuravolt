'use client';

import Link from 'next/link';
import { ArrowUpRight } from 'lucide-react';
import { motion } from 'framer-motion';
import { DataPanel } from '@/components/ui/DataPanel';
import { KPIReadout } from '@/components/ui/KPIReadout';
import { Sparkline } from '@/components/ui/Sparkline';
import { MarketingSection } from '@/components/ui/MarketingSection';

/**
 * Live-showcase ticker strip, paired NIMBUS (BESS) + HELIOS (PV) snapshots
 * pulled from the showcase fixtures. Doubles as proof-of-life and product
 * hook. Each row clicks through to its full /showcase/plant/{id} dashboard.
 *
 * KPIs and sparkline series here are fixture-driven, intentionally matching
 * the values rendered on the showcase pages. We don't fetch the API at
 * render time, the marketing surface is paper-static and the showcase
 * page is the live one.
 */

interface ShowcaseTicker {
  slug: string;
  type: 'BESS' | 'PV';
  plantId: string;
  asset: string;
  region: string;
  kpis: { value: string; label: string; signal?: 'positive' | 'warning' | 'critical' | 'neutral' }[];
  sparkline: number[];
  sparkSignal: 'positive' | 'warning' | 'critical' | 'neutral';
  sparkLabel: string;
  updatedAgo: string;
}

const TICKERS: ShowcaseTicker[] = [
  {
    slug: 'nimbus',
    type: 'BESS',
    plantId: 'NIMBUS-01',
    asset: '100 MW / 200 MWh · LFP',
    region: 'United Kingdom',
    kpis: [
      { value: '91.4', label: 'SoH %', signal: 'warning' },
      { value: '86.1', label: 'RTE %', signal: 'positive' },
      { value: '412', label: 'equiv. cycles' },
    ],
    sparkline: [98, 97.6, 97.2, 96.8, 96.3, 95.9, 95.4, 94.8, 94.2, 93.7, 93.2, 92.8, 92.4, 91.9, 91.6, 91.4],
    sparkSignal: 'warning',
    sparkLabel: 'SoH · 16 wk',
    updatedAgo: '4 min ago',
  },
  {
    slug: 'helios',
    type: 'PV',
    plantId: 'HELIOS-01',
    asset: '30 MW · monocrystalline',
    region: 'Spain',
    kpis: [
      { value: '96.0', label: 'soiling ratio %', signal: 'positive' },
      { value: '€427/d', label: 'loss if not cleaned', signal: 'warning' },
      { value: '14 d', label: 'optimal cleaning window' },
    ],
    sparkline: [99.4, 99.2, 99.0, 98.7, 98.4, 98.1, 97.8, 97.5, 97.2, 96.9, 96.6, 96.4, 96.2, 96.1, 96.0, 96.0],
    sparkSignal: 'positive',
    sparkLabel: 'soiling · 30 d',
    updatedAgo: '6 min ago',
  },
];

export default function LiveShowcaseTickerStrip() {
  return (
    <MarketingSection size='compact' surface='paper-2'>
      <div className='flex items-end justify-between mb-6 max-w-6xl mx-auto'>
        <div>
          <div className='font-mono text-meta uppercase tracking-[0.08em] text-ink-3 mb-2'>
            Showcase plants · live fixtures
          </div>
          <h2 className='text-h2 font-semibold text-ink'>
            See the platform on real assets
          </h2>
        </div>
        <Link
          href='/showcase'
          className='font-mono text-meta uppercase tracking-[0.08em] text-primary hover:underline hidden md:inline-flex items-center gap-1'
        >
          All showcase plants
          <ArrowUpRight className='w-3 h-3' />
        </Link>
      </div>

      <div className='grid grid-cols-1 lg:grid-cols-2 gap-5 max-w-6xl mx-auto'>
        {TICKERS.map((t, idx) => (
          <motion.div
            key={t.slug}
            initial={{ opacity: 0, y: 12 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }}
            transition={{ delay: idx * 0.1, duration: 0.4 }}
          >
            <Link
              href={`/showcase/plant/${t.slug}`}
              className='block group focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-sm'
            >
              <DataPanel
                headerLeft={`${t.type} · ${t.plantId} · ${t.asset}`}
                headerRight={t.region}
                live
                footer={
                  <div className='flex items-center justify-between'>
                    <span>Updated {t.updatedAgo}</span>
                    <span className='inline-flex items-center gap-1 text-data-fg group-hover:underline'>
                      View dashboard
                      <ArrowUpRight className='w-3 h-3' />
                    </span>
                  </div>
                }
                innerClassName='p-5'
              >
                <div className='grid grid-cols-3 gap-4 mb-5'>
                  {t.kpis.map((kpi, kIdx) => (
                    <KPIReadout
                      key={kpi.label}
                      value={kpi.value}
                      label={kpi.label}
                      signal={kpi.signal}
                      tone='data'
                      size='md'
                      delay={0.2 + kIdx * 0.1}
                    />
                  ))}
                </div>
                <div className='flex items-end justify-between gap-3'>
                  <Sparkline values={t.sparkline} signal={t.sparkSignal} width={360} height={48} className='flex-1 max-w-full' />
                  <div className='font-mono text-meta uppercase tracking-[0.08em] text-data-fg-2 whitespace-nowrap'>
                    {t.sparkLabel}
                  </div>
                </div>
              </DataPanel>
            </Link>
          </motion.div>
        ))}
      </div>
    </MarketingSection>
  );
}
