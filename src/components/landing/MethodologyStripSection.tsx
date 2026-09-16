'use client';

import { motion } from 'framer-motion';
import { ArrowRight, FileSpreadsheet, ServerCog } from 'lucide-react';
import Link from 'next/link';
import { DataPanel } from '@/components/ui/DataPanel';
import { KPIReadout } from '@/components/ui/KPIReadout';
import { MarketingSection } from '@/components/ui/MarketingSection';
import { Sparkline } from '@/components/ui/Sparkline';

/**
 * MethodologyStripSection, replaces the templated "Connect → Analyze → Act"
 * three-circle block. One real data flow, illustrated on one panel:
 *
 *   1. Ingest  →  2. Annotate the chart  →  3. Quantify the recommendation
 *
 * The middle panel shows a 30-day soiling ratio with a labelled cleaning
 * inflection. The recommendation card prices the loss in €/day, which is
 * the language the rest of the site is in.
 */

// Synthetic 30-day soiling-ratio series with a cleaning event around day 18.
// Values match the homepage Helios fixture for visual continuity.
const SOILING_SERIES = [
  99.6, 99.4, 99.1, 98.8, 98.6, 98.2, 97.9, 97.5, 97.1, 96.7,
  96.3, 95.8, 95.4, 95.0, 94.5, 94.1, 93.7, 93.4,
  // cleaning event ↑
  99.4, 99.3, 99.2, 99.0, 98.8, 98.5, 98.2, 97.9, 97.5, 97.2, 96.8, 96.4,
];

const CLEANING_EVENT_INDEX = 18;

