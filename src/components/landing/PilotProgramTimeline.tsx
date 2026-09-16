'use client';

import { useRef } from 'react';
import { motion, useInView } from 'framer-motion';
import {
  FileText,
  Settings,
  Zap,
  BarChart3,
  CheckCircle,
  ArrowRight,
  Clock,
  Target
} from 'lucide-react';
import { Button } from '@/components/ui/button';

interface PilotProgramTimelineProps {
  onContactClick?: () => void;
}

const PilotProgramTimeline = ({ onContactClick }: PilotProgramTimelineProps) => {
  const ref = useRef(null);
  const isInView = useInView(ref, { once: true, amount: 0.2 });

  const phases = [
    {
      week: 'Phase 1',
      title: 'Discovery & Integration',
      icon: FileText,
      color: 'blue',
      tasks: [
        'Site assessment and data quality review',
        'SCADA/BMS integration setup',
        'Historical data ingestion',
        'Baseline performance establishment'
      ],
      deliverable: 'Integration complete, data flowing'
    },
    {
      week: 'Phase 2',
      title: 'Model Calibration',
      icon: Settings,
      color: 'blue',
      tasks: [
        'Physics model calibration for your plant',
        'ML model training on your data',
        'Custom dashboard configuration',
        'Alert threshold tuning'
      ],
      deliverable: 'Calibrated digital twin running'
    },
    {
      week: 'Phase 3',
      title: 'Live Monitoring',
      icon: Zap,
      color: 'blue',
      tasks: [
        'Real-time anomaly detection active',
        'Performance gap identification',
        'Initial fault predictions',
        'Team training on platform'
      ],
      deliverable: 'Live monitoring with alerts'
    },
    {
      week: 'Phase 4',
      title: 'Results & ROI Proof',
      icon: BarChart3,
      color: 'blue',
      tasks: [
        'Comprehensive performance report',
        'Quantified savings and prevented losses',
        'ROI calculation and forecast',
        'Decision on full deployment'
      ],
      deliverable: 'ROI proof and contract decision'
    }
  ];

  const guarantees = [
    {
      icon: Target,
      title: 'Results Validation',
      description: 'Measure actual performance improvements with your data'
    },
    {
      icon: Clock,
      title: 'Fast Integration',
      description: '2-3 weeks from kickoff to live monitoring'
    },
    {
      icon: CheckCircle,
      title: 'No Long-Term Commitment',
      description: 'Pilot proves value before annual contract'
    }
  ];

  const containerVariants = {
    hidden: { opacity: 0 },
    visible: {
      opacity: 1,
      transition: {
        staggerChildren: 0.15
      }
    }
  };

  const itemVariants = {
    hidden: { opacity: 0, x: -50 },
    visible: {
      opacity: 1,
      x: 0,
      transition: {
        duration: 0.6,
        ease: 'easeOut'
      }
    }
  };

  return (
    <section ref={ref} className="py-16 sm:py-24 bg-gradient-to-br from-gray-50 to-gray-100">
      <div className="container mx-auto px-4 sm:px-6 lg:px-8">
        <motion.div
          className="text-center mb-16"
          initial={{ opacity: 0, y: 30 }}
          animate={isInView ? { opacity: 1, y: 0 } : { opacity: 0, y: 30 }}
          transition={{ duration: 0.8 }}
        >
          <div className="inline-block bg-blue-100 text-blue-600 px-4 py-2 rounded-full text-sm font-semibold mb-4">
            Customized Pilot Program
          </div>
          <h2 className="text-3xl sm:text-4xl lg:text-5xl font-bold text-gray-900 mb-4">
            Customized Pilot Plan for Your Plants
          </h2>
          <p className="text-xl text-gray-600 max-w-3xl mx-auto">
            Our structured pilot program proves value with your actual data before any long-term commitment. Get in touch for a customized pilot plan tailored to your plant's specific requirements.
          </p>
        </motion.div>

        {/* Timeline */}
        <motion.div
          className="max-w-6xl mx-auto mb-16"
          variants={containerVariants}
          initial="hidden"
          animate={isInView ? "visible" : "hidden"}
        >
          <div className="space-y-6">
            {phases.map((phase, index) => {
              const colorMap = {
                blue: {
                  bg: 'bg-blue-100',
                  text: 'text-blue-600',
                  border: 'border-blue-300',
                  gradient: 'from-blue-600 to-blue-700'
                },
                purple: {
                  bg: 'bg-blue-100',
                  text: 'text-blue-400',
                  border: 'border-purple-300',
                  gradient: 'from-blue-400 to-purple-700'
                },
                orange: {
                  bg: 'bg-blue-100',
                  text: 'text-blue-600',
                  border: 'border-orange-300',
                  gradient: 'from-blue-600 to-orange-700'
                },
                green: {
                  bg: 'bg-blue-100',
                  text: 'text-blue-500',
                  border: 'border-green-300',
                  gradient: 'from-blue-500 to-green-700'
                }
              };

              const colors = colorMap[phase.color as keyof typeof colorMap];

              return (
                <motion.div
                  key={index}
                  variants={itemVariants}
                  className="relative"
                >
                  <div className="flex flex-col md:flex-row gap-6 items-start">
                    {/* Phase Icon & Number */}
                    <div className="flex-shrink-0">
                      <div className={`w-20 h-20 rounded-xl bg-gradient-to-br ${colors.gradient} flex items-center justify-center shadow-lg`}>
                        <phase.icon className="w-10 h-10 text-white" />
                      </div>
                      <div className={`mt-2 text-center text-sm font-bold ${colors.text}`}>
                        {phase.week}
                      </div>
                    </div>

                    {/* Phase Content */}
                    <div className="flex-1 bg-white rounded-xl p-6 shadow-lg border-2 border-gray-200 hover:border-gray-300 transition-colors">
                      <h3 className="text-2xl font-bold text-gray-900 mb-4">
                        {phase.title}
                      </h3>

                      <div className="grid md:grid-cols-2 gap-6">
                        {/* Tasks */}
                        <div>
                          <h4 className="text-sm font-semibold text-gray-500 uppercase mb-3">
                            Key Activities
                          </h4>
                          <ul className="space-y-2">
                            {phase.tasks.map((task, idx) => (
                              <li key={idx} className="flex items-start text-gray-700">
                                <CheckCircle className={`w-5 h-5 mr-2 mt-0.5 flex-shrink-0 ${colors.text}`} />
                                <span>{task}</span>
                              </li>
                            ))}
                          </ul>
                        </div>

                        {/* Deliverable */}
                        <div>
                          <h4 className="text-sm font-semibold text-gray-500 uppercase mb-3">
                            Phase Deliverable
                          </h4>
                          <div className={`${colors.bg} rounded-lg p-4 border-2 ${colors.border}`}>
                            <div className="flex items-center">
                              <Target className={`w-6 h-6 mr-3 ${colors.text}`} />
                              <span className="font-semibold text-gray-900">
                                {phase.deliverable}
                              </span>
                            </div>
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>

                  {/* Connector Arrow */}
                  {index < phases.length - 1 && (
                    <div className="hidden md:flex justify-center my-4">
                      <ArrowRight className="w-8 h-8 text-gray-400" />
                    </div>
                  )}
                </motion.div>
              );
            })}
          </div>
        </motion.div>

        {/* Benefits Section */}
        <motion.div
          className="max-w-5xl mx-auto"
          initial={{ opacity: 0, y: 30 }}
          animate={isInView ? { opacity: 1, y: 0 } : { opacity: 0, y: 30 }}
          transition={{ delay: 0.6, duration: 0.8 }}
        >
          <div className="bg-gradient-to-br from-blue-600 to-blue-400 rounded-2xl p-8 sm:p-12 text-white shadow-2xl">
            <h3 className="text-2xl sm:text-3xl font-bold mb-8 text-center">
              Pilot Program Benefits
            </h3>

            <div className="grid md:grid-cols-3 gap-8 mb-8">
              {guarantees.map((guarantee, index) => (
                <div key={index} className="text-center">
                  <div className="inline-flex items-center justify-center w-16 h-16 bg-white bg-opacity-20 rounded-full mb-4">
                    <guarantee.icon className="w-8 h-8 text-white" />
                  </div>
                  <h4 className="text-lg font-bold mb-2">{guarantee.title}</h4>
                  <p className="text-blue-100">{guarantee.description}</p>
                </div>
              ))}
            </div>

            <div className="text-center">
              <Button
                size="lg"
                className="bg-white text-blue-600 hover:bg-gray-100 px-8 py-4 text-lg"
                onClick={onContactClick}
              >
                Start Your Pilot Program →
              </Button>
            </div>
          </div>
        </motion.div>
      </div>
    </section>
  );
};

export default PilotProgramTimeline;
