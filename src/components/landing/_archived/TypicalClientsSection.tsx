'use client';

import { motion } from 'framer-motion';
import { useRef } from 'react';
import { useInView } from 'framer-motion';
import { Building2, Settings, Zap, Users } from 'lucide-react';

const clients = [
  {
    icon: Building2,
    title: 'Utility-scale renewable asset owners (solar, BESS, wind)'
  },
  {
    icon: Settings,
    title: 'O&M providers managing multi-site portfolios'
  },
  {
    icon: Zap,
    title: 'Energy companies modernizing EMS & monitoring'
  },
  {
    icon: Users,
    title: 'Teams who need senior ML/architecture guidance without hiring full-time'
  }
];

const TypicalClientsSection = () => {
  const ref = useRef(null);
  const isInView = useInView(ref, { once: true, amount: 0.3 });

  return (
    <section ref={ref} className="py-20 bg-gray-50">
      <div className="container mx-auto px-4 sm:px-6 lg:px-8 max-w-4xl">
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={isInView ? { opacity: 1, y: 0 } : { opacity: 0, y: 20 }}
          transition={{ duration: 0.6 }}
          className="text-center mb-12"
        >
          <h2 className="text-3xl font-bold text-gray-900 mb-4">
            Typical Clients
          </h2>
        </motion.div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          {clients.map((client, index) => (
            <motion.div
              key={client.title}
              initial={{ opacity: 0, y: 20 }}
              animate={isInView ? { opacity: 1, y: 0 } : { opacity: 0, y: 20 }}
              transition={{ duration: 0.5, delay: index * 0.1 }}
              className="flex items-center gap-4 p-5 bg-white rounded-lg border border-gray-200"
            >
              <div className="flex-shrink-0 w-12 h-12 bg-blue-50 rounded-lg flex items-center justify-center">
                <client.icon className="w-6 h-6 text-blue-600" />
              </div>
              <p className="text-gray-900 font-medium">
                {client.title}
              </p>
            </motion.div>
          ))}
        </div>
      </div>
    </section>
  );
};

export default TypicalClientsSection;
