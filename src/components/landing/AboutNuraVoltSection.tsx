'use client';

import { motion } from 'framer-motion';
import { useRef } from 'react';
import { useInView } from 'framer-motion';

const AboutNuraVoltSection = () => {
  const ref = useRef(null);
  const isInView = useInView(ref, { once: true, amount: 0.3 });

  return (
    <section ref={ref} className="py-16 bg-paper">
      <div className="container mx-auto px-4 sm:px-6 lg:px-8 max-w-3xl">
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={isInView ? { opacity: 1, y: 0 } : { opacity: 0, y: 20 }}
          transition={{ duration: 0.6 }}
          className="text-center"
        >
          <h2 className="text-2xl font-bold text-ink mb-4">
            About NuraVolt
          </h2>
          <p className="text-lg text-ink-2 leading-relaxed">
            NuraVolt combines physics-based modeling with machine learning to turn your
            existing monitoring data into predictive intelligence. We layer on top of
            any SCADA or inverter platform, detecting faults days before impact,
            optimizing cleaning schedules, and forecasting battery health. Easy
            integration in 2-3 weeks, cloud or on-premise.
          </p>
        </motion.div>
      </div>
    </section>
  );
};

export default AboutNuraVoltSection;
