'use client';

import { useState, useRef, useEffect } from 'react';
import * as React from 'react';
import { motion, useInView, AnimatePresence } from 'framer-motion';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { Check, X, Crown, Calendar, Phone, FileText } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useLanguage } from '@/contexts/LanguageContext';

interface PricingTier {
  name: string;
  price: number;
  priceId: string;
  description: string;
  capacity: string;
  features: string[];
  notIncluded?: string[];
  isPopular?: boolean;
}

const pricingTiers: PricingTier[] = [
  {
    name: 'PILOT PROGRAM',
    price: 0,
    priceId: 'price_pilot_program',
    description: 'Test our platform with your actual data',
    capacity: 'Competitive startup pricing for global operators',
    features: [
      'Validate performance improvements with real data',
      'Custom digital twin for your specific plant',
      'Integration with existing SCADA in weeks',
      'International support team',
      'Example ROI calculation based on your data'
    ],
    isPopular: false
  },
  {
    name: 'PROFESSIONAL',
    price: 0,
    priceId: 'price_professional_monthly',
    description: 'Full-scale monitoring with battery analytics',
    capacity: 'Large-scale monitoring + battery systems',
    features: [
      'Advanced ML models for PV + Battery',
      'Real-time dashboards with frequent monitoring',
      'API access and custom integrations',
      'Predictive maintenance for batteries',
      'Priority support with SLA commitment'
    ]
  },
  {
    name: 'ENTERPRISE',
    price: 0,
    priceId: 'price_enterprise_contact',
    description: 'Custom pricing for large portfolios',
    capacity: 'Unlimited capacity + full customization',
    features: [
      'Custom software development',
      'White-label solutions',
      'Dedicated success manager',
      'Arabic language UX optimization',
      'Contact for custom ROI calculation'
    ]
  },
  {
    name: 'BUILD INTERNALLY',
    price: 0,
    priceId: 'price_consulting_contact',
    description: 'We help you build in-house capabilities',
    capacity: 'Consulting + team enablement',
    features: [
      'Custom architecture design',
      'Proprietary algorithm development',
      'Team training & knowledge transfer',
      'White-label & IP ownership options',
      'Hybrid approach available'
    ]
  }
];

interface PricingSectionProps {
  onContactClick?: () => void;
}

