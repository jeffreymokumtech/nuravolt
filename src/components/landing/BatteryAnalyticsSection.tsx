'use client';

import { useRef } from 'react';
import { motion, useInView } from 'framer-motion';
import { Battery, Brain, TrendingUp, Shield, Zap, Activity, AlertTriangle, Calendar, Settings, Target } from 'lucide-react';

const BatteryAnalyticsSection = () => {
  const ref = useRef(null);
  const isInView = useInView(ref, { once: true, amount: 0.1 });

  const aiFeatures = [
    {
      icon: Brain,
      title: 'Predictive Maintenance',
      description: 'AI algorithms predict battery failures and degradation patterns, enabling proactive maintenance scheduling based on actual battery health rather than predetermined schedules.',
      iconColor: 'text-primary'
    },
    {
      icon: Settings,
      title: 'Adaptive Algorithms',
      description: 'Self-learning BMS that continuously improves accuracy over time, adapting to specific usage patterns and environmental conditions in Gulf climates.',
      iconColor: 'text-primary'
    },
    {
      icon: Activity,
      title: 'Real-Time Health Monitoring',
      description: 'Continuous monitoring of State of Health (SoH) metrics, accounting for charge cycles, temperature, load patterns, and aging effects specific to desert conditions.',
      iconColor: 'text-primary'
    }
  ];

  const batteryBenefits = [
    {
      icon: Target,
      title: 'Early Failure Detection',
      description: 'Identify accelerated aging or impending catastrophic failures before they occur, greatly enhancing battery reliability and safety.',
      metric: 'High accuracy'
    },
    {
      icon: TrendingUp,
      title: 'Extended Battery Life',
      description: 'Optimize charging patterns and operating conditions to extend battery lifespan significantly through predictive maintenance.',
      metric: 'Longer lifespan'
    },
    {
      icon: AlertTriangle,
      title: 'Intelligent Scheduling',
      description: 'Schedule maintenance based on actual needs rather than predetermined schedules, optimizing performance while minimizing unnecessary procedures.',
      metric: 'Reduced maintenance'
    }
  ];

  const containerVariants = {
    hidden: { opacity: 0 },
    visible: {
      opacity: 1,
      transition: {
        staggerChildren: 0.1
      }
    }
  };

  const itemVariants = {
    hidden: { opacity: 0, y: 20 },
    visible: {
      opacity: 1,
      y: 0,
      transition: { duration: 0.6 }
    }
  };

  return (
    <section ref={ref} className="py-20 bg-paper-2">
      <div className="container mx-auto px-4 sm:px-6 lg:px-8">
        {/* Header */}
        <motion.div
          className="text-center max-w-4xl mx-auto mb-16"
          initial={{ opacity: 0, y: 30 }}
          animate={isInView ? { opacity: 1, y: 0 } : { opacity: 0, y: 30 }}
          transition={{ duration: 0.8 }}
        >
          <div className="flex items-center justify-center mb-6">
            <Battery className="h-12 w-12 text-primary mr-4" />
            <h2 className="text-4xl sm:text-5xl font-bold text-ink">
              Battery-Ready for Saudi's 48GWh Future
            </h2>
          </div>
          <p className="text-xl text-ink-2 leading-relaxed mb-6">
            Only regional provider offering integrated PV + Battery analytics. Prepare for Saudi Vision 2030's massive storage deployment with AI-powered battery management systems.
          </p>
          <div className="bg-primary text-white px-6 py-3 rounded-full text-lg font-semibold inline-block">
            🚀 Extend battery life significantly through predictive maintenance
          </div>
        </motion.div>

        {/* AI Introduction */}
        <motion.div
          className="mb-20"
          variants={containerVariants}
          initial="hidden"
          animate={isInView ? "visible" : "hidden"}
        >
          <div className="bg-paper rounded p-8 shadow-sm border border-divider">
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-8 items-center">
              <div>
                <h3 className="text-3xl font-bold text-ink mb-6">
                  AI & Machine Learning in Battery Management
                </h3>
                <div className="space-y-4 text-ink-2">
                  <p>
                    Electric vehicles and their supporting systems, including Battery Management Systems (BMS), have become increasingly dependent on artificial intelligence (AI) and machine learning (ML). This paradigm shift results from an ongoing effort to increase performance, dependability, and safety.
                  </p>
                  <p>
                    In battery management, AI and ML have revolutionized intelligent systems capable of learning from data and making informed decisions. These technologies leverage vast amounts of real-time data and employ computational algorithms to extract valuable insights for predictive analytics, adaptive control mechanisms, and robust decision-making processes.
                  </p>
                  <p>
                    Due to the complex, nonlinear nature of battery behavior influenced by temperature, SOC, SOH, load dynamics, and aging effects, AI and ML techniques are particularly well-suited to battery management in Gulf conditions.
                  </p>
                </div>
              </div>
              <div className="bg-paper-2 rounded p-6 text-white">
                <div className="space-y-6">
                  <div className="flex items-center">
                    <Shield className="h-8 w-8 mr-3" />
                    <div>
                      <div className="text-2xl font-bold">High</div>
                      <div className="text-data-fg-2">Issue Detection Accuracy</div>
                    </div>
                  </div>
                  <div className="flex items-center">
                    <Zap className="h-8 w-8 mr-3" />
                    <div>
                      <div className="text-2xl font-bold">Excellent</div>
                      <div className="text-data-fg-2">Failure Prediction Accuracy</div>
                    </div>
                  </div>
                  <div className="flex items-center">
                    <Calendar className="h-8 w-8 mr-3" />
                    <div>
                      <div className="text-2xl font-bold">Extended</div>
                      <div className="text-data-fg-2">Battery Life</div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </motion.div>

        {/* Three Pillars */}
        <motion.div
          className="mb-20"
          variants={containerVariants}
          initial="hidden"
          animate={isInView ? "visible" : "hidden"}
        >
          <div className="text-center mb-12">
            <h3 className="text-3xl font-bold text-ink mb-4">
              Three Pillars of AI-Powered Battery Management
            </h3>
            <p className="text-xl text-ink-2">
              Revolutionary capabilities that transform battery performance and reliability
            </p>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-8">
            {aiFeatures.map((feature, index) => (
              <motion.div
                key={feature.title}
                variants={itemVariants}
                className="bg-paper rounded p-6 shadow-sm border border-divider hover:shadow-sm transition-shadow duration-300"
              >
                <div className={`inline-flex p-3 rounded-lg bg-paper-2 mb-4`}>
                  <feature.icon className={`h-8 w-8 ${feature.iconColor}`} />
                </div>
                <h4 className="text-xl font-bold text-ink mb-3">
                  {feature.title}
                </h4>
                <p className="text-ink-2 leading-relaxed">
                  {feature.description}
                </p>
              </motion.div>
            ))}
          </div>
        </motion.div>

        {/* Technical Deep Dive */}
        <motion.div
          className="mb-20"
          variants={containerVariants}
          initial="hidden"
          animate={isInView ? "visible" : "hidden"}
        >
          <div className="bg-paper rounded p-8 shadow-sm border border-divider">
            <h3 className="text-3xl font-bold text-ink mb-8 text-center">
              Advanced Battery Analytics Capabilities
            </h3>

            <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
              {batteryBenefits.map((benefit, index) => (
                <motion.div
                  key={benefit.title}
                  variants={itemVariants}
                  className="text-center"
                >
                  <div className="inline-flex p-4 rounded-full bg-paper-2 mb-4">
                    <benefit.icon className="h-10 w-10 text-primary" />
                  </div>
                  <h4 className="text-xl font-bold text-ink mb-2">
                    {benefit.title}
                  </h4>
                  <p className="text-ink-2 mb-4">
                    {benefit.description}
                  </p>
                  <div className="text-2xl font-bold text-primary">
                    {benefit.metric}
                  </div>
                </motion.div>
              ))}
            </div>
          </div>
        </motion.div>

        {/* Technical Details */}
        <motion.div
          className="grid grid-cols-1 lg:grid-cols-2 gap-8"
          variants={containerVariants}
          initial="hidden"
          animate={isInView ? "visible" : "hidden"}
        >
          <motion.div
            variants={itemVariants}
            className="bg-paper rounded p-6 shadow-sm border border-divider"
          >
            <h4 className="text-2xl font-bold text-ink mb-4">
              Battery Health Monitoring
            </h4>
            <div className="space-y-4 text-ink-2">
              <p>
                At the core of predictive maintenance is continuous monitoring of battery health using State of Health (SoH) metrics. Our AI models accurately assess battery health in real-time, accounting for all influencing factors including:
              </p>
              <ul className="space-y-2 ml-4">
                <li className="flex items-start">
                  <div className="w-2 h-2 bg-primary rounded-full mt-2 mr-3 flex-shrink-0"></div>
                  <span>Charge cycles and load patterns</span>
                </li>
                <li className="flex items-start">
                  <div className="w-2 h-2 bg-primary rounded-full mt-2 mr-3 flex-shrink-0"></div>
                  <span>Temperature variations in desert conditions</span>
                </li>
                <li className="flex items-start">
                  <div className="w-2 h-2 bg-primary rounded-full mt-2 mr-3 flex-shrink-0"></div>
                  <span>Aging effects and degradation patterns</span>
                </li>
                <li className="flex items-start">
                  <div className="w-2 h-2 bg-primary rounded-full mt-2 mr-3 flex-shrink-0"></div>
                  <span>Environmental stress factors</span>
                </li>
              </ul>
            </div>
          </motion.div>

          <motion.div
            variants={itemVariants}
            className="bg-paper rounded p-6 shadow-sm border border-divider"
          >
            <h4 className="text-2xl font-bold text-ink mb-4">
              Self-Learning BMS
            </h4>
            <div className="space-y-4 text-ink-2">
              <p>
                Our self-learning Battery Management System harnesses AI and ML techniques to continuously enhance accuracy and predictive capabilities over time. Key features include:
              </p>
              <ul className="space-y-2 ml-4">
                <li className="flex items-start">
                  <div className="w-2 h-2 bg-primary rounded-full mt-2 mr-3 flex-shrink-0"></div>
                  <span>Dynamic parameter adjustment based on historical performance</span>
                </li>
                <li className="flex items-start">
                  <div className="w-2 h-2 bg-primary rounded-full mt-2 mr-3 flex-shrink-0"></div>
                  <span>Adaptation to specific usage patterns and environmental conditions</span>
                </li>
                <li className="flex items-start">
                  <div className="w-2 h-2 bg-primary rounded-full mt-2 mr-3 flex-shrink-0"></div>
                  <span>Continuous refinement of SOC and SoH estimation algorithms</span>
                </li>
                <li className="flex items-start">
                  <div className="w-2 h-2 bg-primary rounded-full mt-2 mr-3 flex-shrink-0"></div>
                  <span>Predictive maintenance optimization for Gulf conditions</span>
                </li>
              </ul>
            </div>
          </motion.div>
        </motion.div>

        {/* Contact CTA */}
        <motion.div
          className="text-center mt-16"
          initial={{ opacity: 0, y: 30 }}
          animate={isInView ? { opacity: 1, y: 0 } : { opacity: 0, y: 30 }}
          transition={{ delay: 0.8, duration: 0.8 }}
        >
          <div className="bg-paper-2 rounded p-8 text-white">
            <h3 className="text-3xl font-bold mb-4">
              Ready for the Energy Storage Revolution?
            </h3>
            <p className="text-xl text-data-fg-2 mb-6 max-w-3xl mx-auto">
              Join the transition to intelligent battery management. Contact us for competitive pilot project pricing.
            </p>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 max-w-4xl mx-auto text-left">
              <div className="bg-paper/10 rounded-lg p-4">
                <h4 className="font-semibold mb-2">Initial Assessment</h4>
                <p className="text-sm text-data-fg-2">Site assessment and system architecture design</p>
              </div>
              <div className="bg-paper/10 rounded-lg p-4">
                <h4 className="font-semibold mb-2">Custom Integration</h4>
                <p className="text-sm text-data-fg-2">API integration with existing systems</p>
              </div>
              <div className="bg-paper/10 rounded-lg p-4">
                <h4 className="font-semibold mb-2">Dashboard Development</h4>
                <p className="text-sm text-data-fg-2">Client-specific dashboards and reporting</p>
              </div>
              <div className="bg-paper/10 rounded-lg p-4">
                <h4 className="font-semibold mb-2">Training & Support</h4>
                <p className="text-sm text-data-fg-2">Staff training and documentation</p>
              </div>
            </div>
            <p className="text-lg font-semibold mt-6 mb-4">
              YOU WILL OWN THE SOFTWARE we build for you
            </p>
            <p className="text-data-fg-2 mb-6">
              Arabic language UX, analytics optimized for Gulf conditions
            </p>
            <a
              href="mailto:contact@nuravolt.com"
              className="inline-block bg-paper text-primary hover:bg-paper-2 px-8 py-4 rounded-lg text-lg font-semibold transition-colors"
            >
              Contact Us for Battery Analytics Demo
            </a>
          </div>
        </motion.div>
      </div>
    </section>
  );
};

export default BatteryAnalyticsSection;