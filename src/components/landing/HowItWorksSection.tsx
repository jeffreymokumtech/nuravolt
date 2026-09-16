'use client';

import { useRef } from 'react';
import { motion, useInView } from 'framer-motion';
import { Database, Brain, AlertCircle, Sparkles } from 'lucide-react';

const HowItWorksSection = () => {
  const ref = useRef(null);
  const isInView = useInView(ref, { once: true, amount: 0.2 });

  const steps = [
    {
      number: '1',
      title: 'Week 1-2: Custom Integration',
      subtitle: 'Your Stack, Your Way',
      description: 'We integrate with YOUR specific SCADA, ERP, CMMS systems - seamless compatibility. Our platform adapts to your infrastructure, not the other way around.',
      icon: Database,
      color: 'blue'
    },
    {
      number: '2',
      title: 'Week 3-4: Tailored Pilot',
      subtitle: 'Your Requirements First',
      description: 'Deploy on your chosen test area with features customized to your operational priorities. You define success metrics, we deliver against them.',
      icon: Brain,
      color: 'blue'
    },
    {
      number: '3',
      title: 'Week 5-8: Scale Your Way',
      subtitle: 'Grows With You',
      description: 'Expand at your pace - from 10MW to 1000MW+. Monthly feature reviews ensure the platform evolves with your changing needs.',
      icon: AlertCircle,
      color: 'blue'
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

  const stepVariants = {
    hidden: { opacity: 0, y: 50 },
    visible: { 
      opacity: 1, 
      y: 0,
      transition: {
        duration: 0.8
      }
    }
  };

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
            8-Week Implementation with Machine Learning Calibration
          </h2>
          <p className="text-xl text-ink-2">
            Pilot program approach with pre-trained UAE/GCC models
          </p>
        </motion.div>

        <motion.div
          className="grid grid-cols-1 md:grid-cols-3 gap-8 max-w-6xl mx-auto"
          variants={containerVariants}
          initial="hidden"
          animate={isInView ? "visible" : "hidden"}
        >
          {steps.map((step, index) => (
            <motion.div
              key={step.number}
              variants={stepVariants}
              className="relative"
            >
              {/* Connection line */}
              {index < steps.length - 1 && (
                <div className="hidden md:block absolute top-16 left-full w-full h-0.5 bg-divider z-0">
                  <motion.div
                    className="h-full bg-primary"
                    initial={{ width: 0 }}
                    animate={isInView ? { width: '100%' } : { width: 0 }}
                    transition={{ delay: 0.5 + index * 0.3, duration: 0.8 }}
                  />
                </div>
              )}
              
              <div className="bg-paper rounded p-8 shadow-sm border border-divider relative z-10">
                {/* Step number */}
                <div className={`inline-flex items-center justify-center w-12 h-12 bg-primary text-white rounded-full text-xl font-bold mb-6`}>
                  {step.number}
                </div>
                
                {/* Icon */}
                <div className="mb-6">
                  <step.icon className="w-12 h-12 text-primary" />
                </div>
                
                {/* Content */}
                <h3 className="text-2xl font-bold text-ink mb-2">
                  {step.title}
                </h3>
                <p className="text-primary font-semibold mb-4">
                  {step.subtitle}
                </p>
                <p className="text-ink-2 leading-relaxed">
                  {step.description}
                </p>
              </div>
            </motion.div>
          ))}
        </motion.div>

        {/* Customization Benefits */}
        <motion.div
          className="mt-16 mb-8"
          initial={{ opacity: 0, y: 30 }}
          animate={isInView ? { opacity: 1, y: 0 } : { opacity: 0, y: 30 }}
          transition={{ delay: 1.0, duration: 0.8 }}
        >
          <div className="bg-paper-2 rounded p-8 max-w-5xl mx-auto border border-purple-200">
            <div className="flex items-center justify-center mb-6">
              <Sparkles className="w-8 h-8 text-primary mr-3" />
              <h3 className="text-2xl font-bold text-ink">
                Your Platform Evolves With Your Needs
              </h3>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-6 text-center">
              <div>
                <div className="text-3xl font-bold text-primary mb-2">100%</div>
                <p className="text-ink-2">Guaranteed integration with your existing systems</p>
              </div>
              <div>
                <div className="text-3xl font-bold text-primary mb-2">Monthly</div>
                <p className="text-ink-2">Feature reviews where you set priorities</p>
              </div>
              <div>
                <div className="text-3xl font-bold text-primary mb-2">70% Less</div>
                <p className="text-ink-2">Than building this solution in-house</p>
              </div>
            </div>
          </div>
        </motion.div>

      </div>
    </section>
  );
};

export default HowItWorksSection;