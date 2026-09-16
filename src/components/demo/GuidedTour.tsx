'use client';

import { useState, useEffect, useCallback } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { X, ChevronLeft, ChevronRight, Play, SkipForward } from 'lucide-react';

interface TourStep {
  target: string; // CSS selector
  title: string;
  content: string;
  position?: 'top' | 'bottom' | 'left' | 'right';
  highlight?: boolean;
}

interface GuidedTourProps {
  steps: TourStep[];
  isOpen: boolean;
  onClose: () => void;
  onComplete?: () => void;
}

export default function GuidedTour({ steps, isOpen, onClose, onComplete }: GuidedTourProps) {
  const [currentStep, setCurrentStep] = useState(0);
  const [targetRect, setTargetRect] = useState<DOMRect | null>(null);

  const step = steps[currentStep];

  // Find and highlight target element
  useEffect(() => {
    if (!isOpen || !step?.target) return;

    const findTarget = () => {
      const element = document.querySelector(step.target);
      if (element) {
        const rect = element.getBoundingClientRect();
        setTargetRect(rect);

        // Scroll element into view
        element.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
    };

    // Small delay to allow for transitions
    const timer = setTimeout(findTarget, 300);
    return () => clearTimeout(timer);
  }, [isOpen, step, currentStep]);

  const nextStep = useCallback(() => {
    if (currentStep < steps.length - 1) {
      setCurrentStep(currentStep + 1);
    } else {
      onComplete?.();
      onClose();
    }
  }, [currentStep, steps.length, onComplete, onClose]);

  const prevStep = useCallback(() => {
    if (currentStep > 0) {
      setCurrentStep(currentStep - 1);
    }
  }, [currentStep]);

  const skipTour = useCallback(() => {
    onClose();
  }, [onClose]);

  // Keyboard navigation
  useEffect(() => {
    if (!isOpen) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'ArrowRight' || e.key === 'Enter') nextStep();
      if (e.key === 'ArrowLeft') prevStep();
      if (e.key === 'Escape') skipTour();
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, nextStep, prevStep, skipTour]);

  if (!isOpen) return null;

  // Calculate tooltip position
  const getTooltipStyle = () => {
    if (!targetRect) return { top: '50%', left: '50%', transform: 'translate(-50%, -50%)' };

    const padding = 16;
    const tooltipWidth = 320;
    const tooltipHeight = 200;

    let top = targetRect.bottom + padding;
    let left = targetRect.left + targetRect.width / 2 - tooltipWidth / 2;

    // Adjust if tooltip would go off screen
    if (left < padding) left = padding;
    if (left + tooltipWidth > window.innerWidth - padding) {
      left = window.innerWidth - tooltipWidth - padding;
    }

    // If tooltip would go below viewport, show above target
    if (top + tooltipHeight > window.innerHeight - padding) {
      top = targetRect.top - tooltipHeight - padding;
    }

    return { top: `${top}px`, left: `${left}px` };
  };

  return (
    <AnimatePresence>
      {/* Overlay */}
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        className="fixed inset-0 z-[100]"
      >
        {/* Dark overlay with spotlight effect */}
        <div className="absolute inset-0 bg-black/60" />

        {/* Spotlight on target element */}
        {targetRect && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            className="absolute bg-transparent"
            style={{
              top: targetRect.top - 8,
              left: targetRect.left - 8,
              width: targetRect.width + 16,
              height: targetRect.height + 16,
              boxShadow: '0 0 0 9999px rgba(0, 0, 0, 0.6)',
              borderRadius: '8px',
            }}
          >
            {/* Pulsing border */}
            <motion.div
              className="absolute inset-0 border-2 border-blue-400 rounded-lg"
              animate={{ scale: [1, 1.02, 1], opacity: [1, 0.8, 1] }}
              transition={{ repeat: Infinity, duration: 2 }}
            />
          </motion.div>
        )}

        {/* Tooltip */}
        <motion.div
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: 10 }}
          className="absolute w-80 bg-white rounded-xl shadow-2xl overflow-hidden z-10"
          style={getTooltipStyle()}
        >
          {/* Progress bar */}
          <div className="h-1 bg-paper-2">
            <motion.div
              className="h-full bg-blue-600"
              initial={{ width: 0 }}
              animate={{ width: `${((currentStep + 1) / steps.length) * 100}%` }}
              transition={{ duration: 0.3 }}
            />
          </div>

          <div className="p-5">
            {/* Step counter */}
            <div className="flex items-center justify-between mb-3">
              <span className="text-xs font-medium text-blue-600 bg-blue-50 px-2 py-1 rounded-full">
                Step {currentStep + 1} of {steps.length}
              </span>
              <button
                onClick={skipTour}
                className="text-ink-3 hover:text-gray-600 transition-colors"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {/* Content */}
            <h3 className="text-lg font-semibold text-ink mb-2">{step.title}</h3>
            <p className="text-sm text-ink-2 leading-relaxed">{step.content}</p>

            {/* Navigation */}
            <div className="flex items-center justify-between mt-5 pt-4 border-t border-divider">
              <button
                onClick={skipTour}
                className="flex items-center gap-1 text-sm text-ink-3 hover:text-gray-700 transition-colors"
              >
                <SkipForward className="w-4 h-4" />
                Skip tour
              </button>

              <div className="flex items-center gap-2">
                {currentStep > 0 && (
                  <button
                    onClick={prevStep}
                    className="flex items-center gap-1 px-3 py-1.5 text-sm text-ink-2 hover:bg-gray-100 rounded-lg transition-colors"
                  >
                    <ChevronLeft className="w-4 h-4" />
                    Back
                  </button>
                )}
                <motion.button
                  whileHover={{ scale: 1.02 }}
                  whileTap={{ scale: 0.98 }}
                  onClick={nextStep}
                  className="flex items-center gap-1 px-4 py-1.5 text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 rounded-lg transition-colors"
                >
                  {currentStep === steps.length - 1 ? 'Finish' : 'Next'}
                  <ChevronRight className="w-4 h-4" />
                </motion.button>
              </div>
            </div>
          </div>
        </motion.div>
      </motion.div>
    </AnimatePresence>
  );
}

