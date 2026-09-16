'use client';

import { motion, useInView } from 'framer-motion';
import { useRef } from 'react';
import { ArrowRight, Database, Layers, Zap } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { DataPanel } from '@/components/ui/DataPanel';
import { KPIReadout } from '@/components/ui/KPIReadout';
import { MarketingSection } from '@/components/ui/MarketingSection';
import { goToLeadForm } from './leadFormIntent';

/**
 * Third pillar on the homepage, for plants without a usable SCADA or that
 * just want a read-side data layer they can pull from. Standalone offer; not
 * a setup step inside an audit. CTA opens the lead form with intent=foundation.
 */

const BULLETS = [
  {
    icon: Database,
    title: 'Read-side ingestion',
    body: 'Modbus TCP, OPC UA, MQTT, inverter clouds (Huawei, SMA, Sungrow, Fronius, SolarEdge, Enphase), CSV, InfluxDB. Whatever you already have. No on-site hardware changes.',
  },
  {
    icon: Layers,
    title: 'Normalized + queryable',
    body: 'Register mapping, unit validation, timezone reconciliation. Timestamped, normalized, queryable. SCADA-grade telemetry without the SCADA.',
  },
  {
    icon: Zap,
    title: 'Stop here, or scale up',
    body: 'Use it as a standalone data layer for your own analytics. Or layer NuraVolt monitoring on top later when you\'re ready.',
  },
];

export default function DataFoundationSection() {
  const ref = useRef(null);
  const isInView = useInView(ref, { once: true, amount: 0.2 });

  return (
    <MarketingSection id='data-foundation' size='default' surface='paper-2'>
      <div ref={ref} className='max-w-6xl mx-auto'>
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={isInView ? { opacity: 1, y: 0 } : { opacity: 0, y: 20 }}
          transition={{ duration: 0.6 }}
          className='max-w-3xl mb-10'
        >
          <div className='font-mono text-meta uppercase tracking-[0.08em] text-ink-3 mb-3'>
            Data Foundation · For smaller plants &amp; SCADA-replacement
          </div>
          <h2 className='text-h1 font-semibold text-ink mb-4 text-balance'>
            Smaller plant. No SCADA. Or a SCADA that doesn&apos;t give you the data you need.
          </h2>
          <p className='text-body text-ink-2 text-balance'>
            For PV and BESS sites under ~20 MW, we run the read-side data layer
            for you. Plug into your inverters, BMS, meters, and exports, and
            get a normalized, queryable stream you (or we) can build on.
          </p>
        </motion.div>

        <div className='grid grid-cols-1 lg:grid-cols-[1.1fr_1fr] gap-10 items-stretch'>
          {/* Bullets, hairline-divided */}
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={isInView ? { opacity: 1, y: 0 } : { opacity: 0, y: 20 }}
            transition={{ duration: 0.5, delay: 0.1 }}
            className='border-t border-divider'
          >
            {BULLETS.map((b) => {
              const Icon = b.icon;
              return (
                <div
                  key={b.title}
                  className='grid grid-cols-[28px_1fr] gap-4 py-6 border-b border-divider items-start'
                >
                  <Icon className='w-5 h-5 text-ink-3 mt-1' />
                  <div>
                    <h3 className='text-h2 font-semibold text-ink mb-1.5'>{b.title}</h3>
                    <p className='text-body text-ink-2'>{b.body}</p>
                  </div>
                </div>
              );
            })}
          </motion.div>

          {/* DataPanel, instrument-frame KPI rail */}
          <motion.div
            initial={{ opacity: 0, x: 30 }}
            animate={isInView ? { opacity: 1, x: 0 } : { opacity: 0, x: 30 }}
            transition={{ duration: 0.5, delay: 0.2 }}
          >
            <DataPanel
              headerLeft='Data Foundation · Read-side ingestion'
              headerRight='2-3 wk delivery'
              footer={<span>Fixed-quote integration · no hardware changes</span>}
              innerClassName='p-6'
            >
              <div className='grid grid-cols-2 gap-y-6 gap-x-4'>
                <KPIReadout
                  value='2-3 wk'
                  label='typical delivery'
                  tone='data'
                  size='md'
                  delay={0.2}
                />
                <KPIReadout
                  value='<20 MW'
                  label='target plant size'
                  tone='data'
                  size='md'
                  delay={0.3}
                />
                <KPIReadout
                  value='6+'
                  label='inverter cloud APIs'
                  tone='data'
                  size='md'
                  delay={0.4}
                />
                <KPIReadout
                  value='Modbus · OPC UA · MQTT'
                  label='industrial protocols'
                  tone='data'
                  size='sm'
                  delay={0.5}
                />
              </div>

              <div className='mt-6 pt-5 border-t border-data-rule font-mono text-meta uppercase tracking-[0.08em] text-data-fg-2'>
                <div>Inputs · SCADA · BMS · inverter cloud · CSV · MQTT · InfluxDB</div>
                <div className='mt-1'>Output · normalized timeseries · documented schema · API access</div>
              </div>
            </DataPanel>
          </motion.div>
        </div>

        <motion.div
          initial={{ opacity: 0, y: 10 }}
          animate={isInView ? { opacity: 1, y: 0 } : { opacity: 0, y: 10 }}
          transition={{ duration: 0.4, delay: 0.3 }}
          className='mt-10 flex flex-col sm:flex-row gap-4 items-start sm:items-center'
        >
          <Button size='lg' onClick={() => goToLeadForm('foundation')}>
            Talk to us about Data Foundation
            <ArrowRight className='w-4 h-4 ml-2' />
          </Button>
          <p className='font-mono text-meta uppercase tracking-[0.08em] text-ink-3'>
            Stop here · or layer monitoring on top later
          </p>
        </motion.div>
      </div>
    </MarketingSection>
  );
}
