'use client';

import { useEffect, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { ChevronDown, ChevronUp, MapPin, Quote, Zap, CheckCircle2 } from 'lucide-react';
import { caseStudies, type CaseStudy } from '@/data/caseStudies';
import PublicLayout from '@/components/layouts/PublicLayout';
import { Button } from '@/components/ui/button';
import { DataPanel } from '@/components/ui/DataPanel';
import { HairlineRule } from '@/components/ui/HairlineRule';
import { KPIReadout } from '@/components/ui/KPIReadout';
import { MarketingSection } from '@/components/ui/MarketingSection';
import Link from 'next/link';

export default function CaseStudiesPage() {
  const [expandedCase, setExpandedCase] = useState<string | null>(null);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const hash = window.location.hash.replace('#', '');
    if (hash && caseStudies.some((c) => c.id === hash)) {
      setExpandedCase(hash);
      const target = document.getElementById(hash);
      if (target) {
        target.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
    }
  }, []);

  const handleViewDetails = (caseId: string) => {
    setExpandedCase(expandedCase === caseId ? null : caseId);
  };

  return (
    <PublicLayout>
      <div className='min-h-screen bg-paper'>
        {/* Hero */}
        <MarketingSection size='hero' as='div'>
          <div className='max-w-4xl'>
            <div className='font-mono text-meta uppercase tracking-[0.08em] text-ink-3 mb-3'>
              Case studies · anonymised
            </div>
            <h1 className='text-h1 sm:text-display font-semibold text-ink mb-6'>
              Real results from solar operators
            </h1>
            <p className='text-body text-ink-2 max-w-2xl'>
              Anonymised case studies showing 6-13 month ROI across Europe, UAE,
              and GCC solar portfolios. Power recovery, O&amp;M savings, and
              soiling optimisation.
            </p>
          </div>
        </MarketingSection>

        <HairlineRule />

        {/* Case panels */}
        <MarketingSection size='default'>
          <div className='max-w-6xl mx-auto space-y-6'>
            {caseStudies.map((study) => {
              const isExpanded = expandedCase === study.id;
              return (
                <motion.div
                  key={study.id}
                  id={study.id}
                  initial={{ opacity: 0, y: 12 }}
                  whileInView={{ opacity: 1, y: 0 }}
                  viewport={{ once: true }}
                  className='scroll-mt-24'
                >
                  <DataPanel
                    headerLeft={`${study.region.toUpperCase()} · ${study.capacity} MW`}
                    headerRight={isExpanded ? 'EXPANDED' : 'SUMMARY'}
                    innerClassName='bg-paper text-ink'
                  >
                    <div className='p-6'>
                      <div className='flex items-start justify-between gap-4 mb-5'>
                        <div>
                          <h3 className='text-h2 font-semibold text-ink mb-2'>{study.title}</h3>
                          <div className='flex items-center gap-4 font-mono text-meta uppercase tracking-[0.08em] text-ink-3'>
                            <span className='flex items-center gap-1.5'>
                              <MapPin className='w-3.5 h-3.5' />
                              {study.region.charAt(0).toUpperCase() + study.region.slice(1)}
                            </span>
                            <span className='flex items-center gap-1.5'>
                              <Zap className='w-3.5 h-3.5' />
                              {study.capacity} MW
                            </span>
                          </div>
                        </div>
                      </div>

                      {/* KPI rail */}
                      <div className='grid grid-cols-3 gap-6 mb-5 border-t border-b border-divider py-5'>
                        <KPIReadout
                          value={study.results.costSavings}
                          label='Annual savings'
                          signal='positive'
                          size='md'
                        />
                        <KPIReadout
                          value={study.results.paybackPeriod}
                          label='Payback'
                          size='md'
                        />
                        <KPIReadout
                          value={study.results.powerRecovery}
                          label='Power recovery'
                          signal='positive'
                          size='md'
                        />
                      </div>

                      {study.quote && (
                        <div className='border-l-2 border-primary pl-4 mb-5'>
                          <Quote className='w-4 h-4 text-ink-3 mb-2' />
                          <p className='text-body text-ink-2 italic'>
                            &ldquo;{study.quote}&rdquo;
                          </p>
                        </div>
                      )}

                      <div className='mb-5'>
                        <div className='font-mono text-meta uppercase tracking-[0.08em] text-ink-3 mb-2'>
                          Challenges
                        </div>
                        <div className='flex flex-wrap gap-2'>
                          {study.challenges.slice(0, 3).map((challenge, idx) => (
                            <span
                              key={idx}
                              className='font-mono text-meta uppercase tracking-[0.08em] text-ink-2 border border-divider rounded-sm px-2.5 py-1 bg-paper-2'
                            >
                              {challenge}
                            </span>
                          ))}
                        </div>
                      </div>

                      <Button
                        onClick={() => handleViewDetails(study.id)}
                        variant={isExpanded ? 'outline' : 'default'}
                        size='lg'
                        className='w-full sm:w-auto'
                      >
                        {isExpanded ? (
                          <>
                            <ChevronUp className='w-4 h-4 mr-2' />
                            Hide details
                          </>
                        ) : (
                          <>
                            <ChevronDown className='w-4 h-4 mr-2' />
                            View full case study
                          </>
                        )}
                      </Button>

                      <AnimatePresence initial={false}>
                        {isExpanded && (
                          <motion.div
                            key='expanded'
                            initial={{ opacity: 0, height: 0 }}
                            animate={{ opacity: 1, height: 'auto' }}
                            exit={{ opacity: 0, height: 0 }}
                            transition={{ duration: 0.3 }}
                            className='overflow-hidden mt-8'
                          >
                            <ExpandedStudy study={study} />
                          </motion.div>
                        )}
                      </AnimatePresence>
                    </div>
                  </DataPanel>
                </motion.div>
              );
            })}
          </div>
        </MarketingSection>

        <HairlineRule />

        {/* CTA */}
        <MarketingSection size='default'>
          <div className='max-w-3xl'>
            <div className='font-mono text-meta uppercase tracking-[0.08em] text-ink-3 mb-3'>
              Your numbers
            </div>
            <h2 className='text-h1 font-semibold text-ink mb-4'>
              Want similar results on your portfolio?
            </h2>
            <p className='text-body text-ink-2 mb-8'>
              Run your own numbers in the ROI calculator, or book a fixed-scope
              audit and we&apos;ll quantify the loss directly from your data.
            </p>
            <div className='flex flex-col sm:flex-row gap-3'>
              <Button size='lg' asChild>
                <Link href='/roi-calculator'>Calculate your ROI</Link>
              </Button>
              <Button size='lg' variant='outline' asChild>
                <Link href='/engagements'>Book an audit</Link>
              </Button>
            </div>
          </div>
        </MarketingSection>
      </div>
    </PublicLayout>
  );
}

