'use client';

import { useState, useEffect, useRef } from 'react';
import { Button } from '@/components/ui/button';
import Link from 'next/link';
import { useLanguage } from '@/contexts/LanguageContext';
import { motion, useScroll, useTransform, AnimatePresence } from 'framer-motion';
// import EnhancedROICalculator from './EnhancedROICalculator';

const EnhancedHeroSection = () => {
  const [showCalculator, setShowCalculator] = useState(false);
  const [variant, setVariant] = useState<string>('control');
  const { t } = useLanguage();
  const containerRef = useRef<HTMLElement>(null);
  const { scrollYProgress } = useScroll({
    target: containerRef,
    offset: ["start start", "end start"]
  });

  const y = useTransform(scrollYProgress, [0, 1], ["0%", "50%"]);
  const opacity = useTransform(scrollYProgress, [0, 0.5], [1, 0]);

  // Fetch A/B test variant
  useEffect(() => {
    const fetchABTest = async () => {
      try {
        const response = await fetch('/api/ab-test/hero-section');
        const data = await response.json();
        setVariant(data.variant);
      } catch (error) {
        console.error('Failed to fetch A/B test:', error);
      }
    };
    fetchABTest();
  }, []);

  // Staggered text animation
  const headline = "Turn Power Loss Into Profit";
  const words = headline.split(" ");
  
  const subheadline = "AI-powered monitoring that identifies millions in hidden revenue across your solar portfolio";

  // Floating metrics data
  const floatingMetrics = [
    { label: "Power Output", value: "2,847 MW", trend: "+12%" },
    { label: "Efficiency", value: "94.2%", trend: "+3.1%" },
    { label: "Revenue Impact", value: "$2.3M", trend: "+$847K" }
  ];

  return (
    <section ref={containerRef} className="relative min-h-screen overflow-hidden">
      {/* Gradient Overlay */}
      <motion.div 
        className="absolute inset-0 bg-gradient-to-br from-slate-900 via-blue-900 to-amber-900"
        style={{ y, opacity }}
      />
      
      {/* Parallax Background */}
      <motion.div 
        className="absolute inset-0 bg-[url('/solar-farm-aerial.jpg')] bg-cover bg-center"
        style={{ y: useTransform(scrollYProgress, [0, 1], ["0%", "30%"]) }}
      >
        {/* Ken Burns effect overlay */}
        <div className="absolute inset-0 bg-gradient-to-t from-black/60 via-transparent to-black/30" />
      </motion.div>

      {/* Main Content */}
      <div className={`relative z-10 container mx-auto px-4 sm:px-6 lg:px-8 min-h-screen flex items-center transition-all duration-1000 ease-out ${
        showCalculator ? 'py-8' : 'py-16'
      }`}>
        <div className="w-full max-w-6xl mx-auto">
          <div className="text-center mb-12">
            {/* Animated Headline */}
            <motion.h1 
              className="text-5xl sm:text-6xl lg:text-7xl font-bold text-white mb-6"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ duration: 0.8 }}
            >
              {words.map((word, index) => (
                <motion.span
                  key={index}
                  className="inline-block mr-3"
                  initial={{ opacity: 0, y: 50 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ 
                    duration: 0.6, 
                    delay: index * 0.1,
                    ease: "easeOut"
                  }}
                >
                  {word}
                </motion.span>
              ))}
            </motion.h1>

            {/* Animated Subheadline */}
            <motion.p 
              className="text-xl sm:text-2xl text-blue-100 mb-12 max-w-4xl mx-auto leading-relaxed"
              initial={{ opacity: 0, y: 30 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.8, delay: 0.7 }}
            >
              {subheadline}
            </motion.p>

            {/* CTA Buttons */}
            <motion.div 
              className="flex flex-col sm:flex-row gap-6 justify-center mb-16"
              initial={{ opacity: 0, y: 30 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.8, delay: 1 }}
            >
              <motion.div
                animate={{ 
                  boxShadow: [
                    "0 0 20px rgba(59, 130, 246, 0.5)",
                    "0 0 40px rgba(59, 130, 246, 0.8)",
                    "0 0 20px rgba(59, 130, 246, 0.5)"
                  ]
                }}
                transition={{ duration: 3, repeat: Infinity, ease: "easeInOut" }}
              >
                <Button
                  size="lg"
                  className="bg-blue-600 hover:bg-blue-700 text-white px-12 py-6 text-xl font-semibold rounded-xl shadow-2xl transform hover:scale-105 transition-all duration-300"
                  onClick={() => setShowCalculator(!showCalculator)}
                >
                  Calculate Your Savings
                </Button>
              </motion.div>
              
              <motion.div
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.6, delay: 1.3 }}
              >
                <Button
                  size="lg"
                  variant="ghost"
                  className="border-2 border-white/30 text-white hover:bg-white/10 px-12 py-6 text-xl font-semibold rounded-xl backdrop-blur-sm transition-all duration-300"
                  asChild
                >
                  <Link href="#demo">Watch 2-min Demo</Link>
                </Button>
              </motion.div>
            </motion.div>

            {/* Floating Metrics */}
            <div className="relative">
              {floatingMetrics.map((metric, index) => (
                <motion.div
                  key={metric.label}
                  className="absolute bg-white/10 backdrop-blur-md rounded-2xl p-6 border border-white/20 shadow-2xl"
                  initial={{ opacity: 0, scale: 0.8 }}
                  animate={{ 
                    opacity: 1, 
                    scale: 1,
                    x: [0, 20, -20, 0],
                    y: [0, -10, 10, 0]
                  }}
                  transition={{ 
                    duration: 0.8, 
                    delay: 1.5 + index * 0.2,
                    x: { duration: 6, repeat: Infinity, ease: "easeInOut" },
                    y: { duration: 4, repeat: Infinity, ease: "easeInOut" }
                  }}
                  style={{
                    left: `${20 + index * 25}%`,
                    top: `${60 + (index % 2) * 20}%`
                  }}
                >
                  <div className="text-white text-center">
                    <div className="text-sm font-medium text-blue-200 mb-1">{metric.label}</div>
                    <div className="text-2xl font-bold mb-1">{metric.value}</div>
                    <div className="text-sm text-green-300">{metric.trend}</div>
                  </div>
                </motion.div>
              ))}
            </div>
          </div>

          {/* Enhanced ROI Calculator */}
          <AnimatePresence>
            {showCalculator && (
              <motion.div
                initial={{ opacity: 0, height: 0, x: 100 }}
                animate={{ opacity: 1, height: "auto", x: 0 }}
                exit={{ opacity: 0, height: 0, x: 100 }}
                transition={{ 
                  duration: 0.8, 
                  ease: [0.175, 0.885, 0.32, 1.275] // Elastic easing
                }}
                className="mt-12"
              >
                {/* <EnhancedROICalculator /> */}
                <div className="p-6 bg-white border rounded-lg shadow-sm">
                  <p className="text-gray-600">ROI Calculator placeholder - component missing</p>
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </div>

      {/* Scroll Indicator */}
      <motion.div 
        className="absolute bottom-8 left-1/2 transform -translate-x-1/2"
        animate={{ y: [0, 10, 0] }}
        transition={{ duration: 2, repeat: Infinity }}
      >
        <div className="w-6 h-10 border-2 border-white/50 rounded-full flex justify-center">
          <motion.div 
            className="w-1 h-3 bg-white/80 rounded-full mt-2"
            animate={{ y: [0, 16, 0] }}
            transition={{ duration: 2, repeat: Infinity }}
          />
        </div>
      </motion.div>
    </section>
  );
};

export default EnhancedHeroSection;