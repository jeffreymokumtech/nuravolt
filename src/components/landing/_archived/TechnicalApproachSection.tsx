'use client';

import { useState, useRef } from 'react';
import { motion, useInView } from 'framer-motion';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Brain, Zap, Shield, BarChart3, Cloud, Cpu, ChevronDown, Download, ExternalLink } from 'lucide-react';

const features = [
  {
    icon: Brain,
    title: 'AI-Powered Predictions',
    description: 'Machine learning models trained on millions of data points to predict failures before they happen'
  },
  {
    icon: Zap,
    title: 'Real-time Processing',
    description: 'Sub-second data processing from inverters, weather stations, and grid connections'
  },
  {
    icon: Shield,
    title: 'Anomaly Detection',
    description: 'Advanced algorithms identify performance deviations and potential issues instantly'
  },
  {
    icon: BarChart3,
    title: 'Revenue Optimization',
    description: 'Dynamic strategies to maximize power generation and minimize downtime'
  },
  {
    icon: Cloud,
    title: 'Cloud-Native Architecture',
    description: 'Scalable infrastructure that grows with your solar portfolio'
  },
  {
    icon: Cpu,
    title: 'Edge Computing',
    description: 'On-site processing capabilities for critical real-time decisions'
  }
];

const compatibleSystems = [
  'SMA', 'Sungrow', 'Huawei', 'Fronius', 'SolarEdge', 'Enphase',
  'ABB', 'Schneider Electric', 'GE', 'Siemens'
];

