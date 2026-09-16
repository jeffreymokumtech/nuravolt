'use client';

import { useState } from 'react';
import { motion } from 'framer-motion';
import { Calculator, TrendingUp, Shield } from 'lucide-react';
import ROICalculatorSimple from '@/components/roi/ROICalculatorSimple';
import ROICalculatorAdvanced from '@/components/roi/ROICalculatorAdvanced';
import ROIResultsDashboard from '@/components/roi/ROIResultsDashboard';
import ROIAssumptionsPanel from '@/components/roi/ROIAssumptionsPanel';
import EmailGate from '@/components/shared/EmailGate';
import { calculateROI, type ROIResults, type ROIInputs } from '@/utils/roiCalculator';
import { type Region } from '@/data/roiCalculator';
import PublicLayout from '@/components/layouts/PublicLayout';

export default function ROICalculatorPage() {
  const [mode, setMode] = useState<'simple' | 'advanced'>('simple');
  const [results, setResults] = useState<ROIResults | null>(null);
  const [showEmailGate, setShowEmailGate] = useState(false);
  const [isCalculating, setIsCalculating] = useState(false);
  const [hasAccess, setHasAccess] = useState(false);
  const [pendingInputs, setPendingInputs] = useState<ROIInputs | null>(null);

  const handleSimpleCalculate = (capacity: number, region: Region) => {
    const inputs: ROIInputs = {
      plantCapacity: capacity,
      region
    };
    setPendingInputs(inputs);
    setShowEmailGate(true);
  };

  const handleAdvancedCalculate = (inputs: {
    capacity: number;
    region: Region;
    currentEfficiency: number;
    soilingFrequency: number;
    omCosts: number;
    electricityRate: number;
  }) => {
    const roiInputs: ROIInputs = {
      plantCapacity: inputs.capacity,
      region: inputs.region,
      currentEfficiency: inputs.currentEfficiency,
      soilingFrequency: inputs.soilingFrequency,
      omCosts: inputs.omCosts,
      electricityRate: inputs.electricityRate
    };
    setPendingInputs(roiInputs);
    setShowEmailGate(true);
  };

  const handleEmailSuccess = (email: string, name: string) => {
    setHasAccess(true);

    if (pendingInputs) {
      setIsCalculating(true);

      // Simulate calculation delay for better UX
      setTimeout(() => {
        const roiResults = calculateROI(pendingInputs, mode);
        setResults(roiResults);
        setIsCalculating(false);

        // Track calculation event
        if (typeof window !== 'undefined' && (window as any).posthog) {
          (window as any).posthog.capture('roi_calculation_performed', {
            mode,
            capacity: pendingInputs.plantCapacity,
            region: pendingInputs.region,
            roi_ratio: roiResults.roiRatio,
            user_email: email
          });
        }

        // Scroll to results
        setTimeout(() => {
          document.getElementById('results')?.scrollIntoView({ behavior: 'smooth' });
        }, 100);
      }, 1000);
    }
  };

  const handleSwitchMode = () => {
    setMode(mode === 'simple' ? 'advanced' : 'simple');
    setResults(null);
  };

  return (
    <PublicLayout>
    <div className="min-h-screen bg-paper-2">
      {/* Hero Section */}
      <section className="pt-24 pb-16 px-4">
        <div className="max-w-6xl mx-auto text-center">
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            className="mb-8"
          >
            <div className="inline-flex items-center gap-2 bg-paper-2 text-primary px-4 py-2 rounded-full mb-6">
              <Calculator className="w-4 h-4" />
              <span className="text-sm font-semibold">Free ROI Calculator</span>
            </div>

            <h1 className="text-4xl md:text-5xl font-bold text-ink mb-6">
              Calculate Your Solar Monitoring ROI
            </h1>
            <p className="text-xl text-ink-2 max-w-3xl mx-auto">
              Conservative estimates based on NREL research and real customer results.
              See how much you can save with NuraVolt's energy intelligence platform.
            </p>
          </motion.div>

          {/* Trust Indicators */}
          <div className="flex flex-wrap items-center justify-center gap-8 mt-12">
            <div className="flex items-center gap-2">
              <Shield className="w-5 h-5 text-primary" />
              <span className="text-sm text-ink-2">Conservative Estimates</span>
            </div>
            <div className="flex items-center gap-2">
              <TrendingUp className="w-5 h-5 text-primary" />
              <span className="text-sm text-ink-2">Research-Backed</span>
            </div>
            <div className="flex items-center gap-2">
              <Calculator className="w-5 h-5 text-primary" />
              <span className="text-sm text-ink-2">Transparent Methodology</span>
            </div>
          </div>
        </div>
      </section>

      {/* Calculator Section */}
      <section className="py-12 px-4">
        <div className="max-w-4xl mx-auto">
          {mode === 'simple' ? (
            <ROICalculatorSimple
              onCalculate={handleSimpleCalculate}
              onSwitchToAdvanced={handleSwitchMode}
              isCalculating={isCalculating}
            />
          ) : (
            <ROICalculatorAdvanced
              onCalculate={handleAdvancedCalculate}
              onSwitchToSimple={handleSwitchMode}
              isCalculating={isCalculating}
            />
          )}
        </div>
      </section>

      {/* Results Section */}
      {results && (
        <section id="results" className="py-12 px-4">
          <div className="max-w-4xl mx-auto space-y-8">
            <ROIResultsDashboard results={results} mode={mode} />
            <ROIAssumptionsPanel assumptions={results.assumptions} />
          </div>
        </section>
      )}

      {/* Disclaimer Section */}
      <section className="py-12 px-4">
        <div className="max-w-4xl mx-auto">
          <div className="bg-paper-2 border border-divider rounded p-8">
            <h3 className="text-lg font-bold text-ink mb-4">
              Important Disclaimers
            </h3>
            <div className="space-y-3 text-sm text-ink-2">
              <p>
                <span className="font-semibold">No Guarantees:</span> This calculator provides illustrative estimates only.
                Actual results vary significantly based on site-specific conditions, equipment configuration, operational practices,
                weather variability, and grid conditions.
              </p>
              <p>
                <span className="font-semibold">Not a Quote:</span> ROI calculator results do not constitute a quote, proposal,
                or guarantee of performance. Contact NuraVolt for a personalized assessment based on your specific site and requirements.
              </p>
              <p>
                <span className="font-semibold">Conservative Estimates:</span> Our calculator uses conservative assumptions intentionally.
                Most customers exceed these estimates by 20-30% in real-world deployments.
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* CTA Section */}
      <section className="py-16 px-4">
        <div className="max-w-4xl mx-auto text-center bg-primary rounded p-12">
          <h2 className="text-3xl font-bold text-white mb-4">
            Want a Personalized Assessment?
          </h2>
          <p className="text-xl text-data-fg-2 mb-8">
            Contact our team for a custom ROI analysis based on your specific configuration
          </p>
          <div className="flex flex-col sm:flex-row gap-4 justify-center">
            <a
              href="mailto:contact@nuravolt.com"
              className="inline-block bg-paper text-primary px-8 py-4 rounded-lg font-semibold hover:bg-paper-2 transition-colors"
            >
              Contact Us
            </a>
            <a
              href="/case-studies"
              className="inline-block bg-primary text-white px-8 py-4 rounded-lg font-semibold hover:bg-data-bg transition-colors"
            >
              View Case Studies
            </a>
          </div>
        </div>
      </section>

      {/* Email Gate Modal */}
      <EmailGate
        isOpen={showEmailGate}
        onClose={() => setShowEmailGate(false)}
        onSuccess={handleEmailSuccess}
        title="See Your ROI Results"
        description="Enter your details to view your personalized ROI calculation with detailed breakdown and assumptions."
        contentType="roi_results"
        contentId={`roi_${mode}_${pendingInputs?.plantCapacity || 0}mw_${pendingInputs?.region || ''}`}
      />
    </div>
    </PublicLayout>
  );
}
