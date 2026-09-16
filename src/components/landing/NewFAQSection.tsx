'use client';

import { useState, useRef } from 'react';
import { motion, useInView, AnimatePresence } from 'framer-motion';
import { ChevronDown } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { MarketingSection } from '@/components/ui/MarketingSection';

interface NewFAQSectionProps {
  onContactClick?: () => void;
}

const FAQS = [
  {
    question: 'What if I have fresh commissioned plants with less than 1 year of data?',
    answer:
      "We have foundation models that, combined with physics, can create digital twins with less than a year of data. However, as more data comes in, the system becomes significantly better as we calibrate it to real failures in your plant's historical data. Our physics-informed approach means we can start delivering value immediately, even with minimal operational history.",
  },
  {
    question: 'How does NuraVolt fit alongside an existing SCADA system?',
    answer:
      "NuraVolt is an intelligence layer that sits on top of your existing SCADA, EMS, or inverter portal. We connect to whatever you have, Modbus, OPC UA, MQTT, REST APIs, CSV exports, and add predictive fault detection, soiling intelligence, battery health forecasting, and financial analytics that your SCADA wasn't designed for. Integration typically takes 2-3 weeks with no hardware changes. You keep your SCADA for real-time control; we give you the predictive and financial intelligence to make better decisions.",
  },
  {
    question: 'How quickly will we see ROI?',
    answer:
      'Our customized pilot program (typically 3-6 months) is designed to identify significant losses within the first 2-4 weeks. The pilot validates actual performance improvements with your facility data. Get in touch for a pilot plan tailored to your plants. Based on industry benchmarks, solar operators typically recover $50,000-200,000 annually through prevented downtime.',
  },
  {
    question: 'Will this work with our existing systems?',
    answer:
      "Yes, whether you have a full SCADA system or just an inverter cloud portal. For SCADA environments, we connect via Modbus TCP/RTU, OPC UA, or MQTT. No SCADA? We connect directly to your inverter cloud API (Huawei FusionSolar, SMA Sunny Portal, Sungrow iSolarCloud, Fronius, SolarEdge, Enphase, Oxel). For BESS, we integrate with your BMS or EMS, the approach depends on your specific setup. If your brand isn't listed, get in touch and we'll discuss integration options. Typical setup takes 2-3 weeks, no hardware changes required.",
  },
  {
    question: 'What if we want to build this capability internally?',
    answer:
      "We also consult for companies who prefer to develop in-house. This includes custom architecture design, proprietary algorithm development with your data, and comprehensive team training with full knowledge transfer. Many clients start with our platform for quick wins while we help them build longer-term internal capabilities, it's not either/or.",
  },
  {
    question: 'How do we get notified when something goes wrong?',
    answer:
      'NuraVolt supports SMS, Email, Microsoft Teams, Google Chat, and WhatsApp alert channels, configurable per user and severity level. Critical alerts can trigger emergency shutdown or isolation commands via your SCADA or inverter APIs. You also get scheduled automated reports (daily, weekly, monthly) with KPI summaries delivered to your inbox or Teams channel.',
  },
];

const NewFAQSection = ({ onContactClick }: NewFAQSectionProps) => {
  const [openIndex, setOpenIndex] = useState<number | null>(null);
  const ref = useRef(null);
  const isInView = useInView(ref, { once: true, amount: 0.1 });

  const toggleFAQ = (index: number) => {
    setOpenIndex(openIndex === index ? null : index);
  };

  return (
    <div ref={ref} id='faq'>
      <MarketingSection size='default'>
        <motion.div
          className='max-w-3xl mb-12'
          initial={{ opacity: 0, y: 20 }}
          animate={isInView ? { opacity: 1, y: 0 } : { opacity: 0, y: 20 }}
          transition={{ duration: 0.6 }}
        >
          <div className='font-mono text-meta uppercase tracking-[0.08em] text-ink-3 mb-3'>
            FAQ
          </div>
          <h2 className='text-h1 font-semibold text-ink'>
            Common questions from operators
          </h2>
        </motion.div>

        <div className='max-w-4xl border-t border-divider'>
          {FAQS.map((faq, index) => {
            const isOpen = openIndex === index;
            return (
              <motion.div
                key={index}
                className='border-b border-divider'
                initial={{ opacity: 0, y: 12 }}
                animate={isInView ? { opacity: 1, y: 0 } : { opacity: 0, y: 12 }}
                transition={{ delay: 0.05 * index, duration: 0.4 }}
              >
                <button
                  type='button'
                  aria-expanded={isOpen}
                  className='w-full text-left py-5 flex items-start justify-between gap-4 hover:bg-paper-2 transition-colors'
                  onClick={() => toggleFAQ(index)}
                >
                  <h3 className='text-body sm:text-lg font-semibold text-ink pr-4'>
                    {faq.question}
                  </h3>
                  <motion.div
                    animate={{ rotate: isOpen ? 180 : 0 }}
                    transition={{ duration: 0.2 }}
                    className='flex-shrink-0 pt-1'
                  >
                    <ChevronDown className='w-4 h-4 text-ink-3' />
                  </motion.div>
                </button>

                <AnimatePresence initial={false}>
                  {isOpen && (
                    <motion.div
                      key='answer'
                      initial={{ height: 0, opacity: 0 }}
                      animate={{ height: 'auto', opacity: 1 }}
                      exit={{ height: 0, opacity: 0 }}
                      transition={{ duration: 0.25, ease: 'easeInOut' }}
                      className='overflow-hidden'
                    >
                      <div className='pb-6 pr-8 text-body text-ink-2 max-w-3xl'>
                        {faq.answer}
                      </div>
                    </motion.div>
                  )}
                </AnimatePresence>
              </motion.div>
            );
          })}
        </div>

        {/* CTA, flat panel, no big blue card */}
        <motion.div
          className='mt-12 max-w-3xl flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 border-t border-b border-divider py-6'
          initial={{ opacity: 0, y: 20 }}
          animate={isInView ? { opacity: 1, y: 0 } : { opacity: 0, y: 20 }}
          transition={{ delay: 0.4, duration: 0.6 }}
        >
          <div>
            <div className='font-mono text-meta uppercase tracking-[0.08em] text-ink-3 mb-1'>
              Still on the fence?
            </div>
            <p className='text-body text-ink'>
              Get a custom ROI calculation and a pilot plan tailored to your plants.
            </p>
          </div>
          <Button onClick={onContactClick} size='lg'>
            Talk to us
          </Button>
        </motion.div>
      </MarketingSection>
    </div>
  );
};

export default NewFAQSection;
