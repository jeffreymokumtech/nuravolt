'use client';

import { useRef } from 'react';
import { motion, useInView } from 'framer-motion';
import { ArrowRight } from 'lucide-react';

const TransformationSection = () => {
  const ref = useRef(null);
  const isInView = useInView(ref, { once: true, amount: 0.2 });

  const beforeItems = [
    'Finding soiling losses after weeks of degradation',
    'Cleaning entire plants on fixed schedules',
    'Detecting inverter issues only after failures',
    'Missing string-level problems with inverter monitoring',
    'Losing 5-15% capacity to undetected issues'
  ];

  const afterItems = [
    'Predicting soiling impacts before losses occur',
    'Targeted cleaning based on actual performance data',
    'Preventing failures with predictive maintenance',
    'String-level visibility catching every issue',
    'Recovering significant losses annually (50MW plant)'
  ];

  return (
    <section ref={ref} className="py-20 bg-paper-2">
      <div className="container mx-auto px-4 sm:px-6 lg:px-8">
        <motion.div
          className="text-center max-w-4xl mx-auto mb-16"
          initial={{ opacity: 0, y: 30 }}
          animate={isInView ? { opacity: 1, y: 0 } : { opacity: 0, y: 30 }}
          transition={{ duration: 0.8 }}
        >
          <h2 className="text-4xl sm:text-5xl font-bold text-ink mb-6">
            From Reactive Detection to Predictive Maintenance
          </h2>
        </motion.div>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-8 items-center">
          {/* Before */}
          <motion.div
            className="bg-paper-2 border border-signal-critical/40 rounded p-8"
            initial={{ opacity: 0, x: -50 }}
            animate={isInView ? { opacity: 1, x: 0 } : { opacity: 0, x: -50 }}
            transition={{ delay: 0.3, duration: 0.8 }}
          >
            <h3 className="text-2xl font-bold text-red-800 mb-6 text-center">REACTIVE DETECTION</h3>
            <ul className="space-y-4">
              {beforeItems.map((item, index) => (
                <motion.li
                  key={index}
                  className="flex items-start text-signal-critical"
                  initial={{ opacity: 0, y: 20 }}
                  animate={isInView ? { opacity: 1, y: 0 } : { opacity: 0, y: 20 }}
                  transition={{ delay: 0.5 + index * 0.1 }}
                >
                  <span className="text-signal-critical mr-3 mt-1">✗</span>
                  <span>{item}</span>
                </motion.li>
              ))}
            </ul>
          </motion.div>

          {/* Arrow */}
          <motion.div
            className="flex justify-center"
            initial={{ opacity: 0, scale: 0.5 }}
            animate={isInView ? { opacity: 1, scale: 1 } : { opacity: 0, scale: 0.5 }}
            transition={{ delay: 0.8, duration: 0.6 }}
          >
            <div className="bg-primary rounded-full p-6">
              <ArrowRight className="w-8 h-8 text-white" />
            </div>
          </motion.div>

          {/* After */}
          <motion.div
            className="bg-paper-2 border border-green-200 rounded p-8"
            initial={{ opacity: 0, x: 50 }}
            animate={isInView ? { opacity: 1, x: 0 } : { opacity: 0, x: 50 }}
            transition={{ delay: 0.3, duration: 0.8 }}
          >
            <h3 className="text-2xl font-bold text-green-800 mb-6 text-center">PREDICTIVE MAINTENANCE</h3>
            <ul className="space-y-4">
              {afterItems.map((item, index) => (
                <motion.li
                  key={index}
                  className="flex items-start text-signal-positive"
                  initial={{ opacity: 0, y: 20 }}
                  animate={isInView ? { opacity: 1, y: 0 } : { opacity: 0, y: 20 }}
                  transition={{ delay: 0.5 + index * 0.1 }}
                >
                  <span className="text-signal-positive mr-3 mt-1">✓</span>
                  <span>{item}</span>
                </motion.li>
              ))}
            </ul>
          </motion.div>
        </div>

      </div>
    </section>
  );
};

export default TransformationSection;