'use client';

import { useRef, useState } from 'react';
import { motion, useInView } from 'framer-motion';
import { Button } from '@/components/ui/button';
import {
  Play,
  Zap,
  TrendingUp,
  BarChart3,
  Calendar,
  AlertTriangle,
  CheckCircle,
  ArrowRight,
  Maximize2,
  ExternalLink,
} from 'lucide-react';
import Link from 'next/link';
import Image from 'next/image';

interface DemoFeature {
  id: string;
  title: string;
  description: string;
  painPoint: string;
  solution: string;
  icon: React.ElementType;
  metrics: { value: string; label: string }[];
  screenshotPath: string;
  screenshotAlt: string;
}

const demoFeatures: DemoFeature[] = [
  {
    id: 'fleet-heatmap',
    title: 'Fleet Heatmap Analytics',
    description: '150 inverters monitored with real-time health scoring across your entire fleet.',
    painPoint: 'Traditional systems show only 4-8 data points per MW',
    solution: 'String-level monitoring with 200+ data points per MW',
    icon: BarChart3,
    metrics: [
      { value: '150', label: 'Inverters tracked' },
      { value: '5 years', label: 'Historical data' },
      { value: 'Real-time', label: 'Anomaly detection' },
    ],
    screenshotPath: '/images/demo/fleet-heatmap.png',
    screenshotAlt: 'Fleet heatmap showing 150 inverters with color-coded performance indicators',
  },
  {
    id: 'soiling-forecast',
    title: 'Soiling Intelligence',
    description: '90-day soiling forecasts with confidence bands and optimal cleaning schedules.',
    painPoint: 'Guessing cleaning dates wastes €40-90K/year',
    solution: 'AI-optimized cleaning schedules with ROI projections',
    icon: TrendingUp,
    metrics: [
      { value: '96.3%', label: 'Detection accuracy' },
      { value: '32%', label: 'Cost reduction' },
      { value: '7-10 days', label: 'Advance warning' },
    ],
    screenshotPath: '/images/demo/soiling-forecast.png',
    screenshotAlt: 'Soiling ratio forecast chart with 95% confidence intervals',
  },
  {
    id: 'cleaning-optimizer',
    title: 'Cleaning Schedule Optimizer',
    description: 'Cost-benefit analysis with financial waterfall charts showing exact ROI.',
    painPoint: 'Over-cleaning or under-cleaning costs thousands',
    solution: 'Optimal schedule with €/cleaning ROI calculations',
    icon: Calendar,
    metrics: [
      { value: '€109K+', label: 'Annual savings' },
      { value: '2.7 months', label: 'Payback period' },
      { value: '767%', label: '3-year ROI' },
    ],
    screenshotPath: '/images/demo/cleaning-waterfall.png',
    screenshotAlt: 'Financial waterfall chart showing cleaning costs vs benefits',
  },
  {
    id: 'ticket-tracking',
    title: 'O&M Ticket Management',
    description: 'Kanban-style workflow from anomaly detection to resolution with revenue impact tracking.',
    painPoint: 'Issues get lost in spreadsheets and emails',
    solution: 'Automated ticketing with priority scoring and SLA tracking',
    icon: AlertTriangle,
    metrics: [
      { value: '89%', label: 'Faster resolution' },
      { value: 'Auto', label: 'Priority scoring' },
      { value: '€/issue', label: 'Impact tracking' },
    ],
    screenshotPath: '/images/demo/ticket-kanban.png',
    screenshotAlt: 'Kanban board showing ticket workflow from detection to resolution',
  },
];