export default function MethodologyStripSection() {
  return (
    <MarketingSection size='default'>
      <div className='max-w-3xl mb-10'>
        <div className='font-mono text-meta uppercase tracking-[0.08em] text-ink-3 mb-3'>
          Methodology · one real flow
        </div>
        <h2 className='text-h1 font-semibold text-ink mb-4'>
          From your data stream to a priced recommendation, in one panel
        </h2>
        <p className='text-body text-ink-2'>
          Every engagement runs the same loop: ingest your data, annotate the
          chart where money is leaking, and price the recommendation in €/day
          so the finance team can read it. Continuous on monitoring; a
          one-shot pass on a fixed-scope audit. No black-box scoring.
        </p>
      </div>

      <div className='grid grid-cols-1 lg:grid-cols-12 gap-5 items-stretch'>
        {/* Step 1, Ingest */}
        <motion.div
          initial={{ opacity: 0, y: 12 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          transition={{ duration: 0.4 }}
          className='lg:col-span-3 border border-divider rounded-sm p-5 bg-paper flex flex-col'
        >
          <div className='font-mono text-meta uppercase tracking-[0.08em] text-ink-3 mb-3'>
            01 · Ingest
          </div>
          <div className='flex items-center gap-2 mb-3'>
            <ServerCog className='w-4 h-4 text-ink-2' />
            <span className='font-mono text-sm text-ink'>SCADA · OPC UA</span>
          </div>
          <div className='flex items-center gap-2 mb-3'>
            <ServerCog className='w-4 h-4 text-ink-2' />
            <span className='font-mono text-sm text-ink'>BMS · Modbus TCP</span>
          </div>
          <div className='flex items-center gap-2 mb-3'>
            <FileSpreadsheet className='w-4 h-4 text-ink-2' />
            <span className='font-mono text-sm text-ink'>CSV exports</span>
          </div>
          <div className='mt-auto pt-3 border-t border-divider font-mono text-meta uppercase tracking-[0.08em] text-ink-3'>
            Whatever you have. No hardware changes.
          </div>
        </motion.div>

        {/* Step 2, Annotate the chart (DataPanel) */}
        <motion.div
          initial={{ opacity: 0, y: 12 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          transition={{ delay: 0.1, duration: 0.4 }}
          className='lg:col-span-6'
        >
          <DataPanel
            headerLeft='02 · Annotate · HELIOS · soiling ratio'
            headerRight='30 d'
            live
            innerClassName='p-5'
            footer='Cleaning event detected at day 18 · revenue impact computed automatically'
          >
            <AnnotatedSoilingChart />
          </DataPanel>
        </motion.div>

        {/* Step 3, Recommendation */}
        <motion.div
          initial={{ opacity: 0, y: 12 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          transition={{ delay: 0.2, duration: 0.4 }}
          className='lg:col-span-3 border border-divider rounded-sm p-5 bg-paper flex flex-col'
        >
          <div className='font-mono text-meta uppercase tracking-[0.08em] text-ink-3 mb-3'>
            03 · Quantify
          </div>
          <KPIReadout
            value='€427/day'
            label='uplift after cleaning'
            signal='positive'
            size='lg'
          />
          <div className='mt-4 pt-4 border-t border-divider'>
            <div className='font-mono text-meta uppercase tracking-[0.08em] text-ink-3 mb-1'>
              Recommendation
            </div>
            <p className='text-body text-ink'>
              Schedule cleaning for the east string by{' '}
              <span className='font-mono text-ink'>2026-06-14</span>. Payback in
              under 7 days at current EUR/MWh.
            </p>
          </div>
          <Link
            href='/engagements'
            className='mt-auto pt-4 inline-flex items-center gap-1 font-mono text-meta uppercase tracking-[0.08em] text-primary hover:underline'
          >
            See engagement model
            <ArrowRight className='w-3 h-3' />
          </Link>
        </motion.div>
      </div>
    </MarketingSection>
  );
}

/**
 * Annotated chart, Sparkline-style line with a vertical event marker at
 * the cleaning-event day. Lightweight inline SVG, no chart library.
 */
function AnnotatedSoilingChart() {
  const width = 520;
  const height = 160;
  const padX = 8;
  const padY = 14;
  const min = Math.min(...SOILING_SERIES);
  const max = Math.max(...SOILING_SERIES);
  const span = max - min || 1;
  const stepX = (width - padX * 2) / (SOILING_SERIES.length - 1);

  const points = SOILING_SERIES.map((v, i) => {
    const x = padX + i * stepX;
    const y = padY + (height - padY * 2) * (1 - (v - min) / span);
    return { x, y };
  });

  const path = points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(' ');
  const eventX = points[CLEANING_EVENT_INDEX].x;
  const eventY = points[CLEANING_EVENT_INDEX].y;

  return (
    <div>
      <div className='flex items-baseline justify-between mb-3'>
        <KPIReadout value='96.4' label='current soiling ratio %' tone='data' size='md' signal='positive' />
        <div className='font-mono text-meta uppercase tracking-[0.08em] text-data-fg-2'>
          Optimal cleaning · day 18 → +€427/d
        </div>
      </div>
      <svg
        width='100%'
        viewBox={`0 0 ${width} ${height}`}
        className='block'
        aria-label='30-day soiling ratio with cleaning event'
      >
        {/* Horizontal gridlines */}
        {[0.25, 0.5, 0.75].map((p) => (
          <line
            key={p}
            x1={padX}
            x2={width - padX}
            y1={padY + (height - padY * 2) * p}
            y2={padY + (height - padY * 2) * p}
            stroke='hsl(var(--data-rule))'
            strokeWidth='0.5'
            strokeDasharray='2 4'
          />
        ))}

        {/* Main soiling line */}
        <path
          d={path}
          fill='none'
          stroke='hsl(var(--signal-warning))'
          strokeWidth='1.5'
          strokeLinecap='round'
          strokeLinejoin='round'
        />

        {/* Cleaning event vertical */}
        <line
          x1={eventX}
          x2={eventX}
          y1={padY - 4}
          y2={height - padY + 4}
          stroke='hsl(var(--signal-positive))'
          strokeWidth='1'
          strokeDasharray='3 3'
        />
        <circle cx={eventX} cy={eventY} r='3' fill='hsl(var(--signal-positive))' />
        <text
          x={eventX + 6}
          y={padY + 4}
          fontSize='10'
          fontFamily='var(--font-geist-mono)'
          fill='hsl(var(--signal-positive))'
          textAnchor='start'
        >
          CLEANING
        </text>
      </svg>
    </div>
  );
}
