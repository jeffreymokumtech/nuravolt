'use client';

import { useRef } from 'react';
import { motion, useInView } from 'framer-motion';
import { Button } from '@/components/ui/button';
import { Sun, Battery, Wind, ArrowRight, Zap, Shield, TrendingUp } from 'lucide-react';
import Link from 'next/link';

const DualSolutionsPreview = () => {
  const ref = useRef(null);
  const isInView = useInView(ref, { once: true, amount: 0.2 });

  const solutions = [
    {
      title: 'PV Monitoring & Analytics',
      icon: Sun,
      description: 'Physics-informed AI for solar power plants. Detect issues days to weeks before impact and significantly reduce O&M costs.',
      image: 'https://images.unsplash.com/photo-1509391366360-2e959784a276?ixlib=rb-4.0.3&auto=format&fit=crop&w=800&q=80',
      features: [
        'Real-time performance monitoring',
        'Predictive fault detection',
        'Soiling intelligence & cleaning optimization',
        'Desert-optimized algorithms',
        'Seamless SCADA integration'
      ],
      metrics: [
        { value: 'Days-weeks', label: 'Advance warning' },
        { value: 'Lower costs', label: 'O&M savings' },
        { value: '2-3 weeks', label: 'Integration time' }
      ],
      color: 'blue',
      link: '/solutions/pv-monitoring'
    },
    {
      title: 'BESS Monitoring & Management',
      icon: Battery,
      description: 'AI-powered battery analytics for energy storage deployments. Extend battery life and prevent catastrophic failures with physics-informed predictions.',
      image: 'https://cdn.prod.website-files.com/6673d8cfb47ec7d5504865ce/67fea46219018db93e401749_BESS-Webpage-Featured-Image-1200-x-800-px.jpg',
      features: [
        'State of Health (SOH) estimation',
        'Thermal runaway prevention',
        'Dispatch optimization (LP/MPC)',
        'Warranty tracking'
      ],
      metrics: [
        { value: 'Extended life', label: 'Battery optimization' },
        { value: 'Up to 60%', label: 'Revenue gain' },
        { value: 'All chemistries', label: 'Battery support' }
      ],
      color: 'blue',
      link: '/solutions/bess-monitoring'
    },
    {
      title: 'Wind Monitoring & Analytics',
      icon: Wind,
      description: 'Physics-informed ML for wind turbine performance monitoring. Predict gearbox failures months in advance and optimize farm-level output.',
      image: 'https://images.unsplash.com/photo-1532601224476-15c79f2f7a51?ixlib=rb-4.0.3&auto=format&fit=crop&w=800&q=80',
      features: [
        'Power curve analysis',
        'Gearbox predictive maintenance',
        'Wake effect modeling',
        'SCADA-based analytics'
      ],
      metrics: [
        { value: '3-12 mo', label: 'Advance warning' },
        { value: '$200K+', label: 'Avoided per failure' },
        { value: '67%', label: 'Detection rate' }
      ],
      color: 'green',
      link: '/solutions/wind-monitoring'
    }
  ];

  const containerVariants = {
    hidden: { opacity: 0 },
    visible: {
      opacity: 1,
      transition: {
        staggerChildren: 0.2
      }
    }
  };

  const cardVariants = {
    hidden: { opacity: 0, y: 50 },
    visible: {
      opacity: 1,
      y: 0,
      transition: {
        duration: 0.6,
        ease: 'easeOut'
      }
    }
  };

  return (
    <section ref={ref} className="py-16 sm:py-24 bg-white">
      <div className="container mx-auto px-4 sm:px-6 lg:px-8">
        <motion.div
          className="text-center mb-16"
          initial={{ opacity: 0, y: 30 }}
          animate={isInView ? { opacity: 1, y: 0 } : { opacity: 0, y: 30 }}
          transition={{ duration: 0.8 }}
        >
          <h2 className="text-3xl sm:text-4xl lg:text-5xl font-bold text-gray-900 mb-4">
            Comprehensive Energy Intelligence Solutions
          </h2>
          <p className="text-xl text-gray-600 max-w-3xl mx-auto">
            From solar power plants to battery storage and wind farms, we provide AI-powered monitoring and analytics for the complete energy value chain.
          </p>
        </motion.div>

        <motion.div
          className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6"
          variants={containerVariants}
          initial="hidden"
          animate={isInView ? "visible" : "hidden"}
        >
          {solutions.map((solution, index) => {
            const colorMap = {
              blue: {
                gradient: 'from-blue-600 to-blue-700',
                light: 'bg-blue-50',
                text: 'text-blue-600',
                border: 'border-blue-200',
                hover: 'hover:border-blue-400'
              },
              purple: {
                gradient: 'from-blue-400 to-purple-700',
                light: 'bg-blue-50',
                text: 'text-blue-400',
                border: 'border-purple-200',
                hover: 'hover:border-purple-400'
              },
              green: {
                gradient: 'from-green-600 to-green-700',
                light: 'bg-green-50',
                text: 'text-green-600',
                border: 'border-green-200',
                hover: 'hover:border-green-400'
              }
            };

            const colors = colorMap[solution.color as keyof typeof colorMap];

            return (
              <motion.div
                key={index}
                variants={cardVariants}
                className={`group bg-white rounded-2xl overflow-hidden shadow-lg border-2 ${colors.border} ${colors.hover} transition-all duration-300 hover:shadow-2xl`}
              >
                {/* Image Section */}
                <div className="relative h-64 overflow-hidden">
                  <div
                    className="absolute inset-0 bg-cover bg-center transition-transform duration-500 group-hover:scale-110"
                    style={{
                      backgroundImage: `linear-gradient(rgba(0, 0, 0, 0.3), rgba(0, 0, 0, 0.4)), url("${solution.image}")`
                    }}
                  />
                  <div className="absolute top-4 right-4 bg-white rounded-full p-3 shadow-lg">
                    <solution.icon className={`w-8 h-8 ${colors.text}`} />
                  </div>
                </div>

                {/* Content Section */}
                <div className="p-8">
                  <h3 className="text-2xl font-bold text-gray-900 mb-3">
                    {solution.title}
                  </h3>
                  <p className="text-gray-600 mb-6 leading-relaxed">
                    {solution.description}
                  </p>

                  {/* Features List */}
                  <div className="mb-6 space-y-2">
                    {solution.features.map((feature, idx) => (
                      <div key={idx} className="flex items-center text-sm text-gray-700">
                        <Zap className={`w-4 h-4 mr-2 ${colors.text}`} />
                        {feature}
                      </div>
                    ))}
                  </div>

                  {/* Metrics Grid */}
                  <div className={`grid grid-cols-3 gap-4 mb-6 p-4 rounded-lg ${colors.light}`}>
                    {solution.metrics.map((metric, idx) => (
                      <div key={idx} className="text-center">
                        <div className={`text-xl font-bold ${colors.text}`}>
                          {metric.value}
                        </div>
                        <div className="text-xs text-gray-600 mt-1">
                          {metric.label}
                        </div>
                      </div>
                    ))}
                  </div>

                  {/* CTA Button */}
                  <Link href={solution.link}>
                    <Button
                      className={`w-full bg-gradient-to-r ${colors.gradient} hover:opacity-90 text-white py-6 text-lg group/btn`}
                    >
                      Learn More
                      <ArrowRight className="ml-2 w-5 h-5 transition-transform group-hover/btn:translate-x-1" />
                    </Button>
                  </Link>
                </div>
              </motion.div>
            );
          })}
        </motion.div>

        {/* Bottom CTA */}
        <motion.div
          className="mt-16 text-center"
          initial={{ opacity: 0 }}
          animate={isInView ? { opacity: 1 } : { opacity: 0 }}
          transition={{ delay: 0.6, duration: 0.8 }}
        >
          <div className="inline-flex items-center space-x-2 text-gray-600 mb-4">
            <Shield className="w-5 h-5 text-blue-500" />
            <span className="font-semibold">Customized Pilot Program</span>
          </div>
          <p className="text-gray-600 max-w-2xl mx-auto">
            Start with a tailored pilot to validate the value with your actual data before any long-term commitment. Contact us for a pilot plan customized to your plants.
          </p>
        </motion.div>
      </div>
    </section>
  );
};

export default DualSolutionsPreview;
