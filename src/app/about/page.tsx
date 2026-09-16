'use client';

import { useRef } from 'react';
import { motion, useInView } from 'framer-motion';
import { Button } from '@/components/ui/button';
import Link from 'next/link';
import {
  ArrowRight,
  CheckCircle2,
  FileText,
  Scale,
} from 'lucide-react';
import { HairlineRule } from '@/components/ui/HairlineRule';
import { KPIReadout } from '@/components/ui/KPIReadout';
import { MarketingSection } from '@/components/ui/MarketingSection';

const PRINCIPLES = [
  {
    icon: FileText,
    title: 'Evidence over vendor marketing',
    detail:
      "Every model we ship comes with a model card, intended use, training data, accuracy metrics, known limitations, human oversight points. If we can't explain it, we don't ship it. This is also why the platform passes AI Act conformity out of the box.",
  },
  {
    icon: Scale,
    title: 'Regulation-ready by default',
    detail:
      'CSRD ESRS E1 reporting, EU AI Act model cards, and EU Battery Regulation passport data feeds are built in, not bolted on. You should never have to hand-compile a regulator pack from a dashboard export.',
  },
  {
    icon: CheckCircle2,
    title: 'No lock-in without value',
    detail:
      'Three peer entry points, continuous monitoring (no annual lock-in), a fixed-scope Plant Performance Audit (from €1,000, fee credits back against your first platform month if you continue), and a Data Foundation engagement for smaller plants. Pick the smallest commitment that matches the buyer\'s problem.',
  },
];

export default function AboutPage() {
  const heroRef = useRef(null);
  const heroInView = useInView(heroRef, { once: true });

  return (
    <>
      {/* Hero, no dark band, single column, hairline-separated */}
      <MarketingSection size='hero' as='div'>
        <motion.div
          ref={heroRef}
          className='max-w-4xl'
          initial={{ opacity: 0, y: 20 }}
          animate={heroInView ? { opacity: 1, y: 0 } : { opacity: 0, y: 20 }}
          transition={{ duration: 0.6 }}
        >
          <div className='font-mono text-meta uppercase tracking-[0.08em] text-ink-3 mb-3'>
            About NuraVolt
          </div>
          <h1 className='text-h1 sm:text-display font-semibold text-ink mb-6'>
            Built by operators, not consultants.
          </h1>
          <p className='text-body text-ink-2 max-w-2xl'>
            NuraVolt instruments solar and battery assets the way an asset
            manager actually needs them instrumented, physics-informed ML
            sitting on top of your live data, every loss priced in €, and a
            compliance trail that holds up in a regulator review.
          </p>
        </motion.div>
      </MarketingSection>

      <HairlineRule />

      {/* Methodology */}
      <MarketingSection id='methodology' size='default'>
        <div className='max-w-5xl'>
          <div className='grid grid-cols-1 lg:grid-cols-12 gap-10 items-start'>
            <div className='lg:col-span-7'>
              <div className='font-mono text-meta uppercase tracking-[0.08em] text-ink-3 mb-3'>
                Why our methodology works
              </div>
              <h2 className='text-h1 font-semibold text-ink mb-5'>
                Built on operational data, not slide decks.
              </h2>
              <p className='text-body text-ink-2 mb-4'>
                The methodology underlying NuraVolt was developed over eight
                years of utility-scale PV and BESS operations in European and
                emerging markets, running ML models against roughly{' '}
                <span className='font-mono text-ink'>2 GW of live production data</span>,
                validated against real revenue outcomes, not synthetic benchmarks.
              </p>
              <p className='text-body text-ink-2'>
                When we ship a fault classifier, a soiling forecast, or a
                revenue-impact estimate, every model has been pressure-tested
                against operators who would notice a wrong number, because it
                would cost them money. That bias toward real-world validation
                is the reason our audits surface findings other monitoring
                tools miss.
              </p>
            </div>

            <div className='lg:col-span-5 border-t border-divider'>
              <div className='py-5 border-b border-divider'>
                <KPIReadout value='2 GW' label='Operational PV & BESS data underlying every model' size='lg' />
              </div>
              <div className='py-5 border-b border-divider'>
                <KPIReadout value='8+ years' label='Of fleet operations informing the audit playbook' size='lg' />
              </div>
              <div className='py-5'>
                <KPIReadout value='2-5%' label='Of annual revenue typically surfaced as recoverable' size='lg' />
              </div>
            </div>
          </div>
        </div>
      </MarketingSection>

      <HairlineRule />

      {/* Three principles, hairline-divided list */}
      <MarketingSection size='default' surface='paper-2'>
        <div className='max-w-5xl'>
          <div className='mb-10 max-w-2xl'>
            <div className='font-mono text-meta uppercase tracking-[0.08em] text-ink-3 mb-3'>
              Principles
            </div>
            <h2 className='text-h1 font-semibold text-ink'>
              Three principles we refuse to compromise on
            </h2>
          </div>

          <div className='border-t border-divider'>
            {PRINCIPLES.map((p, i) => (
              <motion.div
                key={p.title}
                initial={{ opacity: 0, y: 12 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true }}
                transition={{ delay: i * 0.08 }}
                className='grid grid-cols-1 md:grid-cols-[40px_1fr] gap-6 py-7 border-b border-divider items-start'
              >
                <p.icon className='w-5 h-5 text-ink-3 mt-1' />
                <div>
                  <h3 className='text-h2 font-semibold text-ink mb-2'>{p.title}</h3>
                  <p className='text-body text-ink-2 max-w-3xl'>{p.detail}</p>
                </div>
              </motion.div>
            ))}
          </div>
        </div>
      </MarketingSection>

      <HairlineRule />

      {/* Why we exist, single content block */}
      <MarketingSection size='default' surface='paper-2'>
        <div className='max-w-4xl'>
          <div className='font-mono text-meta uppercase tracking-[0.08em] text-ink-3 mb-3'>
            Why we exist
          </div>
          <h2 className='text-h1 font-semibold text-ink mb-6'>
            The compliance layer is the moat
          </h2>
          <p className='text-body text-ink-2 mb-4 max-w-3xl'>
            Most PV monitoring platforms were designed before EU climate
            regulation became real operational overhead, before CSRD E1,
            before the EU AI Act&apos;s &quot;critical infrastructure
            management&quot; classification, before the EU Battery Regulation
            passport. They bolt on compliance exports after the fact.
          </p>
          <p className='text-body text-ink-2 max-w-3xl'>
            We built NuraVolt the other way round: regulatory requirements
            shape the data model, the ML documentation, and the audit trail
            from day one. The monitoring, fault detection, and forecasting
            features are how we earn the relationship, the compliance layer
            is why we keep it.
          </p>
        </div>
      </MarketingSection>

      <HairlineRule />

      {/* CTA */}
      <MarketingSection size='default'>
        <div className='max-w-3xl'>
          <h2 className='text-h1 font-semibold text-ink mb-4'>Want to see it?</h2>
          <p className='text-body text-ink-2 mb-8 max-w-xl'>
            Start with continuous monitoring, a one-off audit, or a Data
            Foundation engagement, or click through the live demo first.
          </p>
          <div className='flex flex-col sm:flex-row gap-3'>
            <Button size='lg' asChild>
              <Link href='/engagements'>
                See engagements
                <ArrowRight className='w-4 h-4 ml-2' />
              </Link>
            </Button>
            <Button size='lg' variant='outline' asChild>
              <Link href='/showcase'>Open the live demo</Link>
            </Button>
          </div>
        </div>
      </MarketingSection>
    </>
  );
}