const TechnicalApproachSection = () => {
  const [expandedDetails, setExpandedDetails] = useState(false);
  const [hoveredStep, setHoveredStep] = useState<number | null>(null);
  const ref = useRef(null);
  const isInView = useInView(ref, { once: true, amount: 0.1 });

  const processSteps = [
    { 
      title: 'Data Collection', 
      description: 'Continuous monitoring of inverters, weather data, and grid metrics',
      detail: 'Our system connects to over 50+ inverter brands using Modbus-TCP, OPC UA, and REST APIs, collecting 1000+ data points per second.',
      color: 'from-blue-500 to-cyan-500'
    },
    { 
      title: 'Pattern Analysis', 
      description: 'AI models identify trends, anomalies, and optimization opportunities',
      detail: 'Advanced machine learning algorithms process historical and real-time data to identify patterns invisible to traditional monitoring.',
      color: 'from-purple-500 to-pink-500'
    },
    { 
      title: 'Predictive Insights', 
      description: 'Forecast failures, optimize maintenance, and maximize generation',
      detail: 'Our models predict equipment failures up to 30 days in advance with 97% accuracy, enabling proactive maintenance.',
      color: 'from-green-500 to-emerald-500'
    },
    { 
      title: 'Actionable Recommendations', 
      description: 'Clear guidance on when and how to act for maximum ROI',
      detail: 'Automated workflows and alerts ensure your team receives prioritized, actionable insights exactly when they need them.',
      color: 'from-orange-500 to-red-500'
    }
  ];

  return (
    <section ref={ref} className="py-16 sm:py-24 bg-white">
      <div className="container mx-auto px-4 sm:px-6 lg:px-8">
        <motion.div 
          className="text-center max-w-3xl mx-auto mb-12"
          initial={{ opacity: 0, y: 30 }}
          animate={isInView ? { opacity: 1, y: 0 } : { opacity: 0, y: 30 }}
          transition={{ duration: 0.8 }}
        >
          <h2 className="text-3xl sm:text-4xl font-bold text-gray-900 mb-4">
            Advanced Technology for Solar Excellence
          </h2>
          <p className="text-xl text-gray-600">
            Our AI-driven platform combines cutting-edge technology with deep solar industry expertise
          </p>
        </motion.div>

        <motion.div 
          className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6 mb-16"
          initial={{ opacity: 0 }}
          animate={isInView ? { opacity: 1 } : { opacity: 0 }}
          transition={{ delay: 0.3, staggerChildren: 0.1 }}
        >
          {features.map((feature, index) => (
            <motion.div
              key={feature.title}
              initial={{ opacity: 0, y: 40 }}
              animate={isInView ? { opacity: 1, y: 0 } : { opacity: 0, y: 40 }}
              transition={{ delay: 0.4 + index * 0.1 }}
            >
              <Card className="hover:shadow-xl transition-all duration-300 group cursor-pointer">
                <CardContent className="p-6">
                  <motion.div
                    whileHover={{ scale: 1.1, rotate: 360 }}
                    transition={{ duration: 0.6 }}
                  >
                    <feature.icon className="h-12 w-12 text-blue-600 mb-4 group-hover:text-blue-700" />
                  </motion.div>
                  <h3 className="text-xl font-semibold mb-2 group-hover:text-blue-600 transition-colors">{feature.title}</h3>
                  <p className="text-gray-600">{feature.description}</p>
                </CardContent>
              </Card>
            </motion.div>
          ))}
        </motion.div>

        <motion.div 
          className="bg-gradient-to-br from-blue-50 to-indigo-100 rounded-2xl p-8 md:p-12 relative overflow-hidden"
          initial={{ opacity: 0, scale: 0.95 }}
          animate={isInView ? { opacity: 1, scale: 1 } : { opacity: 0, scale: 0.95 }}
          transition={{ delay: 0.6, duration: 0.8 }}
        >
          {/* Animated background pattern */}
          <div className="absolute inset-0 opacity-5">
            <svg className="w-full h-full" viewBox="0 0 100 100">
              <motion.circle
                cx="20" cy="20" r="2" fill="currentColor"
                animate={{ scale: [1, 1.5, 1], opacity: [0.3, 0.8, 0.3] }}
                transition={{ duration: 3, repeat: Infinity }}
              />
              <motion.circle
                cx="80" cy="30" r="1.5" fill="currentColor"
                animate={{ scale: [1, 2, 1], opacity: [0.2, 0.6, 0.2] }}
                transition={{ duration: 4, repeat: Infinity, delay: 1 }}
              />
              <motion.circle
                cx="60" cy="80" r="1" fill="currentColor"
                animate={{ scale: [1, 3, 1], opacity: [0.1, 0.4, 0.1] }}
                transition={{ duration: 5, repeat: Infinity, delay: 2 }}
              />
            </svg>
          </div>
          
          <div className="grid grid-cols-1 md:grid-cols-2 gap-8 items-center relative z-10">
            <div>
              <h3 className="text-2xl font-bold text-gray-900 mb-6">
                How Our AI Works
              </h3>
              
              {/* Interactive flow diagram */}
              <div className="space-y-4">
                {processSteps.map((step, index) => (
                  <motion.div
                    key={step.title}
                    className="relative"
                    onMouseEnter={() => setHoveredStep(index)}
                    onMouseLeave={() => setHoveredStep(null)}
                    initial={{ opacity: 0, x: -50 }}
                    animate={isInView ? { opacity: 1, x: 0 } : { opacity: 0, x: -50 }}
                    transition={{ delay: 0.8 + index * 0.2 }}
                  >
                    {/* Connection line */}
                    {index < processSteps.length - 1 && (
                      <motion.div
                        className="absolute left-4 top-12 w-px h-8 bg-gradient-to-b from-blue-400 to-transparent"
                        initial={{ scaleY: 0 }}
                        animate={isInView ? { scaleY: 1 } : { scaleY: 0 }}
                        transition={{ delay: 1 + index * 0.2, duration: 0.5 }}
                      />
                    )}
                    
                    <div className="flex items-start cursor-pointer group">
                      <motion.div
                        className={`w-8 h-8 rounded-full flex items-center justify-center flex-shrink-0 mr-4 text-white font-semibold text-sm bg-gradient-to-r ${step.color} shadow-lg`}
                        whileHover={{ scale: 1.1 }}
                        animate={{
                          boxShadow: hoveredStep === index 
                            ? "0 8px 25px rgba(59, 130, 246, 0.4)" 
                            : "0 4px 15px rgba(59, 130, 246, 0.2)"
                        }}
                      >
                        {index + 1}
                      </motion.div>
                      <div className="flex-1">
                        <h4 className="font-semibold text-gray-900 group-hover:text-blue-600 transition-colors">
                          {step.title}
                        </h4>
                        <p className="text-gray-600 mt-1 text-sm leading-relaxed">
                          {step.description}
                        </p>
                        <motion.p
                          className="text-blue-600 mt-2 text-xs font-medium"
                          initial={{ opacity: 0, height: 0 }}
                          animate={{
                            opacity: hoveredStep === index ? 1 : 0,
                            height: hoveredStep === index ? 'auto' : 0
                          }}
                          transition={{ duration: 0.3 }}
                        >
                          {step.detail}
                        </motion.p>
                      </div>
                    </div>
                  </motion.div>
                ))}
              </div>
              
              <motion.div
                className="mt-8"
                initial={{ opacity: 0 }}
                animate={isInView ? { opacity: 1 } : { opacity: 0 }}
                transition={{ delay: 1.5 }}
              >
                <Button
                  variant="outline"
                  className="text-blue-600 border-blue-600 hover:bg-blue-50"
                  onClick={() => setExpandedDetails(!expandedDetails)}
                >
                  <Download className="w-4 h-4 mr-2" />
                  Technical Whitepaper
                  <ExternalLink className="w-4 h-4 ml-2" />
                </Button>
              </motion.div>
            </div>
            
            <motion.div 
              className="bg-white rounded-xl p-6 shadow-xl border border-blue-100"
              initial={{ opacity: 0, y: 30 }}
              animate={isInView ? { opacity: 1, y: 0 } : { opacity: 0, y: 30 }}
              transition={{ delay: 1, duration: 0.8 }}
            >
              <h4 className="text-lg font-semibold mb-4 text-gray-900">Compatible Systems</h4>
              <div className="flex flex-wrap gap-2 mb-4">
                {compatibleSystems.map((system, index) => (
                  <motion.span
                    key={system}
                    className="px-3 py-2 bg-gradient-to-r from-blue-50 to-indigo-50 text-blue-700 rounded-full text-sm font-medium border border-blue-200 hover:shadow-md transition-all cursor-pointer"
                    initial={{ opacity: 0, scale: 0.8 }}
                    animate={isInView ? { opacity: 1, scale: 1 } : { opacity: 0, scale: 0.8 }}
                    transition={{ delay: 1.2 + index * 0.05 }}
                    whileHover={{ scale: 1.05 }}
                  >
                    {system}
                  </motion.span>
                ))}
              </div>
              
              <motion.div
                className="bg-gradient-to-r from-blue-50 to-purple-50 rounded-lg p-4 border border-blue-100"
                initial={{ opacity: 0 }}
                animate={isInView ? { opacity: 1 } : { opacity: 0 }}
                transition={{ delay: 1.5 }}
              >
                <p className="text-gray-700 text-sm font-medium mb-2">
                  🔌 Protocol Support:
                </p>
                <div className="flex flex-wrap gap-2">
                  {['Modbus-TCP', 'OPC UA', 'REST APIs', 'MQTT', 'SunSpec'].map((protocol) => (
                    <span key={protocol} className="text-xs bg-white px-2 py-1 rounded border text-gray-600">
                      {protocol}
                    </span>
                  ))}
                </div>
              </motion.div>
            </motion.div>
          </div>
          
          {/* Expandable technical details */}
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{
              height: expandedDetails ? 'auto' : 0,
              opacity: expandedDetails ? 1 : 0
            }}
            transition={{ duration: 0.5, ease: "easeInOut" }}
            className="overflow-hidden"
          >
            <div className="mt-8 pt-8 border-t border-blue-200">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                <div className="bg-white rounded-lg p-6 shadow-lg">
                  <h5 className="font-semibold text-gray-900 mb-3">Architecture Diagram</h5>
                  <div className="bg-gradient-to-br from-blue-100 to-purple-100 rounded-lg p-4 h-32 flex items-center justify-center">
                    <span className="text-gray-600 text-sm">Interactive Architecture Diagram</span>
                  </div>
                </div>
                <div className="bg-white rounded-lg p-6 shadow-lg">
                  <h5 className="font-semibold text-gray-900 mb-3">Performance Metrics</h5>
                  <div className="space-y-3">
                    <div className="flex justify-between items-center">
                      <span className="text-sm text-gray-600">Data Processing Speed</span>
                      <div className="flex items-center">
                        <div className="w-20 h-2 bg-gray-200 rounded-full overflow-hidden">
                          <motion.div
                            className="h-full bg-blue-500"
                            initial={{ width: 0 }}
                            animate={{ width: expandedDetails ? '95%' : 0 }}
                            transition={{ delay: 0.5, duration: 1 }}
                          />
                        </div>
                        <span className="text-sm font-medium ml-2">95%</span>
                      </div>
                    </div>
                    <div className="flex justify-between items-center">
                      <span className="text-sm text-gray-600">Prediction Accuracy</span>
                      <div className="flex items-center">
                        <div className="w-20 h-2 bg-gray-200 rounded-full overflow-hidden">
                          <motion.div
                            className="h-full bg-blue-500"
                            initial={{ width: 0 }}
                            animate={{ width: expandedDetails ? '97%' : 0 }}
                            transition={{ delay: 0.7, duration: 1 }}
                          />
                        </div>
                        <span className="text-sm font-medium ml-2">97%</span>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </motion.div>
        </motion.div>
        
        {/* Learn More Button */}
        <motion.div
          className="text-center mt-12"
          initial={{ opacity: 0 }}
          animate={isInView ? { opacity: 1 } : { opacity: 0 }}
          transition={{ delay: 1.8 }}
        >
          <Button
            variant="outline"
            size="lg"
            className="text-blue-600 border-blue-600 hover:bg-blue-50"
            onClick={() => setExpandedDetails(!expandedDetails)}
          >
            {expandedDetails ? 'Show Less' : 'Learn More'}
            <ChevronDown className={`w-4 h-4 ml-2 transition-transform duration-300 ${expandedDetails ? 'rotate-180' : ''}`} />
          </Button>
        </motion.div>
      </div>
    </section>
  );
};

export default TechnicalApproachSection;