'use client';

import { useRef } from 'react';
import { motion, useInView } from 'framer-motion';
import Image from 'next/image';
import { CheckCircle2 } from 'lucide-react';
import { DataPanel } from '@/components/ui/DataPanel';
import { KPIReadout } from '@/components/ui/KPIReadout';
import { MarketingSection } from '@/components/ui/MarketingSection';

interface Feature {
  title: string;
  description: string;
  image: string;
  panelHeader: string;
  bullets: string[];
  kpi: { value: string; label: string; signal?: 'positive' | 'warning' | 'critical' | 'neutral' };
}

const features: Feature[] = [
  {
    title: 'Soiling intelligence',
    description:
      '365-day soiling forecasts powered by physics-ML hybrid models. Optimise your cleaning schedule based on actual revenue impact, not guesswork.',
    image: '/images/screenshots/soiling-intelligence.png',
    panelHeader: 'HELIOS · SOILING · 30-DAY FORECAST',
    bullets: [
      'Disaggregate soiling from other losses',
      'Zone-level analysis across your fleet',
      'ROI-optimised cleaning schedules',
    ],
    kpi: { value: '3-8%', label: 'annual revenue recovered', signal: 'positive' },
  },
  {
    title: 'Predictive fault detection',
    description:
      'Catch inverter failures, thermal degradation, and string issues weeks before they cause downtime. Prioritised by revenue impact.',
    image: '/images/screenshots/fault-detection.png',
    panelHeader: 'FLEET · THERMAL RUL · INVERTER ANOMALY',
    bullets: [
      'Thermal RUL predictions for every inverter',
      'Digital twin anomaly detection',
      'Automated severity classification',
    ],
    kpi: { value: '12 d', label: 'average detection lead time', signal: 'positive' },
  },
  {
    title: 'Portfolio analytics',
    description:
      'See revenue at risk across your entire fleet. Track budget deviation, health scores, and performance rankings in one view.',
    image: '/images/screenshots/portfolio-overview.png',
    panelHeader: 'PORTFOLIO · BUDGET · HEALTH RANK',
    bullets: [
      'Plant-level risk scoring',
      'Budget vs actual tracking',
      'Financial loss attribution',
    ],
    kpi: { value: '94-97%', label: 'detection accuracy', signal: 'neutral' },
  },
];

const FeatureBlock = ({ feature, index }: { feature: Feature; index: number }) => {
  const ref = useRef(null);
  const isInView = useInView(ref, { once: true, amount: 0.3 });
  const imageOnLeft = index % 2 === 0;

  const imageElement = (
    <motion.div
      initial={{ opacity: 0, x: imageOnLeft ? -40 : 40 }}
      animate={isInView ? { opacity: 1, x: 0 } : { opacity: 0, x: imageOnLeft ? -40 : 40 }}
      transition={{ duration: 0.6, delay: 0.1 }}
      className='w-full lg:w-1/2'
    >
      <DataPanel headerLeft={feature.panelHeader} live scanline>
        <Image
          src={feature.image}
          alt={`${feature.title} screenshot`}
          width={720}
          height={450}
          className='w-full h-auto'
        />
      </DataPanel>
    </motion.div>
  );

  const textElement = (
    <motion.div
      initial={{ opacity: 0, x: imageOnLeft ? 40 : -40 }}
      animate={isInView ? { opacity: 1, x: 0 } : { opacity: 0, x: imageOnLeft ? 40 : -40 }}
      transition={{ duration: 0.6, delay: 0.2 }}
      className='w-full lg:w-1/2'
    >
      <div className='font-mono text-meta uppercase tracking-[0.08em] text-ink-3 mb-3'>
        0{index + 1} · What we build
      </div>
      <h3 className='text-h1 font-semibold text-ink mb-4'>{feature.title}</h3>
      <p className='text-body text-ink-2 mb-6'>{feature.description}</p>
      <div className='mb-6'>
        <KPIReadout value={feature.kpi.value} label={feature.kpi.label} signal={feature.kpi.signal} size='lg' />
      </div>
      <ul className='space-y-3 border-t border-divider pt-5'>
        {feature.bullets.map((bullet) => (
          <li key={bullet} className='flex items-start gap-3'>
            <CheckCircle2 className='w-4 h-4 text-ink-3 mt-1 flex-shrink-0' />
            <span className='text-body text-ink-2'>{bullet}</span>
          </li>
        ))}
      </ul>
    </motion.div>
  );

  return (
    <div
      ref={ref}
      className={`flex flex-col lg:flex-row items-center gap-10 lg:gap-16 ${
        !imageOnLeft ? 'lg:flex-row-reverse' : ''
      }`}
    >
      {imageOnLeft ? (
        <>
          {imageElement}
          {textElement}
        </>
      ) : (
        <>
          {textElement}
          {imageElement}
        </>
      )}
    </div>
  );
};

const ConsultingServicesSection = () => {
  const titleRef = useRef(null);
  const titleInView = useInView(titleRef, { once: true, amount: 0.5 });

  return (
    <MarketingSection size='default' innerClassName='max-w-6xl mx-auto'>
      <motion.div
        ref={titleRef}
        initial={{ opacity: 0, y: 20 }}
        animate={titleInView ? { opacity: 1, y: 0 } : { opacity: 0, y: 20 }}
        transition={{ duration: 0.6 }}
        className='mb-16 max-w-2xl'
      >
        <div className='font-mono text-meta uppercase tracking-[0.08em] text-ink-3 mb-3'>
          The platform
        </div>
        <h2 className='text-h1 font-semibold text-ink text-balance'>What we build for you</h2>
      </motion.div>

      <div className='space-y-20'>
        {features.map((feature, index) => (
          <FeatureBlock key={feature.title} feature={feature} index={index} />
        ))}
      </div>
    </MarketingSection>
  );
};

export default ConsultingServicesSection;
