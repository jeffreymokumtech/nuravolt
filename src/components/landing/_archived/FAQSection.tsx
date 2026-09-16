'use client';

import { useState } from 'react';
import { ChevronDown, ChevronUp } from 'lucide-react';

const faqs = [
  {
    question: 'How quickly can NuraVolt be deployed?',
    answer: 'Our 2-month pilot program begins with 2-3 weeks of integration and setup, followed by live monitoring and results validation. We integrate with your existing SCADA systems via Modbus, OPC UA, and REST APIs with no hardware changes required. Enterprise deployments with multiple sites follow a phased rollout approach.'
  },
  {
    question: 'What equipment is compatible with NuraVolt?',
    answer: 'We support all major inverter brands including SMA, Huawei, Sungrow, Fronius, SolarEdge, and more. Our platform works with Modbus-TCP, OPC UA, REST APIs, MQTT, and SunSpec protocols. For battery systems, we integrate with major BMS platforms. If you have a specific system, our technical team can confirm compatibility.'
  },
  {
    question: 'How does the AI predict equipment failures?',
    answer: 'Our AI models analyze patterns from millions of data points including power output, temperature, voltage, and environmental conditions. By comparing your equipment behavior against our vast database, we can identify anomalies that indicate potential failures 7-30 days in advance with 95% accuracy.'
  },
  {
    question: 'What kind of ROI can I expect?',
    answer: 'Most customers see ROI within 3-6 months. On average, our platform helps recover 15-20% of lost revenue through reduced downtime, optimized maintenance scheduling, and improved efficiency. For a 50 MW plant, this typically translates to AED 2-3 million annually.'
  },
  {
    question: 'Is my data secure?',
    answer: 'Absolutely. We use bank-grade encryption for all data transmission and storage. Our platform is ISO 27001 certified and compliant with UAE data protection regulations. You maintain full ownership of your data, and we never share it with third parties.'
  },
  {
    question: 'Can HeliosIQ integrate with my existing systems?',
    answer: 'Yes, we offer comprehensive API access and can integrate with most SCADA systems, asset management platforms, and business intelligence tools. Our team will work with you to ensure seamless integration with your existing infrastructure.'
  }
];

const FAQSection = () => {
  const [openIndex, setOpenIndex] = useState<number | null>(null);

  const toggleFAQ = (index: number) => {
    setOpenIndex(openIndex === index ? null : index);
  };

  return (
    <section className="py-16 sm:py-24 bg-white">
      <div className="container mx-auto px-4 sm:px-6 lg:px-8">
        <div className="text-center max-w-3xl mx-auto mb-12">
          <h2 className="text-3xl sm:text-4xl font-bold text-gray-900 mb-4">
            Frequently Asked Questions
          </h2>
          <p className="text-xl text-gray-600">
            Everything you need to know about HeliosIQ
          </p>
        </div>

        <div className="max-w-3xl mx-auto">
          {faqs.map((faq, index) => (
            <div
              key={index}
              className="border-b border-gray-200 last:border-b-0"
            >
              <button
                className="w-full py-6 px-4 text-left hover:bg-gray-50 transition-colors focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2"
                onClick={() => toggleFAQ(index)}
              >
                <div className="flex justify-between items-center">
                  <h3 className="text-lg font-semibold text-gray-900 pr-8">
                    {faq.question}
                  </h3>
                  {openIndex === index ? (
                    <ChevronUp className="h-5 w-5 text-gray-500 flex-shrink-0" />
                  ) : (
                    <ChevronDown className="h-5 w-5 text-gray-500 flex-shrink-0" />
                  )}
                </div>
              </button>
              
              {openIndex === index && (
                <div className="px-4 pb-6 text-gray-600">
                  {faq.answer}
                </div>
              )}
            </div>
          ))}
        </div>

        <div className="mt-12 text-center">
          <p className="text-gray-600 mb-4">
            Still have questions? We're here to help.
          </p>
          <a
            href="mailto:support@heliosiq.com"
            className="text-blue-600 hover:text-blue-700 font-semibold"
          >
            Contact our team →
          </a>
        </div>
      </div>
    </section>
  );
};

export default FAQSection;