const PricingSection = ({ onContactClick }: PricingSectionProps) => {
  const [isLoading, setIsLoading] = useState<string | null>(null);
  const [showEnterpriseModal, setShowEnterpriseModal] = useState(false);
  const [hoveredCard, setHoveredCard] = useState<number | null>(null);
  const router = useRouter();
  const { t } = useLanguage();
  const ref = useRef(null);
  const isInView = useInView(ref, { once: true, amount: 0.2 });
  

  const handleContactSales = () => {
    setShowEnterpriseModal(true);
  };

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
    hidden: { opacity: 0, y: 50, scale: 0.9 },
    visible: { 
      opacity: 1, 
      y: 0, 
      scale: 1,
      transition: {
        type: "spring" as const,
        stiffness: 100,
        damping: 15
      }
    }
  };


  return (
    <section ref={ref} id="pricing" className="py-16 sm:py-24 bg-gradient-to-br from-gray-50 to-blue-50 relative overflow-hidden">
      {/* Animated background */}
      <div className="absolute inset-0 opacity-10">
        <motion.div
          className="absolute top-20 left-20 w-40 h-40 bg-blue-400 rounded-full"
          animate={{
            scale: [1, 1.2, 1],
            opacity: [0.3, 0.6, 0.3]
          }}
          transition={{ duration: 6, repeat: Infinity }}
        />
        <motion.div
          className="absolute bottom-20 right-20 w-32 h-32 bg-purple-400 rounded-full"
          animate={{
            scale: [1, 1.3, 1],
            opacity: [0.2, 0.5, 0.2]
          }}
          transition={{ duration: 4, repeat: Infinity, delay: 2 }}
        />
      </div>
      
      <div className="container mx-auto px-4 sm:px-6 lg:px-8 relative z-10">
        <motion.div 
          className="text-center max-w-3xl mx-auto mb-12"
          initial={{ opacity: 0, y: 30 }}
          animate={isInView ? { opacity: 1, y: 0 } : { opacity: 0, y: 30 }}
          transition={{ duration: 0.8 }}
        >
          <h2 className="text-3xl sm:text-4xl font-bold text-gray-900 mb-4">
            Start Your Digital Twin Journey with a Pilot Program
          </h2>
          <p className="text-xl text-gray-600 mb-4">
            Validate ROI with your actual facility data
          </p>
          <div className="bg-blue-50 border border-blue-200 rounded-lg p-4 max-w-2xl mx-auto">
            <p className="text-lg font-semibold text-blue-700">
              💰 Significantly less than enterprise solutions • 🚀 Fast ROI validation • 🌍 Global support team
            </p>
          </div>
        </motion.div>


        <motion.div
          className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6 max-w-7xl mx-auto"
          variants={containerVariants}
          initial="hidden"
          animate={isInView ? "visible" : "hidden"}
        >
          {pricingTiers.map((tier, index) => (
            <motion.div
              key={tier.name}
              variants={cardVariants}
              className="relative"
              onMouseEnter={() => setHoveredCard(index)}
              onMouseLeave={() => setHoveredCard(null)}
              whileHover={{ 
                y: -10,
                transition: { type: "spring" as const, stiffness: 400, damping: 17 }
              }}
            >
              <Card
                className={`relative h-full overflow-hidden border-2 transition-all duration-300 border-gray-200 hover:border-blue-300 ${
                  hoveredCard === index ? 'shadow-2xl' : 'shadow-lg'
                }`}
              >
                <div className="relative z-10 bg-white rounded-lg h-full">
                  <CardHeader className="relative">
                    <CardTitle className="text-2xl font-bold text-gray-900 flex items-center">
                      {tier.name}
                    </CardTitle>
                    <CardDescription className="text-gray-600">{tier.description}</CardDescription>
                    <div className="mt-4">
                      <motion.div
                        className="text-4xl font-bold bg-gradient-to-r from-blue-600 to-blue-700 bg-clip-text text-transparent"
                        animate={hoveredCard === index ? { scale: 1.05 } : { scale: 1 }}
                        transition={{ type: "spring", stiffness: 300 }}
                      >
                        Contact Us
                      </motion.div>
                      <span className="text-gray-600 ml-2">
                        for pricing
                      </span>
                    </div>
                    <div className="text-sm text-blue-600 font-medium mt-2 bg-blue-50 px-3 py-1 rounded-full inline-block">
                      {tier.capacity}
                    </div>
                  </CardHeader>

                  <CardContent className="flex-1">
                    <ul className="space-y-3">
                      {tier.features.map((feature, featureIndex) => (
                        <motion.li 
                          key={feature} 
                          className="flex items-start"
                          initial={{ opacity: 0, x: -20 }}
                          animate={isInView ? { opacity: 1, x: 0 } : { opacity: 0, x: -20 }}
                          transition={{ delay: 0.8 + index * 0.2 + featureIndex * 0.1 }}
                        >
                          <motion.div
                            whileHover={{ scale: 1.2 }}
                            className="mt-0.5"
                          >
                            <Check className="h-5 w-5 text-green-500 mr-3 flex-shrink-0" />
                          </motion.div>
                          <span className="text-gray-700 leading-relaxed">{feature}</span>
                        </motion.li>
                      ))}
                      {tier.notIncluded?.map((feature, featureIndex) => (
                        <motion.li 
                          key={feature} 
                          className="flex items-start text-gray-400"
                          initial={{ opacity: 0, x: -20 }}
                          animate={isInView ? { opacity: 1, x: 0 } : { opacity: 0, x: -20 }}
                          transition={{ delay: 1 + index * 0.2 + featureIndex * 0.1 }}
                        >
                          <X className="h-5 w-5 text-gray-400 mr-3 flex-shrink-0 mt-0.5" />
                          <span>{feature}</span>
                        </motion.li>
                      ))}
                    </ul>
                  </CardContent>

                  <CardFooter className="mt-auto">
                    <motion.div
                      className="w-full"
                      whileHover={{ scale: 1.02 }}
                      whileTap={{ scale: 0.98 }}
                    >
                      <Button
                        className="w-full font-semibold"
                        variant="outline"
                        size="lg"
                        onClick={handleContactSales}
                      >
                        <Phone className="w-4 h-4 mr-2" />
                        Contact Sales
                      </Button>
                    </motion.div>
                  </CardFooter>
                </div>
              </Card>
            </motion.div>
          ))}
        </motion.div>

        {/* Pilot Validation Section */}
        <motion.div
          className="text-center mt-16"
          initial={{ opacity: 0 }}
          animate={isInView ? { opacity: 1 } : { opacity: 0 }}
          transition={{ delay: 1.2 }}
        >
          <div className="bg-blue-50 border border-green-200 rounded-2xl p-8 max-w-3xl mx-auto">
            <h3 className="text-2xl font-bold text-green-800 mb-4">
              Pilot Validation
            </h3>
            <p className="text-lg text-green-700">
              Validate performance improvements with your actual facility data.
            </p>
          </div>
        </motion.div>
        
        {/* Enterprise Consultation Modal */}
        <AnimatePresence>
          {showEnterpriseModal && (
            <motion.div
              className="fixed inset-0 bg-black/50 backdrop-blur-sm z-50 flex items-center justify-center p-4"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => setShowEnterpriseModal(false)}
            >
              <motion.div
                className="bg-white rounded-2xl p-8 max-w-md w-full shadow-2xl"
                initial={{ scale: 0.9, y: 50 }}
                animate={{ scale: 1, y: 0 }}
                exit={{ scale: 0.9, y: 50 }}
                onClick={(e) => e.stopPropagation()}
              >
                <div className="text-center mb-6">
                  <motion.div
                    animate={{ rotate: 360 }}
                    transition={{ duration: 2, repeat: Infinity, ease: "linear" }}
                    className="w-16 h-16 bg-gradient-to-r from-blue-600 to-blue-400 rounded-full flex items-center justify-center mx-auto mb-4"
                  >
                    <Crown className="w-8 h-8 text-white" />
                  </motion.div>
                  <h3 className="text-2xl font-bold text-gray-900 mb-2">
                    Enterprise Consultation
                  </h3>
                  <p className="text-gray-600">
                    Let&apos;s discuss your specific requirements, whether that&apos;s deploying our platform, building custom internal capabilities, or a hybrid approach.
                  </p>
                </div>
                
                <div className="space-y-4">
                  <motion.button
                    className="w-full bg-gradient-to-r from-blue-600 to-blue-400 text-white py-3 px-6 rounded-lg font-semibold flex items-center justify-center"
                    whileHover={{ scale: 1.02 }}
                    whileTap={{ scale: 0.98 }}
                    onClick={() => {
                      setShowEnterpriseModal(false);
                      onContactClick?.();
                    }}
                  >
                    <Phone className="w-5 h-5 mr-2" />
                    Contact Sales Team
                  </motion.button>
                </div>
                
                <button
                  className="absolute top-4 right-4 text-gray-400 hover:text-gray-600"
                  onClick={() => setShowEnterpriseModal(false)}
                >
                  <X className="w-6 h-6" />
                </button>
              </motion.div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </section>
  );
};

export default PricingSection;