// Tour trigger button component
interface TourTriggerProps {
  onClick: () => void;
  variant?: 'button' | 'fab';
}

export function TourTrigger({ onClick, variant = 'button' }: TourTriggerProps) {
  if (variant === 'fab') {
    return (
      <motion.button
        whileHover={{ scale: 1.05 }}
        whileTap={{ scale: 0.95 }}
        onClick={onClick}
        className="fixed bottom-6 right-6 z-50 flex items-center gap-2 px-4 py-3 bg-blue-600 text-white rounded-full shadow-lg hover:bg-blue-700 transition-colors"
      >
        <Play className="w-5 h-5" />
        <span className="font-medium">Start Tour</span>
      </motion.button>
    );
  }

  return (
    <motion.button
      whileHover={{ scale: 1.02 }}
      whileTap={{ scale: 0.98 }}
      onClick={onClick}
      className="flex items-center gap-2 px-4 py-2 text-sm font-medium text-blue-600 bg-blue-50 hover:bg-blue-100 border border-blue-200 rounded-lg transition-colors"
    >
      <Play className="w-4 h-4" />
      Take a Tour
    </motion.button>
  );
}

// Pre-defined tour for the demo
export const DEMO_TOUR_STEPS: TourStep[] = [
  {
    target: '[data-tour="portfolio-kpis"]',
    title: 'Portfolio Overview',
    content: 'Get a quick snapshot of your entire fleet - total plants, capacity, and any issues requiring attention.',
    position: 'bottom',
  },
  {
    target: '[data-tour="plant-card"]',
    title: 'Plant Health at a Glance',
    content: 'Each card shows inverter health distribution. Click any operational plant to dive into detailed analytics.',
    position: 'bottom',
  },
  {
    target: '[data-tour="issues-panel"]',
    title: 'Issues Panel',
    content: 'Critical and major issues are surfaced here for immediate attention. Click to jump directly to the affected plant.',
    position: 'left',
  },
];

export const PLANT_TOUR_STEPS: TourStep[] = [
  {
    target: '[data-tour="digital-twin-chart"]',
    title: 'Digital Twin Performance',
    content: 'Compare expected vs actual power output. The blue line shows ML-predicted output, green shows actual generation.',
    position: 'bottom',
  },
  {
    target: '[data-tour="kpi-grid"]',
    title: 'Key Performance Indicators',
    content: 'Monitor PR, inverter health, detected issues, soiling losses, and annual financial impact at a glance.',
    position: 'bottom',
  },
  {
    target: '[data-tour="health-score"]',
    title: 'Plant Health Score',
    content: 'An AI-computed score combining anomaly detection, fault severity, and RUL predictions into a single metric.',
    position: 'right',
  },
  {
    target: '[data-tour="loss-waterfall"]',
    title: 'Loss Disaggregation',
    content: 'Understand exactly where your energy is going. Losses are broken down by category: soiling, curtailment, temperature, and faults.',
    position: 'top',
  },
  {
    target: '[data-tour="nav-faults"]',
    title: 'Fault Detection',
    content: 'Click here to see detailed reactive and predictive fault analysis with RUL (Remaining Useful Life) predictions.',
    position: 'right',
  },
  {
    target: '[data-tour="nav-soiling"]',
    title: 'Soiling Intelligence',
    content: 'Access 365-day soiling forecasts and optimized cleaning schedules to maximize ROI on cleaning operations.',
    position: 'right',
  },
];
