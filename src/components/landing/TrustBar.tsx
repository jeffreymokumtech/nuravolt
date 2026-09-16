'use client';

import { useRef } from 'react';
import { motion, useInView } from 'framer-motion';
import { HairlineRule } from '@/components/ui/HairlineRule';
import { KPIReadout } from '@/components/ui/KPIReadout';

const stats = [
  { value: '365-day', label: 'Soiling forecasts' },
  { value: '3-8%', label: 'Hidden losses found' },
  { value: '3 weeks', label: 'Earlier detection' },
  { value: 'Physics + ML', label: 'Digital twins' },
];

const TrustBar = () => {
  const ref = useRef(null);
  const isInView = useInView(ref, { once: true, amount: 0.5 });

  return (
    <section ref={ref} className='bg-paper-2 border-y border-divider'>
      <div className='container mx-auto px-4 sm:px-6 lg:px-8'>
        <div className='grid grid-cols-2 md:grid-cols-4 items-stretch'>
          {stats.map((stat, index) => (
            <motion.div
              key={stat.label}
              initial={{ opacity: 0, y: 12 }}
              animate={isInView ? { opacity: 1, y: 0 } : { opacity: 0, y: 12 }}
              transition={{ duration: 0.5, delay: index * 0.08 }}
              className='relative px-6 py-6 flex items-center justify-center'
            >
              <KPIReadout value={stat.value} label={stat.label} size='md' align='center' />
              {index < stats.length - 1 ? (
                <HairlineRule
                  orientation='vertical'
                  className='absolute right-0 top-3 bottom-3 hidden md:block'
                />
              ) : null}
            </motion.div>
          ))}
        </div>
      </div>
    </section>
  );
};

export default TrustBar;
