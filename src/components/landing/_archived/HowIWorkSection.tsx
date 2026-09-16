'use client';

import { motion } from 'framer-motion';
import { useRef } from 'react';
import { useInView } from 'framer-motion';

const HowIWorkSection = () => {
  const ref = useRef(null);
  const isInView = useInView(ref, { once: true, amount: 0.3 });

  return (
    <section ref={ref} className="py-20 bg-gray-50">
      <div className="container mx-auto px-4 sm:px-6 lg:px-8 max-w-3xl">
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={isInView ? { opacity: 1, y: 0 } : { opacity: 0, y: 20 }}
          transition={{ duration: 0.6 }}
          className="text-center mb-8"
        >
          <h2 className="text-3xl font-bold text-gray-900 mb-4">
            How I Work
          </h2>
        </motion.div>

        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={isInView ? { opacity: 1, y: 0 } : { opacity: 0, y: 20 }}
          transition={{ duration: 0.6, delay: 0.2 }}
          className="space-y-6 text-center"
        >
          <p className="text-xl text-gray-900 font-medium">
            I work as an independent expert, from architecture to implementation.
          </p>

          <p className="text-lg text-gray-600 leading-relaxed">
            Engagements range from strategic guidance (architecture, model strategy,
            technical due diligence) to hands-on implementation and team enablement.
          </p>

          <p className="text-lg text-gray-600 leading-relaxed">
            This flexibility allows you to get exactly what you need, whether that&apos;s
            a second opinion, a full build-out, or help training your internal team.
          </p>
        </motion.div>
      </div>
    </section>
  );
};

export default HowIWorkSection;
