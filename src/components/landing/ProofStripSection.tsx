'use client';

import { motion } from 'framer-motion';
import Link from 'next/link';
import { ArrowRight, Quote } from 'lucide-react';
import { caseStudies } from '@/data/caseStudies';
import { KPIReadout } from '@/components/ui/KPIReadout';
import { MarketingSection } from '@/components/ui/MarketingSection';
import { HairlineRule } from '@/components/ui/HairlineRule';

const REGION_LABEL: Record<string, string> = {
  netherlands: 'Northern European',
  spain: 'Iberian',
  uae: 'GCC',
  gcc: 'GCC',
  europe: 'European',
  africa: 'Sub-Saharan African',
};

interface StatBlock {
  value: string;
  label: string;
  href: string;
}

// Two stats derive from real case-study data, stays in sync with caseStudies.ts.
// Two are aggregate methodology claims (no per-customer data).
const buildStats = (): StatBlock[] => {
  const dutch = caseStudies.find((c) => c.id === 'dutch-multi-site-85mw');
  const spanish = caseStudies.find((c) => c.id === 'spanish-utility-120mw');

  const blocks: StatBlock[] = [
    {
      value: '2 GW',
      label: 'Operational PV & BESS data underlying the methodology',
      href: '/about#methodology',
    },
  ];

  if (dutch) {
    blocks.push({
      value: dutch.results.costSavings,
      label: `Recovered on an ${dutch.capacity} MW ${
        REGION_LABEL[dutch.region] || 'European'
      } portfolio`,
      href: `/case-studies#${dutch.id}`,
    });
  }

  if (spanish) {
    blocks.push({
      value: spanish.results.costSavings,
      label: `Recovered on a ${spanish.capacity} MW ${
        REGION_LABEL[spanish.region] || 'European'
      } utility-scale plant`,
      href: `/case-studies#${spanish.id}`,
    });
  }

  blocks.push({
    value: '6-13 mo',
    label: 'Payback across deployments',
    href: '/case-studies',
  });

  return blocks;
};

const FEATURED_QUOTE = {
  text: 'The soiling analytics transformed our O&M strategy. We clean less and produce more.',
  attribution: 'Asset Manager · 120 MW Iberian utility-scale PV plant',
  href: '/case-studies#spanish-utility-120mw',
} as const;

const ProofStripSection = () => {
  const stats = buildStats();

  return (
    <MarketingSection size='compact'>
      <div className='max-w-6xl mx-auto'>
        {/* Anonymized stat strip, hairline-divided KPI readouts */}
        <div className='grid grid-cols-2 lg:grid-cols-4 divide-y lg:divide-y-0 lg:divide-x divide-divider border-t border-b border-divider'>
          {stats.map((stat, idx) => (
            <motion.div
              key={stat.label}
              initial={{ opacity: 0, y: 12 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true }}
              transition={{ delay: idx * 0.08, duration: 0.4 }}
              className='min-w-0'
            >
              <Link
                href={stat.href}
                className='block h-full px-5 py-6 hover:bg-paper-2 transition-colors group'
              >
                <KPIReadout value={stat.value} label={stat.label} size='md' className='min-w-0 break-words' />
                <div className='mt-3 inline-flex items-center gap-1 font-mono text-meta uppercase tracking-[0.08em] text-ink-3 group-hover:text-ink transition-colors'>
                  View
                  <ArrowRight className='w-3 h-3' />
                </div>
              </Link>
            </motion.div>
          ))}
        </div>

        {/* Anonymized quote, flat hairline-bounded panel, no card shadow */}
        <motion.div
          initial={{ opacity: 0, y: 12 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          transition={{ delay: 0.4, duration: 0.4 }}
          className='mt-12 max-w-3xl mx-auto'
        >
          <Link
            href={FEATURED_QUOTE.href}
            className='block border-t border-b border-divider py-8 hover:bg-paper-2 transition-colors group'
          >
            <Quote className='w-6 h-6 text-ink-3 mb-3' />
            <p className='text-xl text-ink leading-relaxed mb-4'>
              &ldquo;{FEATURED_QUOTE.text}&rdquo;
            </p>
            <HairlineRule className='my-4' />
            <div className='flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2'>
              <span className='font-mono text-meta uppercase tracking-[0.08em] text-ink-3'>
                {FEATURED_QUOTE.attribution}
              </span>
              <span className='inline-flex items-center gap-1 font-mono text-meta uppercase tracking-[0.08em] text-primary group-hover:underline'>
                Read the case
                <ArrowRight className='w-3 h-3' />
              </span>
            </div>
          </Link>
        </motion.div>
      </div>
    </MarketingSection>
  );
};

export default ProofStripSection;