function ExpandedStudy({ study }: { study: CaseStudy }) {
  return (
    <div className='border-t border-divider pt-8 space-y-10'>
      {/* Key results */}
      <section>
        <div className='font-mono text-meta uppercase tracking-[0.08em] text-ink-3 mb-3'>
          Key results
        </div>
        <h4 className='text-h2 font-semibold text-ink mb-5'>What we delivered</h4>
        <div className='grid md:grid-cols-2 gap-0 border-t border-divider'>
          {study.results.specificMetrics.map((metric, idx) => (
            <div
              key={idx}
              className={`py-5 px-5 border-b border-divider ${idx % 2 === 0 ? 'md:border-r' : ''}`}
            >
              <div className='flex items-start gap-3'>
                <CheckCircle2 className='w-4 h-4 text-signal-positive mt-1 flex-shrink-0' />
                <div>
                  <p className='font-semibold text-ink'>
                    {metric.label}:{' '}
                    <span className='font-mono text-primary tabular-nums'>{metric.value}</span>
                  </p>
                  <p className='text-body text-ink-2 mt-1'>{metric.description}</p>
                </div>
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* Implementation */}
      <section>
        <div className='font-mono text-meta uppercase tracking-[0.08em] text-ink-3 mb-3'>
          Implementation
        </div>
        <h4 className='text-h2 font-semibold text-ink mb-5'>How it shipped</h4>
        <div className='border border-divider rounded-sm p-5 bg-paper-2'>
          <div className='grid sm:grid-cols-2 gap-5 mb-4'>
            <div>
              <div className='font-mono text-meta uppercase tracking-[0.08em] text-ink-3 mb-1'>
                Timeline
              </div>
              <p className='text-body text-ink'>{study.implementation.timeline}</p>
            </div>
            <div>
              <div className='font-mono text-meta uppercase tracking-[0.08em] text-ink-3 mb-1'>
                Approach
              </div>
              <p className='text-body text-ink'>{study.implementation.approach}</p>
            </div>
          </div>
          <HairlineRule />
          <div className='mt-4'>
            <div className='font-mono text-meta uppercase tracking-[0.08em] text-ink-3 mb-2'>
              Key features
            </div>
            <ul className='space-y-2'>
              {study.implementation.keyFeatures.map((feature, idx) => (
                <li key={idx} className='text-body text-ink-2 flex items-start gap-2'>
                  <span className='text-primary font-bold mt-1.5 leading-none'>·</span>
                  {feature}
                </li>
              ))}
            </ul>
          </div>
        </div>
      </section>

      {study.detectionCapabilities && (
        <section>
          <div className='font-mono text-meta uppercase tracking-[0.08em] text-ink-3 mb-3'>
            Detection capabilities
          </div>
          <div className='border-t border-divider'>
            {study.detectionCapabilities.map((capability, idx) => (
              <div key={idx} className='py-5 border-b border-divider grid sm:grid-cols-[1fr_auto_auto] items-baseline gap-x-8 gap-y-2'>
                <div className='font-semibold text-ink'>{capability.category}</div>
                <KPIReadout
                  value={capability.advanceWarning}
                  label='Advance warning'
                  size='sm'
                  signal='positive'
                />
                <KPIReadout
                  value={capability.accuracy}
                  label='Accuracy'
                  size='sm'
                  signal='positive'
                />
              </div>
            ))}
          </div>
        </section>
      )}

      {study.aiTechnology && (
        <section>
          <div className='font-mono text-meta uppercase tracking-[0.08em] text-ink-3 mb-3'>
            AI technology
          </div>
          <div className='border border-divider rounded-sm p-5 bg-paper-2 space-y-4'>
            <div>
              <div className='font-mono text-meta uppercase tracking-[0.08em] text-ink-3 mb-1'>
                Pre-trained foundation model
              </div>
              <p className='text-body text-ink'>{study.aiTechnology.preTrainedModel}</p>
            </div>
            <HairlineRule />
            <div className='grid sm:grid-cols-2 gap-6'>
              <KPIReadout value={study.aiTechnology.zeroShotAccuracy} label='Zero-shot accuracy' size='lg' signal='positive' />
              <KPIReadout value={study.aiTechnology.operationalAccuracy} label='Operational accuracy' size='lg' signal='positive' />
            </div>
            <HairlineRule />
            <div>
              <div className='font-mono text-meta uppercase tracking-[0.08em] text-ink-3 mb-1'>
                Training data size
              </div>
              <p className='text-body text-ink'>{study.aiTechnology.trainingDataSize}</p>
            </div>
            <HairlineRule />
            <div className='flex items-center gap-2'>
              <CheckCircle2 className='w-4 h-4 text-signal-positive' />
              <p className='text-body text-ink'>
                Continuous learning: improves with your operational data
              </p>
            </div>
          </div>
        </section>
      )}

      {study.soilingDetails && (
        <section>
          <div className='font-mono text-meta uppercase tracking-[0.08em] text-ink-3 mb-3'>
            Soiling detection methodology
          </div>
          <div className='border border-divider rounded-sm p-5 bg-paper-2 space-y-4'>
            <div>
              <div className='font-mono text-meta uppercase tracking-[0.08em] text-ink-3 mb-1'>
                Detection method
              </div>
              <p className='text-body text-ink'>{study.soilingDetails.detectionMethod}</p>
            </div>
            <HairlineRule />
            <div className='grid sm:grid-cols-2 gap-6'>
              <KPIReadout value={study.soilingDetails.soilingRate} label='Soiling rate' size='lg' />
              <KPIReadout value={study.soilingDetails.accuracy} label='Detection accuracy' size='lg' signal='positive' />
            </div>
            <HairlineRule />
            <div>
              <div className='font-mono text-meta uppercase tracking-[0.08em] text-ink-3 mb-2'>
                Technical approach
              </div>
              <ul className='space-y-2'>
                {study.soilingDetails.methodology.map((method, idx) => (
                  <li key={idx} className='text-body text-ink-2 flex items-start gap-2'>
                    <span className='text-primary font-bold mt-1.5 leading-none'>·</span>
                    <span>{method}</span>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </section>
      )}

      {study.deploymentOptions && (
        <section>
          <div className='font-mono text-meta uppercase tracking-[0.08em] text-ink-3 mb-3'>
            Deployment options
          </div>
          <div className='flex flex-wrap gap-2 mb-4'>
            {study.deploymentOptions.cloud && (
              <span className='inline-flex items-center gap-2 font-mono text-meta uppercase tracking-[0.08em] text-ink border border-divider rounded-sm px-3 py-1.5 bg-paper'>
                <CheckCircle2 className='w-3.5 h-3.5 text-signal-positive' />
                Cloud
              </span>
            )}
            {study.deploymentOptions.onPremise && (
              <span className='inline-flex items-center gap-2 font-mono text-meta uppercase tracking-[0.08em] text-ink border border-divider rounded-sm px-3 py-1.5 bg-paper'>
                <CheckCircle2 className='w-3.5 h-3.5 text-signal-positive' />
                On-premise
              </span>
            )}
            {study.deploymentOptions.hybrid && (
              <span className='inline-flex items-center gap-2 font-mono text-meta uppercase tracking-[0.08em] text-ink border border-divider rounded-sm px-3 py-1.5 bg-paper'>
                <CheckCircle2 className='w-3.5 h-3.5 text-signal-positive' />
                Hybrid
              </span>
            )}
          </div>
          {study.deploymentOptions.notes && (
            <p className='text-body text-ink-2'>{study.deploymentOptions.notes}</p>
          )}
        </section>
      )}

      {study.roiDisclaimer && (
        <div className='border-l-2 border-signal-warning pl-4'>
          <div className='font-mono text-meta uppercase tracking-[0.08em] text-ink-3 mb-1'>
            ROI disclaimer
          </div>
          <p className='text-body text-ink-2'>{study.roiDisclaimer}</p>
        </div>
      )}
    </div>
  );
}
