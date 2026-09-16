'use client';

import { useRef } from 'react';
import { motion, useInView } from 'framer-motion';

const TechnologyPartnersSection = () => {
  const ref = useRef(null);
  const isInView = useInView(ref, { once: true, amount: 0.2 });

  const cloudPlatforms = [
    { name: 'AWS', logo: 'https://upload.wikimedia.org/wikipedia/commons/9/93/Amazon_Web_Services_Logo.svg', category: 'Cloud' },
    { name: 'Azure', logo: 'https://upload.wikimedia.org/wikipedia/commons/a/a8/Microsoft_Azure_Logo.svg', category: 'Cloud' },
    { name: 'GCP', logo: 'https://upload.wikimedia.org/wikipedia/commons/5/51/Google_Cloud_logo.svg', category: 'Cloud' }
  ];

  const mlFrameworks = [
    { name: 'Python', logo: 'https://upload.wikimedia.org/wikipedia/commons/c/c3/Python-logo-notext.svg', category: 'Language' },
    { name: 'TensorFlow', logo: 'https://upload.wikimedia.org/wikipedia/commons/2/2d/Tensorflow_logo.svg', category: 'ML Framework' },
    { name: 'PyTorch', logo: 'https://upload.wikimedia.org/wikipedia/commons/1/10/PyTorch_logo_icon.svg', category: 'ML Framework' },
    { name: 'scikit-learn', logo: 'https://upload.wikimedia.org/wikipedia/commons/0/05/Scikit_learn_logo_small.svg', category: 'ML Library' }
  ];

  const protocols = [
    { name: 'Modbus', category: 'Protocol' },
    { name: 'OPC UA', category: 'Protocol' },
    { name: 'MQTT', category: 'Protocol' },
    { name: 'REST API', category: 'Protocol' }
  ];

  const dataTools = [
    { name: 'InfluxDB', logo: 'https://upload.wikimedia.org/wikipedia/commons/c/c6/Influxdb_logo.svg', category: 'Time-Series DB' },
    { name: 'pvlib', category: 'Solar Physics' }
  ];

  const containerVariants = {
    hidden: { opacity: 0 },
    visible: {
      opacity: 1,
      transition: {
        staggerChildren: 0.05
      }
    }
  };

  const itemVariants = {
    hidden: { opacity: 0, y: 20 },
    visible: {
      opacity: 1,
      y: 0,
      transition: {
        duration: 0.5
      }
    }
  };

  return (
    <section ref={ref} className="py-16 sm:py-20 bg-gradient-to-br from-gray-50 to-gray-100">
      <div className="container mx-auto px-4 sm:px-6 lg:px-8">
        <motion.div
          className="text-center mb-12"
          initial={{ opacity: 0, y: 30 }}
          animate={isInView ? { opacity: 1, y: 0 } : { opacity: 0, y: 30 }}
          transition={{ duration: 0.8 }}
        >
          <h2 className="text-3xl sm:text-4xl font-bold text-gray-900 mb-4">
            Built on Industry-Leading Technology
          </h2>
          <p className="text-lg text-gray-600 max-w-3xl mx-auto">
            Our platform leverages best-in-class cloud infrastructure, machine learning frameworks, and industrial protocols to deliver enterprise-grade energy intelligence.
          </p>
        </motion.div>

        <div className="space-y-12">
          {/* Cloud Platforms */}
          <motion.div
            variants={containerVariants}
            initial="hidden"
            animate={isInView ? "visible" : "hidden"}
          >
            <h3 className="text-xl font-bold text-gray-700 mb-6 text-center">Cloud Platforms</h3>
            <div className="grid grid-cols-3 gap-6 max-w-2xl mx-auto">
              {cloudPlatforms.map((partner, index) => (
                <motion.div
                  key={index}
                  variants={itemVariants}
                  className="bg-white rounded-xl p-6 shadow-md hover:shadow-xl transition-shadow flex flex-col items-center justify-center"
                >
                  <img
                    src={partner.logo}
                    alt={partner.name}
                    className="h-12 object-contain mb-3"
                  />
                  <div className="text-sm text-gray-500 text-center">{partner.category}</div>
                </motion.div>
              ))}
            </div>
          </motion.div>

          {/* ML Frameworks */}
          <motion.div
            variants={containerVariants}
            initial="hidden"
            animate={isInView ? "visible" : "hidden"}
          >
            <h3 className="text-xl font-bold text-gray-700 mb-6 text-center">Machine Learning & Data Science</h3>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-6 max-w-4xl mx-auto">
              {mlFrameworks.map((partner, index) => (
                <motion.div
                  key={index}
                  variants={itemVariants}
                  className="bg-white rounded-xl p-6 shadow-md hover:shadow-xl transition-shadow flex flex-col items-center justify-center"
                >
                  <img
                    src={partner.logo}
                    alt={partner.name}
                    className="h-12 object-contain mb-3"
                  />
                  <div className="text-sm font-semibold text-gray-800 text-center mb-1">{partner.name}</div>
                  <div className="text-xs text-gray-500 text-center">{partner.category}</div>
                </motion.div>
              ))}
            </div>
          </motion.div>

          {/* Industrial Protocols */}
          <motion.div
            variants={containerVariants}
            initial="hidden"
            animate={isInView ? "visible" : "hidden"}
          >
            <h3 className="text-xl font-bold text-gray-700 mb-6 text-center">Industrial Protocols</h3>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-6 max-w-4xl mx-auto">
              {protocols.map((protocol, index) => (
                <motion.div
                  key={index}
                  variants={itemVariants}
                  className="bg-white rounded-xl p-6 shadow-md hover:shadow-xl transition-shadow flex flex-col items-center justify-center"
                >
                  <div className="text-lg font-bold text-blue-600 mb-2">{protocol.name}</div>
                  <div className="text-xs text-gray-500 text-center">{protocol.category}</div>
                </motion.div>
              ))}
            </div>
          </motion.div>

          {/* Data & Analytics Tools */}
          <motion.div
            variants={containerVariants}
            initial="hidden"
            animate={isInView ? "visible" : "hidden"}
          >
            <h3 className="text-xl font-bold text-gray-700 mb-6 text-center">Data & Analytics</h3>
            <div className="grid grid-cols-2 gap-6 max-w-xl mx-auto">
              {dataTools.map((tool, index) => (
                <motion.div
                  key={index}
                  variants={itemVariants}
                  className="bg-white rounded-xl p-6 shadow-md hover:shadow-xl transition-shadow flex flex-col items-center justify-center"
                >
                  {tool.logo ? (
                    <img
                      src={tool.logo}
                      alt={tool.name}
                      className="h-12 object-contain mb-3"
                    />
                  ) : (
                    <div className="text-2xl font-bold text-blue-600 mb-2">{tool.name}</div>
                  )}
                  <div className="text-sm font-semibold text-gray-800 text-center mb-1">{tool.name}</div>
                  <div className="text-xs text-gray-500 text-center">{tool.category}</div>
                </motion.div>
              ))}
            </div>
          </motion.div>
        </div>

        <motion.div
          className="mt-12 text-center"
          initial={{ opacity: 0 }}
          animate={isInView ? { opacity: 1 } : { opacity: 0 }}
          transition={{ delay: 0.8, duration: 0.8 }}
        >
          <p className="text-gray-600 max-w-3xl mx-auto">
            Our technology stack ensures seamless integration with your existing infrastructure while providing the scalability and reliability needed for enterprise energy management.
          </p>
        </motion.div>
      </div>
    </section>
  );
};

export default TechnologyPartnersSection;
