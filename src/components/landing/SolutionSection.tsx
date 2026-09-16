'use client';

import { useRef } from 'react';
import { motion, useInView } from 'framer-motion';
import { Target, Microscope, TrendingUp, Zap, Globe, Layers, Brain, Rocket, Settings, GitBranch, DollarSign, Clock, Shield, MapPin, Wrench, Battery } from 'lucide-react';

const SolutionSection = () => {
  const ref = useRef(null);
  const isInView = useInView(ref, { once: true, amount: 0.1 });

  const differentiators = [
    {
      icon: DollarSign,
      title: 'Climate-Adaptive Technology at Competitive Pricing',
      description: 'Advanced digital twin capabilities calibrated for diverse conditions: extreme heat (60°C) and soiling in hot climates, vegetation and clouds in temperate regions, seasonal irradiance changes globally. Competitive pricing designed for operators worldwide.',
      highlight: 'Significantly lower cost than international providers',
      iconColor: 'text-primary'
    },
    {
      icon: Clock,
      title: 'Fast ROI Validation',
      description: 'Detect underperformance causing 2-5% energy loss within minutes. Typical client recovers significant annual savings through prevented downtime.',
      highlight: 'Pilot program proves value before long-term commitment',
      iconColor: 'text-primary'
    },
    {
      icon: MapPin,
      title: 'Built for the Gulf, Not Adapted',
      description: 'Local team based in Dubai providing same-day support. Compliant with DEWA, Saudi SEC, and regional grid codes.',
      highlight: 'Working with ACWA Power, Masdar standards',
      iconColor: 'text-primary'
    },
    {
      icon: Wrench,
      title: 'Your System, Your Way',
      description: 'Unlike rigid SaaS platforms, we customize dashboards to YOUR needs. Integration with existing SCADA/monitoring in 2-3 weeks.',
      highlight: 'Choose monitoring frequency: 15-min standard or 1-min premium',
      iconColor: 'text-primary'
    },
    {
      icon: Battery,
      title: 'Battery-Ready for GCC Energy Storage',
      description: 'Only regional provider offering integrated PV + Battery analytics. Prepare for the UAE and GCC\'s massive storage deployment targets.',
      highlight: 'Extend battery life through physics-informed predictive maintenance',
      iconColor: 'text-primary'
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

  const itemVariants = {
    hidden: { opacity: 0, y: 30 },
    visible: { 
      opacity: 1, 
      y: 0,
      transition: {
        duration: 0.6
      }
    }
  };

  return (
    <section id="features" ref={ref} className="py-20 bg-paper">
      <div className="container mx-auto px-4 sm:px-6 lg:px-8">
        <motion.div
          className="text-center max-w-4xl mx-auto mb-16"
          initial={{ opacity: 0, y: 30 }}
          animate={isInView ? { opacity: 1, y: 0 } : { opacity: 0, y: 30 }}
          transition={{ duration: 0.8 }}
        >
          <h2 className="text-4xl sm:text-5xl font-bold text-ink mb-4">
            Why Choose NuraVolt Over International Providers?
          </h2>
          <p className="text-xl text-primary font-semibold mb-6">
            5 Key Differentiators That Make Us the Smart Choice for Gulf Solar Operations
          </p>
          <p className="text-lg text-ink-2 leading-relaxed">
            While international providers offer generic solutions at premium prices, we deliver Gulf-optimized digital twins with local support at startup pricing. Here's why leading operators are switching:
          </p>
        </motion.div>

        <motion.div
          className="grid grid-cols-1 gap-6 max-w-6xl mx-auto"
          variants={containerVariants}
          initial="hidden"
          animate={isInView ? "visible" : "hidden"}
        >
          {differentiators.map((diff, index) => (
            <motion.div
              key={diff.title}
              variants={itemVariants}
              className="bg-paper rounded p-8 border border-divider hover:shadow-sm transition-all duration-300 hover:border-divider"
            >
              <div className="flex items-start space-x-6">
                <div className="inline-flex items-center justify-center w-16 h-16 bg-paper-2 rounded shadow-sm">
                  <diff.icon className={`w-8 h-8 ${diff.iconColor}`} />
                </div>
                <div className="flex-1">
                  <h3 className="text-2xl font-bold text-ink mb-3">
                    {diff.title}
                  </h3>
                  <p className="text-ink-2 leading-relaxed mb-4">
                    {diff.description}
                  </p>
                  <div className="bg-paper-2 rounded-lg p-3 border-l-4 border-divider">
                    <p className="text-primary font-semibold">
                      ✓ {diff.highlight}
                    </p>
                  </div>
                </div>
              </div>
            </motion.div>
          ))}
        </motion.div>

        {/* Custom Software Advantages */}
        <motion.div
          className="mt-16 mb-16"
          initial={{ opacity: 0, y: 30 }}
          animate={isInView ? { opacity: 1, y: 0 } : { opacity: 0, y: 30 }}
          transition={{ delay: 0.8, duration: 0.8 }}
        >
          <div className="text-center max-w-4xl mx-auto mb-12">
            <h3 className="text-3xl font-bold text-ink mb-4">
              Your Plant, Your Platform - Custom-Built at 70% Less Than In-House Development
            </h3>
            <p className="text-lg text-ink-2">
              Why spend millions and 18+ months building in-house when you can deploy enterprise-grade custom software in 8 weeks?
            </p>
          </div>
          
          <div className="grid grid-cols-1 md:grid-cols-3 gap-8 max-w-6xl mx-auto">
            <div className="bg-paper-2 rounded p-6 border border-green-200">
              <div className="inline-flex items-center justify-center w-12 h-12 bg-primary rounded-lg mb-4">
                <Settings className="w-6 h-6 text-white" />
              </div>
              <h4 className="text-xl font-bold text-ink mb-3">Scales to Your Data</h4>
              <p className="text-ink-2">
                From 10MW pilot to 1000MW+ portfolios. Our architecture grows with your operations - no rebuilding, no migration headaches.
              </p>
            </div>
            
            <div className="bg-paper-2 rounded p-6 border border-purple-200">
              <div className="inline-flex items-center justify-center w-12 h-12 bg-primary rounded-lg mb-4">
                <GitBranch className="w-6 h-6 text-white" />
              </div>
              <h4 className="text-xl font-bold text-ink mb-3">Seamless Integration</h4>
              <p className="text-ink-2">
                Seamless connection with your existing SCADA, ERP, CMMS, weather stations. We adapt to your infrastructure, not the other way around.
              </p>
            </div>
            
            <div className="bg-paper-2 rounded p-6 border border-divider">
              <div className="inline-flex items-center justify-center w-12 h-12 bg-primary rounded-lg mb-4">
                <DollarSign className="w-6 h-6 text-white" />
              </div>
              <h4 className="text-xl font-bold text-ink mb-3">You Drive the Roadmap</h4>
              <p className="text-ink-2">
                Monthly feature reviews put you in control. Your operational challenges become our development priorities - the platform evolves with your needs.
              </p>
            </div>
          </div>
        </motion.div>

        {/* Competitive Comparison */}
        <motion.div
          className="bg-paper-2 rounded p-8 text-white"
          initial={{ opacity: 0, y: 30 }}
          animate={isInView ? { opacity: 1, y: 0 } : { opacity: 0, y: 30 }}
          transition={{ delay: 1.0, duration: 0.8 }}
        >
          <div className="text-center max-w-4xl mx-auto">
            <h3 className="text-3xl font-bold mb-6">
              The Smart Choice: Local Expertise at Startup Prices
            </h3>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mb-8">
              <div className="bg-paper/10 rounded-lg p-4">
                <h4 className="font-semibold mb-2">Monitoring Coverage</h4>
                <p className="text-sm text-data-fg-2">200+ strings per MW vs typical 4-8 inverter points</p>
              </div>
              <div className="bg-paper/10 rounded-lg p-4">
                <h4 className="font-semibold mb-2">Comprehensive Monitoring</h4>
                <p className="text-sm text-data-fg-2">String-level performance tracking and fault detection</p>
              </div>
              <div className="bg-paper/10 rounded-lg p-4">
                <h4 className="font-semibold mb-2">Fast Deployment</h4>
                <p className="text-sm text-data-fg-2">Start in weeks with existing SCADA integration</p>
              </div>
            </div>
            <p className="text-xl font-semibold">
              Local Dubai team vs remote European support • Gulf-optimized vs generic algorithms
            </p>
          </div>
        </motion.div>
      </div>
    </section>
  );
};

export default SolutionSection;