const DemoShowcase = () => {
  const ref = useRef(null);
  const isInView = useInView(ref, { once: true, amount: 0.1 });
  const [activeFeature, setActiveFeature] = useState<string>(demoFeatures[0].id);
  const [isImageExpanded, setIsImageExpanded] = useState(false);

  const currentFeature = demoFeatures.find((f) => f.id === activeFeature) || demoFeatures[0];

  const containerVariants = {
    hidden: { opacity: 0 },
    visible: {
      opacity: 1,
      transition: {
        staggerChildren: 0.15,
      },
    },
  };

  const itemVariants = {
    hidden: { opacity: 0, y: 20 },
    visible: {
      opacity: 1,
      y: 0,
      transition: { duration: 0.5 },
    },
  };

  return (
    <section ref={ref} className="py-16 sm:py-24 bg-gradient-to-b from-gray-50 to-white">
      <div className="container mx-auto px-4 sm:px-6 lg:px-8">
        {/* Section Header */}
        <motion.div
          className="text-center mb-12"
          initial={{ opacity: 0, y: 30 }}
          animate={isInView ? { opacity: 1, y: 0 } : { opacity: 0, y: 30 }}
          transition={{ duration: 0.8 }}
        >
          <div className="inline-flex items-center gap-2 bg-blue-100 text-blue-700 px-4 py-2 rounded-full text-sm font-medium mb-4">
            <Play className="w-4 h-4" />
            Live Demo Available
          </div>
          <h2 className="text-3xl sm:text-4xl lg:text-5xl font-bold text-gray-900 mb-4">
            See It In Action
          </h2>
          <p className="text-xl text-gray-600 max-w-3xl mx-auto">
            Explore our demo with real data from a 9 MW Spanish solar plant.
            150 inverters, 5 years of data, real-time analytics.
          </p>
        </motion.div>

        <motion.div
          variants={containerVariants}
          initial="hidden"
          animate={isInView ? 'visible' : 'hidden'}
          className="grid grid-cols-1 lg:grid-cols-12 gap-8"
        >
          {/* Feature Selector - Left Column */}
          <div className="lg:col-span-4 space-y-4">
            {demoFeatures.map((feature) => {
              const Icon = feature.icon;
              const isActive = activeFeature === feature.id;

              return (
                <motion.div
                  key={feature.id}
                  variants={itemVariants}
                  className={`p-4 rounded-xl cursor-pointer transition-all duration-300 border-2 ${
                    isActive
                      ? 'bg-blue-50 border-blue-500 shadow-lg'
                      : 'bg-white border-gray-200 hover:border-blue-300 hover:shadow-md'
                  }`}
                  onClick={() => setActiveFeature(feature.id)}
                >
                  <div className="flex items-start gap-4">
                    <div
                      className={`p-3 rounded-lg ${
                        isActive ? 'bg-blue-600 text-white' : 'bg-gray-100 text-gray-600'
                      }`}
                    >
                      <Icon className="w-6 h-6" />
                    </div>
                    <div className="flex-1">
                      <h3 className="font-semibold text-gray-900 mb-1">{feature.title}</h3>
                      <p className="text-sm text-gray-600 mb-2">{feature.description}</p>

                      {/* Pain Point Badge */}
                      <div className="flex items-start gap-2 text-xs">
                        <AlertTriangle className="w-3 h-3 text-amber-500 mt-0.5 flex-shrink-0" />
                        <span className="text-amber-700">{feature.painPoint}</span>
                      </div>
                    </div>
                    {isActive && (
                      <CheckCircle className="w-5 h-5 text-blue-600 flex-shrink-0" />
                    )}
                  </div>
                </motion.div>
              );
            })}

            {/* CTA Button */}
            <motion.div variants={itemVariants} className="pt-4">
              <Link href="/showcase">
                <Button className="w-full bg-blue-600 hover:bg-blue-700 text-white py-6 text-lg group">
                  <Play className="w-5 h-5 mr-2" />
                  Explore the Full Demo
                  <ArrowRight className="w-5 h-5 ml-2 transition-transform group-hover:translate-x-1" />
                </Button>
              </Link>
              <p className="text-center text-sm text-gray-500 mt-2">
                No signup required • Real plant data
              </p>
            </motion.div>
          </div>

          {/* Screenshot Display - Right Column */}
          <motion.div variants={itemVariants} className="lg:col-span-8">
            <div className="bg-white rounded-2xl shadow-2xl overflow-hidden border border-gray-200">
              {/* Browser Chrome */}
              <div className="bg-gray-100 px-4 py-3 flex items-center justify-between border-b">
                <div className="flex items-center space-x-2">
                  <div className="h-3 w-3 bg-red-400 rounded-full"></div>
                  <div className="h-3 w-3 bg-yellow-400 rounded-full"></div>
                  <div className="h-3 w-3 bg-green-400 rounded-full"></div>
                </div>
                <div className="text-xs text-gray-600 font-mono bg-white px-3 py-1 rounded">
                  nuravolt.com/demo
                </div>
                <button
                  onClick={() => setIsImageExpanded(!isImageExpanded)}
                  className="text-gray-500 hover:text-gray-700 transition-colors"
                >
                  <Maximize2 className="w-4 h-4" />
                </button>
              </div>

              {/* Screenshot Area */}
              <div className="relative aspect-[16/10] bg-gray-50">
                {/* Placeholder with actual feature representation */}
                <div className="absolute inset-0 flex items-center justify-center">
                  {currentFeature.id === 'fleet-heatmap' && (
                    <FleetHeatmapPreview />
                  )}
                  {currentFeature.id === 'soiling-forecast' && (
                    <SoilingForecastPreview />
                  )}
                  {currentFeature.id === 'cleaning-optimizer' && (
                    <CleaningOptimizerPreview />
                  )}
                  {currentFeature.id === 'ticket-tracking' && (
                    <TicketTrackingPreview />
                  )}
                </div>

                {/* Live Badge */}
                <div className="absolute top-4 right-4 bg-green-500 text-white px-3 py-1 rounded-full text-xs font-semibold flex items-center">
                  <div className="h-2 w-2 bg-white rounded-full animate-pulse mr-2"></div>
                  Live Data
                </div>
              </div>

              {/* Feature Info Bar */}
              <div className="bg-gradient-to-r from-blue-600 to-blue-700 p-4 text-white">
                <div className="flex items-center justify-between">
                  <div>
                    <h4 className="font-semibold text-lg">{currentFeature.title}</h4>
                    <div className="flex items-center gap-2 text-blue-100 text-sm">
                      <CheckCircle className="w-4 h-4" />
                      {currentFeature.solution}
                    </div>
                  </div>
                  <div className="flex gap-6">
                    {currentFeature.metrics.map((metric, idx) => (
                      <div key={idx} className="text-center">
                        <div className="text-xl font-bold">{metric.value}</div>
                        <div className="text-blue-200 text-xs">{metric.label}</div>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            </div>

            {/* Bottom CTA */}
            <motion.div
              variants={itemVariants}
              className="mt-6 flex items-center justify-center gap-4 text-sm"
            >
              <Link
                href="/showcase"
                className="flex items-center gap-2 text-blue-600 hover:text-blue-700 font-medium"
              >
                <ExternalLink className="w-4 h-4" />
                Open Full Demo
              </Link>
              <span className="text-gray-300">|</span>
              <a
                href="mailto:contact@nuravolt.com"
                className="flex items-center gap-2 text-gray-600 hover:text-gray-800 font-medium"
              >
                <Calendar className="w-4 h-4" />
                Contact Us for a Walkthrough
              </a>
            </motion.div>
          </motion.div>
        </motion.div>

        {/* Social Proof Stats */}
        <motion.div
          variants={containerVariants}
          initial="hidden"
          animate={isInView ? 'visible' : 'hidden'}
          className="mt-16 grid grid-cols-2 md:grid-cols-4 gap-6"
        >
          {[
            { value: '96.3%', label: 'Detection Accuracy', sublabel: '18-month validation' },
            { value: '32%', label: 'Cost Reduction', sublabel: 'Spanish 120MW deployment' },
            { value: '2.7 mo', label: 'Payback Period', sublabel: 'Typical ROI timeline' },
            { value: '150+', label: 'Inverters Monitored', sublabel: 'Per-string analytics' },
          ].map((stat, index) => (
            <motion.div
              key={index}
              variants={itemVariants}
              className="text-center p-6 bg-white rounded-xl shadow-sm border border-gray-100"
            >
              <div className="text-3xl font-bold text-blue-600 mb-1">{stat.value}</div>
              <div className="text-gray-900 font-medium">{stat.label}</div>
              <div className="text-gray-500 text-sm">{stat.sublabel}</div>
            </motion.div>
          ))}
        </motion.div>
      </div>
    </section>
  );
};

// Mini visualization components for the preview
const FleetHeatmapPreview = () => (
  <div className="w-full h-full p-6">
    <div className="h-full flex flex-col">
      <div className="flex justify-between items-center mb-4">
        <h3 className="font-semibold text-gray-800">Fleet Performance Heatmap</h3>
        <div className="flex gap-2">
          <span className="px-2 py-1 bg-green-100 text-green-700 text-xs rounded">Power Loss</span>
          <span className="px-2 py-1 bg-gray-100 text-gray-600 text-xs rounded">PR Mode</span>
        </div>
      </div>
      <div className="flex-1 grid grid-cols-15 gap-1">
        {/* Generate 150 cells representing inverters */}
        {Array.from({ length: 150 }).map((_, i) => {
          const random = Math.random();
          let bgColor = 'bg-green-400';
          if (random > 0.95) bgColor = 'bg-red-500';
          else if (random > 0.85) bgColor = 'bg-yellow-400';
          else if (random > 0.7) bgColor = 'bg-green-300';
          return (
            <div
              key={i}
              className={`${bgColor} rounded-sm aspect-square transition-transform hover:scale-110 cursor-pointer`}
              title={`Inverter ${i + 1}`}
            />
          );
        })}
      </div>
      <div className="flex justify-center gap-4 mt-4 text-xs">
        <div className="flex items-center gap-1">
          <div className="w-3 h-3 bg-green-400 rounded" />
          <span>Normal</span>
        </div>
        <div className="flex items-center gap-1">
          <div className="w-3 h-3 bg-yellow-400 rounded" />
          <span>Warning</span>
        </div>
        <div className="flex items-center gap-1">
          <div className="w-3 h-3 bg-red-500 rounded" />
          <span>Critical</span>
        </div>
      </div>
    </div>
  </div>
);

const SoilingForecastPreview = () => (
  <div className="w-full h-full p-6">
    <div className="h-full flex flex-col">
      <div className="flex justify-between items-center mb-4">
        <h3 className="font-semibold text-gray-800">90-Day Soiling Forecast</h3>
        <span className="px-2 py-1 bg-blue-100 text-blue-700 text-xs rounded">95% CI</span>
      </div>
      <div className="flex-1 relative">
        <svg className="w-full h-full" viewBox="0 0 400 200" preserveAspectRatio="none">
          {/* Background grid */}
          <defs>
            <pattern id="grid2" width="40" height="40" patternUnits="userSpaceOnUse">
              <path d="M 40 0 L 0 0 0 40" fill="none" stroke="#f3f4f6" strokeWidth="1" />
            </pattern>
          </defs>
          <rect width="100%" height="100%" fill="url(#grid2)" />

          {/* Confidence band */}
          <path
            d="M 0 60 Q 100 70, 200 90 T 400 120 L 400 150 Q 300 140, 200 110 T 0 80 Z"
            fill="#dbeafe"
            opacity="0.5"
          />

          {/* Main forecast line */}
          <path
            d="M 0 70 Q 100 75, 200 100 T 400 135"
            stroke="#2563eb"
            strokeWidth="3"
            fill="none"
          />

          {/* Cleaning markers */}
          <circle cx="120" cy="85" r="6" fill="#10b981" />
          <circle cx="280" cy="115" r="6" fill="#10b981" />

          {/* Labels */}
          <text x="120" y="75" fontSize="10" fill="#10b981" textAnchor="middle">Clean</text>
          <text x="280" y="105" fontSize="10" fill="#10b981" textAnchor="middle">Clean</text>
        </svg>

        {/* Y-axis labels */}
        <div className="absolute left-0 top-0 h-full flex flex-col justify-between text-xs text-gray-500 py-2">
          <span>100%</span>
          <span>95%</span>
          <span>90%</span>
        </div>
      </div>
      <div className="flex justify-between text-xs text-gray-500 mt-2">
        <span>Today</span>
        <span>30 days</span>
        <span>60 days</span>
        <span>90 days</span>
      </div>
    </div>
  </div>
);

const CleaningOptimizerPreview = () => (
  <div className="w-full h-full p-6">
    <div className="h-full flex flex-col">
      <div className="flex justify-between items-center mb-4">
        <h3 className="font-semibold text-gray-800">Cost-Benefit Analysis</h3>
        <span className="px-2 py-1 bg-green-100 text-green-700 text-xs rounded">+€109K/year</span>
      </div>
      <div className="flex-1 flex items-end gap-3 px-4">
        {/* Waterfall chart bars */}
        {[
          { label: 'Baseline', value: 0, color: 'bg-gray-300', height: '10%' },
          { label: 'Energy', value: '+€19K', color: 'bg-green-500', height: '45%' },
          { label: 'O&M', value: '+€50K', color: 'bg-green-500', height: '70%' },
          { label: 'Soiling', value: '+€65K', color: 'bg-green-500', height: '85%' },
          { label: 'Costs', value: '-€25K', color: 'bg-red-400', height: '60%' },
          { label: 'Net', value: '€109K', color: 'bg-blue-600', height: '75%' },
        ].map((bar, i) => (
          <div key={i} className="flex-1 flex flex-col items-center">
            <div className="w-full flex flex-col items-center justify-end" style={{ height: '160px' }}>
              <span className="text-xs font-medium text-gray-700 mb-1">{bar.value}</span>
              <div
                className={`w-full ${bar.color} rounded-t transition-all duration-500`}
                style={{ height: bar.height }}
              />
            </div>
            <span className="text-xs text-gray-500 mt-2">{bar.label}</span>
          </div>
        ))}
      </div>
    </div>
  </div>
);

const TicketTrackingPreview = () => (
  <div className="w-full h-full p-6">
    <div className="h-full flex flex-col">
      <div className="flex justify-between items-center mb-4">
        <h3 className="font-semibold text-gray-800">O&M Ticket Workflow</h3>
        <div className="flex gap-2">
          <span className="px-2 py-1 bg-amber-100 text-amber-700 text-xs rounded">3 Active</span>
          <span className="px-2 py-1 bg-green-100 text-green-700 text-xs rounded">12 Resolved</span>
        </div>
      </div>
      <div className="flex-1 grid grid-cols-4 gap-3">
        {/* Kanban columns */}
        {[
          {
            title: 'Detected',
            color: 'border-red-400',
            bgColor: 'bg-red-50',
            tickets: [
              { id: 'TKT-042', issue: 'String underperformance', priority: 'High', impact: '€2.3K/mo' },
            ]
          },
          {
            title: 'In Progress',
            color: 'border-amber-400',
            bgColor: 'bg-amber-50',
            tickets: [
              { id: 'TKT-041', issue: 'Inverter fault #23', priority: 'Critical', impact: '€4.1K/mo' },
              { id: 'TKT-039', issue: 'Soiling threshold', priority: 'Medium', impact: '€1.8K/mo' },
            ]
          },
          {
            title: 'Scheduled',
            color: 'border-blue-400',
            bgColor: 'bg-blue-50',
            tickets: [
              { id: 'TKT-038', issue: 'Panel cleaning', priority: 'Medium', impact: '€3.2K/mo' },
            ]
          },
          {
            title: 'Resolved',
            color: 'border-green-400',
            bgColor: 'bg-green-50',
            tickets: [
              { id: 'TKT-037', issue: 'Cable repair', priority: 'Done', impact: '€5.6K saved' },
            ]
          },
        ].map((column, i) => (
          <div key={i} className={`${column.bgColor} rounded-lg p-2 border-t-4 ${column.color}`}>
            <div className="text-xs font-semibold text-gray-600 mb-2 flex justify-between">
              <span>{column.title}</span>
              <span className="bg-white px-1.5 rounded">{column.tickets.length}</span>
            </div>
            <div className="space-y-2">
              {column.tickets.map((ticket, j) => (
                <div key={j} className="bg-white rounded p-2 shadow-sm text-xs">
                  <div className="flex justify-between items-start mb-1">
                    <span className="font-mono text-gray-400">{ticket.id}</span>
                    <span className={`px-1 rounded text-[10px] ${
                      ticket.priority === 'Critical' ? 'bg-red-100 text-red-700' :
                      ticket.priority === 'High' ? 'bg-amber-100 text-amber-700' :
                      ticket.priority === 'Done' ? 'bg-green-100 text-green-700' :
                      'bg-blue-100 text-blue-700'
                    }`}>
                      {ticket.priority}
                    </span>
                  </div>
                  <div className="text-gray-700 font-medium mb-1">{ticket.issue}</div>
                  <div className="text-gray-500 flex items-center gap-1">
                    <Zap className="w-3 h-3" />
                    {ticket.impact}
                  </div>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
      <div className="flex justify-center gap-6 mt-3 text-xs text-gray-500">
        <div className="flex items-center gap-1">
          <div className="w-2 h-2 bg-red-400 rounded-full" />
          <span>Auto-detected</span>
        </div>
        <div className="flex items-center gap-1">
          <div className="w-2 h-2 bg-amber-400 rounded-full" />
          <span>Assigned</span>
        </div>
        <div className="flex items-center gap-1">
          <div className="w-2 h-2 bg-green-400 rounded-full" />
          <span>Revenue saved</span>
        </div>
      </div>
    </div>
  </div>
);

export default DemoShowcase;
