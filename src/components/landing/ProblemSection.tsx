'use client';

import { motion, useInView } from 'framer-motion';
import { useRef } from 'react';
import { Battery, ShieldAlert, Zap } from 'lucide-react';
import { MarketingSection } from '@/components/ui/MarketingSection';
import { Sparkline } from '@/components/ui/Sparkline';

interface BlindSpot {
  Icon: typeof Battery;
  title: string;
  metric: string;
  metricLabel: string;
  body: string;
  signal: 'positive' | 'warning' | 'critical' | 'neutral';
  sparkline: number[];
}

const BLIND_SPOTS: BlindSpot[] = [
  {
    Icon: Battery,
    title: 'The degradation blind spot',
    metric: '€1.2M/year',
    metricLabel: 'un-costed on a 100 MW / 200 MWh asset',
    body: 'Trading desks see the gross arbitrage spread. They almost never see the cost-per-cycle the battery just paid to earn it. Net revenue after degradation is a different number entirely, and the gap compounds every dispatch decision until the next capacity test reveals it.',
    signal: 'critical',
    sparkline: [12, 13, 14, 13, 15, 17, 18, 19, 20, 22, 23, 25, 26, 28, 29, 31, 33, 34, 36],
  },
  {
    Icon: ShieldAlert,
    title: 'Warranty discovered at claim time',
    metric: 'Years late',
    metricLabel: 'most violations are found during claim review',
    body: 'Equivalent-cycle caps, SoC dwell limits, C-rate envelopes, temperature windows, every OEM warranty bakes in a dozen conditions, none of which your monitoring tool tracks against the contract. By the time a claim fails, the stress events are years old and unrecoverable.',
    signal: 'warning',
    sparkline: [5, 6, 8, 9, 11, 12, 14, 17, 19, 23, 26, 30, 35, 40, 46, 53, 60, 68, 76],
  },
  {
    Icon: Zap,
    title: 'Dispatch is leaving money on the floor',
    metric: '8-15% net',
    metricLabel: 'spread vs naive arbitrage, same prices',
    body: 'The right cycle at the wrong depth or temperature can wipe out the entire margin. Degradation-aware dispatch chooses which spreads to chase based on what they actually cost the asset, quietly recovering double-digit percentages of net revenue without spending a euro on CAPEX.',
    signal: 'positive',
    sparkline: [20, 22, 21, 24, 26, 25, 28, 30, 29, 32, 34, 33, 36, 38, 37, 40, 42, 44, 46],
  },
];

const ProblemSection = () => {
  const ref = useRef(null);
  const isInView = useInView(ref, { once: true, amount: 0.2 });

  return (
    <div ref={ref}>
      <MarketingSection size='default' innerClassName='max-w-5xl mx-auto'>
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={isInView ? { opacity: 1, y: 0 } : { opacity: 0, y: 20 }}
          transition={{ duration: 0.6 }}
          className='max-w-3xl mb-12'
        >
          <div className='font-mono text-meta uppercase tracking-[0.08em] text-ink-3 mb-3'>
            The problem · BESS
          </div>
          <h2 className='text-h1 font-semibold text-ink mb-4 text-balance'>
            Three blind spots that quietly destroy battery value
          </h2>
          <p className='text-body text-ink-2 text-balance'>
            BESS operators see gross revenue. They rarely see what each megawatt-hour
            actually cost the asset, until the warranty review or the EOL test.
          </p>
        </motion.div>

        {/* Hairline-divided rows, no bordered cards */}
        <div className='border-t border-divider'>
          {BLIND_SPOTS.map((spot, idx) => {
            const { Icon } = spot;
            return (
              <motion.div
                key={spot.title}
                initial={{ opacity: 0, y: 20 }}
                animate={isInView ? { opacity: 1, y: 0 } : { opacity: 0, y: 20 }}
                transition={{ duration: 0.5, delay: 0.1 + idx * 0.1 }}
                className='grid grid-cols-1 md:grid-cols-[40px_1fr_auto] gap-x-6 gap-y-3 py-8 border-b border-divider items-start'
              >
                <div className='flex items-center justify-center md:justify-start pt-1'>
                  <Icon className='w-5 h-5 text-ink-3' />
                </div>
                <div>
                  <h3 className='text-h2 font-semibold text-ink mb-2'>{spot.title}</h3>
                  <div className='flex items-baseline gap-3 mb-3'>
                    <span
                      className={`font-mono text-2xl font-semibold tabular-nums tracking-tight ${
                        spot.signal === 'critical'
                          ? 'text-signal-critical'
                          : spot.signal === 'warning'
                          ? 'text-signal-warning'
                          : spot.signal === 'positive'
                          ? 'text-signal-positive'
                          : 'text-ink'
                      }`}
                    >
                      {spot.metric}
                    </span>
                    <span className='text-meta text-ink-3'>{spot.metricLabel}</span>
                  </div>
                  <p className='text-body text-ink-2 max-w-3xl'>{spot.body}</p>
                </div>
                <div className='justify-self-start md:justify-self-end pt-2'>
                  <Sparkline values={spot.sparkline} signal={spot.signal} width={140} height={36} />
                </div>
              </motion.div>
            );
          })}
        </div>

        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={isInView ? { opacity: 1, y: 0 } : { opacity: 0, y: 20 }}
          transition={{ duration: 0.5, delay: 0.45 }}
          className='mt-12 max-w-3xl'
        >
          <div className='font-mono text-meta uppercase tracking-[0.08em] text-ink-3 mb-3'>
            What we do
          </div>
          <p className='text-body text-ink-2'>
            We instrument SoH trajectory, equivalent-cycle accounting, warranty
            compliance and degradation-aware dispatch on your actual operating
            data, and bake the evidence trail into CSRD- and EU-Battery-Regulation-
            ready reports. PV operators get the same treatment for soiling, fault
            detection and portfolio analytics.
          </p>
        </motion.div>
      </MarketingSection>
    </div>
  );
};

export default ProblemSection;
