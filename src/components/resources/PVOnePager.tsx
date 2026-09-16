'use client';

import { Database, Brain, CheckCircle, Zap, Sun } from 'lucide-react';
import { Button } from '@/components/ui/button';

const PVOnePager = () => {
  const handlePrint = () => {
    window.print();
  };

  const phases = [
    {
      weeks: 'Weeks 1-2',
      title: 'Data Access & Integration',
      icon: Database,
      description: 'Connect to SCADA via Modbus, OPC UA, REST APIs, MQTT. No hardware changes.',
      color: 'blue'
    },
    {
      weeks: 'Weeks 3-4',
      title: 'Data Quality Checks',
      icon: CheckCircle,
      description: 'Sensor validation, calibration, and baseline establishment.',
      color: 'blue'
    },
    {
      weeks: 'Weeks 5-6',
      title: 'AI Training for Digital Twins',
      icon: Brain,
      description: 'Physics-informed ML calibration for your specific plant.',
      color: 'blue'
    },
    {
      weeks: 'Weeks 7-8',
      title: 'First Detection & Power Loss Estimation',
      icon: Zap,
      description: 'Live inverter-level fault detection and real-time alerts.',
      color: 'blue'
    }
  ];

  const detectionCapabilities = [
    'Inverter Failures',
    'String Outages',
    'Module Degradation',
    'Ground Faults',
    'Soiling Issues',
    'MPPT Drift'
  ];

  const integrations = [
    'SMA', 'Sungrow', 'Huawei', 'Fronius', 'SolarEdge', 'Enphase',
    'Modbus TCP/RTU', 'OPC UA', 'REST APIs', 'MQTT'
  ];

  return (
    <>
      {/* Print Styles - GUARANTEE single page */}
      <style jsx global>{`
        @media print {
          @page {
            size: A4;
            margin: 10mm;
          }

          body {
            print-color-adjust: exact;
            -webkit-print-color-adjust: exact;
          }

          .one-pager-container {
            page-break-inside: avoid;
            page-break-after: avoid;
            max-height: 277mm; /* A4 height (297mm) - margins (20mm) */
            overflow: hidden;
          }

          /* Prevent page breaks inside sections */
          .no-break {
            page-break-inside: avoid;
          }
        }
      `}</style>

      {/* Print Button - hidden when printing */}
      <div className="print:hidden mb-6 flex justify-end">
        <Button onClick={handlePrint} className="bg-blue-600 hover:bg-blue-700">
          Export to PDF
        </Button>
      </div>

      {/* Main One-Pager Content - optimized for A4 print */}
      <div className="one-pager-container bg-white shadow-2xl rounded-lg overflow-hidden max-w-[210mm] mx-auto print:shadow-none print:rounded-none print:max-h-[277mm]">
        {/* Header */}
        <div className="bg-gradient-to-r from-blue-600 to-blue-700 text-white p-6 print:p-4">
          <div className="flex items-center justify-between">
            <div>
              <h1 className="text-3xl font-bold mb-1 print:text-2xl">NuraVolt</h1>
              <p className="text-blue-100 print:text-sm">Energy Intelligence for Solar & Storage</p>
            </div>
            <div className="text-right">
              <Sun className="w-12 h-12 text-blue-200 print:w-10 print:h-10" />
            </div>
          </div>
        </div>

        {/* Introduction */}
        <div className="p-6 print:p-4 border-b border-gray-200">
          <h2 className="text-2xl font-bold text-gray-900 mb-3 print:text-xl">
            PV Monitoring & Performance Analytics
          </h2>
          <p className="text-base text-gray-700 leading-relaxed print:text-sm">
            <strong>Physics-informed AI monitoring</strong> that detects inverter failures, string outages,
            and performance issues <strong>days to weeks before traditional monitoring systems</strong> - using your existing SCADA
            data with no hardware changes. 92% accuracy. Fast ROI.
          </p>
        </div>

        {/* Implementation Timeline - 8 Weeks */}
        <div className="p-6 print:p-4 border-b border-gray-200">
          <h2 className="text-xl font-bold text-gray-900 mb-3 print:text-lg">
            8-Week Implementation Timeline
          </h2>

          <div className="grid grid-cols-2 gap-3 print:gap-2">
            {phases.map((phase, index) => {
              // Define color classes based on phase.color to work with Tailwind JIT
              const bgColorClass =
                phase.color === 'blue' ? 'bg-blue-100' :
                phase.color === 'green' ? 'bg-blue-100' :
                phase.color === 'purple' ? 'bg-blue-100' :
                'bg-blue-100';

              const textColorClass =
                phase.color === 'blue' ? 'text-blue-600' :
                phase.color === 'green' ? 'text-blue-500' :
                phase.color === 'purple' ? 'text-blue-400' :
                'text-blue-600';

              return (
                <div key={index} className="border border-gray-200 rounded-lg p-3 print:p-2">
                  <div className="flex items-center space-x-2 mb-2">
                    <div className={`w-8 h-8 ${bgColorClass} rounded-lg flex items-center justify-center flex-shrink-0 print:w-6 print:h-6`}>
                      <phase.icon className={`w-4 h-4 ${textColorClass} print:w-3 print:h-3`} />
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="text-[10px] font-semibold text-gray-500 uppercase tracking-wide">
                        {phase.weeks}
                      </div>
                      <h3 className="font-bold text-sm text-gray-900 print:text-xs">{phase.title}</h3>
                    </div>
                  </div>
                  <p className="text-xs text-gray-600 leading-snug print:text-[10px]">
                    {phase.description}
                  </p>
                </div>
              );
            })}
          </div>
        </div>

        {/* Key Benefits - Condensed */}
        <div className="p-6 print:p-4 border-b border-gray-200">
          <h2 className="text-xl font-bold text-gray-900 mb-3 print:text-lg">
            Key Benefits
          </h2>
          <div className="grid grid-cols-2 gap-4 print:gap-3">
            <div className="space-y-1.5">
              <div className="flex items-start space-x-2">
                <span className="text-blue-600 font-bold">•</span>
                <span className="text-sm text-gray-700 print:text-xs">92% fault detection accuracy</span>
              </div>
              <div className="flex items-start space-x-2">
                <span className="text-blue-600 font-bold">•</span>
                <span className="text-sm text-gray-700 print:text-xs">Detects issues <strong>days/weeks before traditional monitoring</strong></span>
              </div>
              <div className="flex items-start space-x-2">
                <span className="text-blue-600 font-bold">•</span>
                <span className="text-sm text-gray-700 print:text-xs">No hardware changes required</span>
              </div>
              <div className="flex items-start space-x-2">
                <span className="text-blue-600 font-bold">•</span>
                <span className="text-sm text-gray-700 print:text-xs">Climate-adaptive algorithms</span>
              </div>
            </div>
            <div className="space-y-1.5">
              <div className="flex items-start space-x-2">
                <span className="text-blue-500 font-bold">•</span>
                <span className="text-sm text-gray-700 print:text-xs">Fast ROI: 6-12 months typical</span>
              </div>
              <div className="flex items-start space-x-2">
                <span className="text-blue-500 font-bold">•</span>
                <span className="text-sm text-gray-700 print:text-xs">50-60% faster troubleshooting</span>
              </div>
              <div className="flex items-start space-x-2">
                <span className="text-blue-500 font-bold">•</span>
                <span className="text-sm text-gray-700 print:text-xs">Recover lost revenue quickly</span>
              </div>
              <div className="flex items-start space-x-2">
                <span className="text-blue-500 font-bold">•</span>
                <span className="text-sm text-gray-700 print:text-xs">Lower O&M costs</span>
              </div>
            </div>
          </div>

          {/* Detection Capabilities - inline */}
          <div className="mt-4 pt-4 border-t border-gray-200">
            <h3 className="text-sm font-bold text-gray-900 mb-2">What We Detect:</h3>
            <div className="flex flex-wrap gap-2">
              {detectionCapabilities.map((capability, index) => (
                <span key={index} className="text-xs bg-blue-50 text-blue-700 px-2 py-1 rounded border border-blue-200 print:text-[10px]">
                  {capability}
                </span>
              ))}
            </div>
          </div>
        </div>

        {/* Compatible Systems */}
        <div className="p-6 print:p-4 bg-gray-50 border-b border-gray-200">
          <h2 className="text-xl font-bold text-gray-900 mb-2 print:text-lg">
            Seamless Integration
          </h2>
          <div className="flex flex-wrap gap-1.5">
            {integrations.map((integration, index) => (
              <span
                key={index}
                className="px-2 py-1 bg-white border border-gray-300 rounded text-xs text-gray-700 font-medium print:text-[10px]"
              >
                {integration}
              </span>
            ))}
          </div>
        </div>

        {/* Contact Section */}
        <div className="p-6 print:p-4 bg-gradient-to-r from-blue-600 to-blue-700 text-white">
          <div className="text-center">
            <h2 className="text-xl font-bold mb-2 print:text-lg">Ready to Get Started?</h2>
            <p className="text-blue-100 mb-3 text-sm print:text-xs">
              Contact us to see how we optimize your PV operations
            </p>
            <div className="space-y-1 text-sm print:text-xs">
              <p className="text-blue-100">
                <strong>Email:</strong> contact@nuravolt.com
              </p>
              <p className="text-blue-100">
                <strong>Web:</strong> nuravolt.com
              </p>
            </div>
          </div>
        </div>
      </div>
    </>
  );
};

export default PVOnePager;
