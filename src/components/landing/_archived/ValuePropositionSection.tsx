'use client';

import { useEffect, useRef, useState } from 'react';
import { motion, useInView, useAnimation } from 'framer-motion';
import { DollarSign, TrendingUp, AlertTriangle, CheckCircle, Clock, Zap } from 'lucide-react';

const ValuePropositionSection = () => {
  const ref = useRef(null);
  const isInView = useInView(ref, { once: true, amount: 0.2 });
  const controls = useAnimation();
  const [hoveredCard, setHoveredCard] = useState<number | null>(null);

  useEffect(() => {
    if (isInView) {
      controls.start('visible');
    }
  }, [isInView, controls]);

  const valueCards = [
    {
      icon: DollarSign,
      transformIcon: TrendingUp,
      title: 'Financial Recovery',
      description: 'Identify and recover millions in lost revenue from underperforming assets',
      metric: '$2.3M',
      metricLabel: 'Average Annual Recovery',
      color: 'from-blue-500 to-blue-600'
    },
    {
      icon: AlertTriangle,
      transformIcon: CheckCircle,
      title: 'Predictive Maintenance',
      description: 'Prevent failures before they happen with AI-powered early warning systems',
      metric: '97%',
      metricLabel: 'Failure Prevention Rate',
      color: 'from-blue-600 to-blue-700'
    },
    {
      icon: Clock,
      transformIcon: Zap,
      title: 'Operational Efficiency',
      description: 'Reduce maintenance costs and downtime with intelligent automation',
      metric: '65%',
      metricLabel: 'Time Savings',
      color: 'from-yellow-500 to-yellow-600'
    }
  ];

  const containerVariants = {
    hidden: { opacity: 0 },
    visible: {
      opacity: 1,
      transition: {
        staggerChildren: 0.3
      }
    }
  };

  const cardVariants = {
    hidden: { 
      opacity: 0, 
      y: 60,
      scale: 0.9
    },
    visible: { 
      opacity: 1, 
      y: 0,
      scale: 1
    }
  };

  const iconVariants = {
    initial: { scale: 1, rotate: 0 },
    hover: { scale: 1.1, rotate: 360 },
    transform: { scale: 1.2, rotate: 180 }
  };


  return (
    <section ref={ref} className="py-20 bg-gradient-to-br from-slate-50 to-blue-50 relative overflow-hidden">
      {/* Animated background pattern */}
      <div className="absolute inset-0 opacity-10">
        <svg className="w-full h-full" viewBox="0 0 100 100" preserveAspectRatio="none">
          <defs>
            <pattern id="dots" x="0" y="0" width="10" height="10" patternUnits="userSpaceOnUse">
              <circle cx="5" cy="5" r="1" fill="currentColor" className="text-blue-600">
                <animate attributeName="r" values="1;2;1" dur="4s" repeatCount="indefinite" />
              </circle>
            </pattern>
          </defs>
          <rect width="100%" height="100%" fill="url(#dots)" />
          
          {/* Flowing connection lines */}
          <motion.path
            d="M0,50 Q25,25 50,50 T100,50"
            stroke="currentColor"
            strokeWidth="0.5"
            fill="none"
            className="text-blue-400"
            initial={{ pathLength: 0, opacity: 0 }}
            animate={{ pathLength: 1, opacity: 0.6 }}
            transition={{ duration: 3, repeat: Infinity, repeatType: "loop" }}
          />
        </svg>
      </div>

      <div className="container mx-auto px-4 sm:px-6 lg:px-8 relative z-10">
        <motion.div
          className="text-center max-w-4xl mx-auto mb-16"
          initial={{ opacity: 0, y: 30 }}
          animate={controls}
          variants={{
            visible: { opacity: 1, y: 0, transition: { duration: 0.8 } }
          }}
        >
          <h2 className="text-4xl sm:text-5xl font-bold text-gray-900 mb-6">
            Transform Your Solar Operations
          </h2>
          <p className="text-xl text-gray-600 leading-relaxed">
            Discover how HeliosIQ&apos;s AI-powered platform delivers measurable results across your entire solar portfolio
          </p>
        </motion.div>

        <motion.div
          className="grid grid-cols-1 md:grid-cols-3 gap-8 mb-16"
          variants={containerVariants}
          initial="hidden"
          animate={controls}
        >
          {valueCards.map((card, index) => {
            const IconComponent = hoveredCard === index ? card.transformIcon : card.icon;
            
            return (
              <motion.div
                key={card.title}
                variants={cardVariants}
                className="group relative"
                transition={{
                  type: "spring",
                  stiffness: 100,
                  damping: 12
                }}
              >
                <div className="relative bg-white rounded-2xl p-8 shadow-lg hover:shadow-xl transition-all duration-300 border border-blue-100 overflow-hidden">
                  {/* Gradient overlay */}
                  <div className={`absolute inset-0 bg-gradient-to-br ${card.color} opacity-0 group-hover:opacity-5 transition-opacity duration-500`} />
                  
                  {/* Icon */}
                  <motion.div
                    variants={iconVariants}
                    initial="initial"
                    animate={hoveredCard === index ? "transform" : "initial"}
                    className={`w-16 h-16 mb-6 rounded-full bg-gradient-to-br ${card.color} flex items-center justify-center shadow-lg`}
                  >
                    <IconComponent className="w-8 h-8 text-white" />
                  </motion.div>

                  {/* Content */}
                  <h3 className="text-2xl font-bold text-gray-900 mb-4">{card.title}</h3>
                  <p className="text-gray-600 mb-6 leading-relaxed">{card.description}</p>
                  
                  {/* Metric */}
                  <div className="border-t border-gray-100 pt-6">
                    <div className={`text-3xl font-bold bg-gradient-to-r ${card.color} bg-clip-text text-transparent mb-1`}>
                      {card.metric}
                    </div>
                    <div className="text-sm text-gray-500 font-medium">{card.metricLabel}</div>
                  </div>

                  {/* Hover effect elements */}
                  <motion.div
                    className="absolute top-4 right-4 w-2 h-2 bg-blue-400 rounded-full"
                    animate={{
                      scale: hoveredCard === index ? [1, 1.5, 1] : 1,
                      opacity: hoveredCard === index ? [0.5, 1, 0.5] : 0.5
                    }}
                    transition={{ duration: 2, repeat: Infinity }}
                  />
                </div>
              </motion.div>
            );
          })}
        </motion.div>

        {/* Call to action */}
        <motion.div
          className="text-center"
          initial={{ opacity: 0, y: 30 }}
          animate={controls}
          variants={{
            visible: { opacity: 1, y: 0, transition: { delay: 1.2, duration: 0.8 } }
          }}
        >
          <motion.button
            className="bg-gradient-to-r from-blue-600 to-blue-400 text-white px-8 py-4 rounded-full font-semibold text-lg shadow-xl hover:shadow-2xl transition-all duration-300"
            whileHover={{ scale: 1.05 }}
            whileTap={{ scale: 0.95 }}
          >
            See How It Works
          </motion.button>
        </motion.div>
      </div>
    </section>
  );
};

export default ValuePropositionSection;