'use client';

import { useRef } from 'react';
import { motion, useInView } from 'framer-motion';
import { Zap, DollarSign, Wrench, Clock, Users, TrendingDown } from 'lucide-react';

const ROISection = () => {
  const ref = useRef(null);
  const isInView = useInView(ref, { once: true, amount: 0.2 });

  const metrics = [
    {
      icon: Zap,
      value: 'Significant',
      label: 'Annual power recovery',
      color: 'text-primary'
    },
    {
      icon: DollarSign,
      value: 'Substantial',
      label: 'O&M cost savings per year',
      color: 'text-primary'
    },
    {
      icon: Wrench,
      value: 'Fast',
      label: 'Typical ROI timeframe',
      color: 'text-primary'
    },
    {
      icon: Clock,
      value: 'Rapid',
      label: 'Implementation timeline',
      color: 'text-primary'
    }
  ];

  return (
    <section ref={ref} className="py-20 bg-paper">
      <div className="container mx-auto px-4 sm:px-6 lg:px-8">
        <motion.div
          className="text-center max-w-4xl mx-auto mb-16"
          initial={{ opacity: 0, y: 30 }}
          animate={isInView ? { opacity: 1, y: 0 } : { opacity: 0, y: 30 }}
          transition={{ duration: 0.8 }}
        >
          <h2 className="text-4xl sm:text-5xl font-bold text-ink mb-6">
            Example ROI: 50MW Solar Plant
          </h2>
          <p className="text-xl text-ink-2">
            Real results from physics-informed ML implementation - Contact us for your custom ROI calculation
          </p>
        </motion.div>

        {/* ROI Calculator Teaser */}
        <motion.div
          className="bg-paper-2 border border-divider rounded p-8 mb-12 max-w-4xl mx-auto"
          initial={{ opacity: 0, y: 30 }}
          animate={isInView ? { opacity: 1, y: 0 } : { opacity: 0, y: 30 }}
          transition={{ delay: 0.3, duration: 0.8 }}
        >
          <h3 className="text-2xl font-bold text-ink mb-6 text-center">
            Example: 50MW Desert Plant Analysis
          </h3>
          <div className="bg-signal-warning/5 border border-amber-300 rounded-lg p-4 mb-6">
            <p className="text-sm text-amber-800">
              <strong>Illustrative Example:</strong> Based on research from NREL, Sandia Labs, and Middle East operational data. Actual savings vary by site conditions, equipment configuration, and operational practices. Contact us for a custom ROI calculation for your facility.
            </p>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-8 mb-8">
            <div className="space-y-4">
              <h4 className="text-lg font-semibold text-ink mb-4">Power Recovery Benefits</h4>
              <div className="bg-paper rounded-lg p-4 border border-divider">
                <div className="text-sm text-primary mb-1">String-Level Failures</div>
                <div className="text-2xl font-bold text-ink">120 MWh/year</div>
                <div className="text-sm text-ink-2">0.83% annual failure rate detected</div>
              </div>
              <div className="bg-paper rounded-lg p-4 border border-divider">
                <div className="text-sm text-primary mb-1">Partial Degradation</div>
                <div className="text-2xl font-bold text-ink">86 MWh/year</div>
                <div className="text-sm text-ink-2">Gradual string performance loss</div>
              </div>
              <div className="bg-paper rounded-lg p-4 border border-divider">
                <div className="text-sm text-primary mb-1">Inverter Issues</div>
                <div className="text-2xl font-bold text-ink">180 MWh/year</div>
                <div className="text-sm text-ink-2">Conversion efficiency losses</div>
              </div>
              <div className="bg-paper rounded-lg p-4 border border-divider border-2">
                <div className="text-sm text-primary mb-1">Total Power Recovery</div>
                <div className="text-3xl font-bold text-ink">386 MWh/year</div>
                <div className="text-sm text-ink-2">@ $50/MWh = $19,300/year</div>
              </div>
            </div>
            <div className="space-y-4">
              <h4 className="text-lg font-semibold text-signal-positive mb-4">O&M Cost Savings</h4>
              <div className="bg-paper rounded-lg p-4 border border-green-300">
                <div className="text-sm text-primary mb-1">Reduced Diagnostic Time</div>
                <div className="text-2xl font-bold text-signal-positive">$13,000/year</div>
                <div className="text-sm text-ink-2">50-60% faster troubleshooting</div>
              </div>
              <div className="bg-paper rounded-lg p-4 border border-green-300">
                <div className="text-sm text-primary mb-1">First-Time Fix Rate</div>
                <div className="text-2xl font-bold text-signal-positive">$20,000/year</div>
                <div className="text-sm text-ink-2">Improved repair accuracy</div>
              </div>
              <div className="bg-paper rounded-lg p-4 border border-green-300">
                <div className="text-sm text-primary mb-1">Truck Roll Optimization</div>
                <div className="text-2xl font-bold text-signal-positive">$12,000/year</div>
                <div className="text-sm text-ink-2">16 fewer site visits annually</div>
              </div>
              <div className="bg-paper rounded-lg p-4 border border-green-400 border-2">
                <div className="text-sm text-primary mb-1">Total O&M Savings</div>
                <div className="text-3xl font-bold text-signal-positive">$50,000/year</div>
                <div className="text-sm text-ink-2">Labor + efficiency gains</div>
              </div>
            </div>
          </div>

          <div className="bg-paper rounded-lg p-6 border border-purple-300 mb-6">
            <h4 className="text-lg font-semibold text-purple-700 mb-3">Soiling Management Optimization</h4>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <div className="text-sm text-primary mb-1">Cleaning Cost Reduction</div>
                <div className="text-xl font-bold text-purple-700">$40,000-90,000/year</div>
                <div className="text-sm text-ink-2">Condition-based vs monthly cleaning</div>
              </div>
              <div>
                <div className="text-sm text-primary mb-1">Optimization Strategy</div>
                <div className="text-sm text-ink-2 leading-relaxed">Moving from monthly to condition-based cleaning saves 4-6 cleanings/year while maintaining optimal performance</div>
              </div>
            </div>
          </div>

          <div className="text-center bg-paper-2 border border-green-300 rounded p-8">
            <div className="text-4xl font-bold text-green-800 mb-2">$109,300 - $159,300</div>
            <div className="text-signal-positive font-semibold text-lg mb-2">Total Annual Benefit (Example 50MW Plant)</div>
            <div className="text-ink-2">Power recovery + O&M savings + Soiling optimization</div>
          </div>
        </motion.div>

        {/* In-House Development Comparison */}
        <motion.div
          className="bg-paper-2 border border-signal-critical/40 rounded p-8 mb-12 max-w-4xl mx-auto"
          initial={{ opacity: 0, y: 30 }}
          animate={isInView ? { opacity: 1, y: 0 } : { opacity: 0, y: 30 }}
          transition={{ delay: 0.5, duration: 0.8 }}
        >
          <h3 className="text-2xl font-bold text-ink mb-6 text-center">
            Why Not Build In-House? The Real Costs
          </h3>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
            <div className="space-y-4">
              <h4 className="text-lg font-semibold text-signal-critical flex items-center">
                <TrendingDown className="w-5 h-5 mr-2" />
                In-House Development Reality
              </h4>
              <ul className="space-y-3 text-ink-2">
                <li className="flex items-start">
                  <span className="text-signal-critical mr-2">•</span>
                  <span>Multiple engineers required</span>
                </li>
                <li className="flex items-start">
                  <span className="text-signal-critical mr-2">•</span>
                  <span>Extended development time</span>
                </li>
                <li className="flex items-start">
                  <span className="text-signal-critical mr-2">•</span>
                  <span>Massive initial investment</span>
                </li>
                <li className="flex items-start">
                  <span className="text-signal-critical mr-2">•</span>
                  <span>Ongoing maintenance team required</span>
                </li>
                <li className="flex items-start">
                  <span className="text-signal-critical mr-2">•</span>
                  <span>No guarantee of success</span>
                </li>
              </ul>
            </div>
            <div className="space-y-4">
              <h4 className="text-lg font-semibold text-signal-positive flex items-center">
                <Users className="w-5 h-5 mr-2" />
                NuraVolt Custom Platform
              </h4>
              <ul className="space-y-3 text-ink-2">
                <li className="flex items-start">
                  <span className="text-signal-positive mr-2">✓</span>
                  <span>Significantly lower cost than in-house</span>
                </li>
                <li className="flex items-start">
                  <span className="text-signal-positive mr-2">✓</span>
                  <span>Rapid deployment</span>
                </li>
                <li className="flex items-start">
                  <span className="text-signal-positive mr-2">✓</span>
                  <span>Proven technology, proven results</span>
                </li>
                <li className="flex items-start">
                  <span className="text-signal-positive mr-2">✓</span>
                  <span>We handle all maintenance & updates</span>
                </li>
                <li className="flex items-start">
                  <span className="text-signal-positive mr-2">✓</span>
                  <span>You control the feature roadmap</span>
                </li>
              </ul>
            </div>
          </div>
          <div className="mt-6 p-4 bg-paper-2 border border-green-300 rounded-lg text-center">
            <p className="text-green-800 font-semibold">
              Save significantly while getting a superior, custom-built solution in a fraction of the time
            </p>
          </div>
        </motion.div>

        {/* Value Evolution Roadmap */}
        <motion.div
          className="bg-paper-2 border border-divider rounded p-8 mb-12 max-w-4xl mx-auto"
          initial={{ opacity: 0, y: 30 }}
          animate={isInView ? { opacity: 1, y: 0 } : { opacity: 0, y: 30 }}
          transition={{ delay: 0.7, duration: 0.8 }}
        >
          <h3 className="text-2xl font-bold text-ink mb-4 text-center">
            Your Value Evolution Roadmap
          </h3>
          <p className="text-center text-ink-2 mb-8">
            Start with immediate ROI from ML detection, then evolve to predictive analytics for enhanced value
          </p>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
            <div className="bg-paper rounded p-6 border-2 border-divider shadow-sm">
              <div className="flex items-center gap-3 mb-4">
                <div className="bg-paper-2 rounded-full px-4 py-2">
                  <span className="text-primary font-bold">Phase 1</span>
                </div>
                <h4 className="text-xl font-bold text-ink">ML Detection</h4>
              </div>
              <div className="mb-4">
                <div className="text-3xl font-bold text-primary mb-2">First ROI</div>
                <div className="text-sm text-ink-2 mb-3">Immediate Value Generation</div>
              </div>
              <ul className="space-y-2 text-sm text-ink-2">
                <li className="flex items-start">
                  <span className="text-primary mr-2">✓</span>
                  <span>Real-time anomaly detection with 92% accuracy</span>
                </li>
                <li className="flex items-start">
                  <span className="text-primary mr-2">✓</span>
                  <span>Immediate alerts when performance deviations occur</span>
                </li>
                <li className="flex items-start">
                  <span className="text-primary mr-2">✓</span>
                  <span>Rapid response to equipment failures and soiling events</span>
                </li>
                <li className="flex items-start">
                  <span className="text-primary mr-2">✓</span>
                  <span>Start recovering lost revenue from day one</span>
                </li>
              </ul>
            </div>

            <div className="bg-paper rounded p-6 border-2 border-purple-400 shadow-sm">
              <div className="flex items-center gap-3 mb-4">
                <div className="bg-paper-2 rounded-full px-4 py-2">
                  <span className="text-purple-700 font-bold">Phase 2</span>
                </div>
                <h4 className="text-xl font-bold text-ink">Predictive Analytics</h4>
              </div>
              <div className="mb-4">
                <div className="text-3xl font-bold text-primary mb-2">Enhanced ROI</div>
                <div className="text-sm text-ink-2 mb-3">Evolving Value Creation</div>
              </div>
              <ul className="space-y-2 text-sm text-ink-2">
                <li className="flex items-start">
                  <span className="text-purple-500 mr-2">→</span>
                  <span>7-14 day advance failure prediction from degradation patterns</span>
                </li>
                <li className="flex items-start">
                  <span className="text-purple-500 mr-2">→</span>
                  <span>Automated work order generation with optimal timing</span>
                </li>
                <li className="flex items-start">
                  <span className="text-purple-500 mr-2">→</span>
                  <span>Planned maintenance scheduling for maximum uptime</span>
                </li>
                <li className="flex items-start">
                  <span className="text-purple-500 mr-2">→</span>
                  <span>Further cost reduction through proactive intervention</span>
                </li>
              </ul>
            </div>
          </div>

          <div className="mt-6 bg-paper-2 border border-divider rounded-lg p-4">
            <p className="text-ink text-sm text-center">
              <strong>Progressive Value Building:</strong> Phase 1 delivers immediate ROI while collecting data to enable Phase 2's predictive capabilities. Your investment grows more valuable over time as the system learns your specific plant characteristics.
            </p>
          </div>
        </motion.div>

        {/* Key Metrics */}
        <motion.div
          className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-8"
          initial={{ opacity: 0 }}
          animate={isInView ? { opacity: 1 } : { opacity: 0 }}
          transition={{ delay: 0.8, staggerChildren: 0.1 }}
        >
          {metrics.map((metric, index) => (
            <motion.div
              key={metric.label}
              className="text-center bg-paper rounded p-6 shadow-sm border border-divider"
              initial={{ opacity: 0, y: 30 }}
              animate={isInView ? { opacity: 1, y: 0 } : { opacity: 0, y: 30 }}
              transition={{ delay: 0.8 + index * 0.1 }}
            >
              <div className={`inline-flex items-center justify-center w-16 h-16 ${metric.color.replace('text-', 'bg-').replace('-600', '-100')} rounded-full mb-4`}>
                <metric.icon className={`w-8 h-8 ${metric.color}`} />
              </div>
              <div className={`text-3xl font-bold ${metric.color} mb-2`}>
                {metric.value}
              </div>
              <div className="text-ink-2 font-medium">
                {metric.label}
              </div>
            </motion.div>
          ))}
        </motion.div>

        {/* CTA */}
        <motion.div
          className="text-center mt-16"
          initial={{ opacity: 0, y: 30 }}
          animate={isInView ? { opacity: 1, y: 0 } : { opacity: 0, y: 30 }}
          transition={{ delay: 1.2, duration: 0.8 }}
        >
          <div className="bg-paper-2 border border-divider rounded p-8 max-w-2xl mx-auto">
            <h3 className="text-2xl font-bold text-ink mb-4">
              Get Your Accurate ROI Calculation
            </h3>
            <p className="text-primary mb-6">
              Every plant is unique. Contact our international team for a personalized ROI analysis based on your specific plant size, location, climate conditions, and operational data.
            </p>
            <a
              href="mailto:contact@nuravolt.com"
              className="inline-block bg-primary hover:bg-primary text-white px-8 py-4 rounded-lg text-lg font-semibold transition-colors"
            >
              Contact Us for Custom ROI Analysis
            </a>
          </div>
        </motion.div>
      </div>
    </section>
  );
};

export default ROISection;