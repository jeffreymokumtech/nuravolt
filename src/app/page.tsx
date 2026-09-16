'use client';

import { useState, useEffect } from 'react';
import dynamic from 'next/dynamic';
import Link from 'next/link';
import { ArrowRight } from 'lucide-react';
import HeroSection from '@/components/landing/HeroSection';
import LiveShowcaseTickerStrip from '@/components/landing/LiveShowcaseTickerStrip';
import ProofStripSection from '@/components/landing/ProofStripSection';
import TrustBar from '@/components/landing/TrustBar';
import ProblemSection from '@/components/landing/ProblemSection';
import ConsultingServicesSection from '@/components/landing/ConsultingServicesSection';
import MethodologyStripSection from '@/components/landing/MethodologyStripSection';
import DataFoundationSection from '@/components/landing/DataFoundationSection';
import AuditLeadForm from '@/components/landing/AuditLeadForm';
import ResourceCTA from '@/components/resources/ResourceCTA';
import LatestBlogPosts from '@/components/landing/LatestBlogPosts';
import NewFAQSection from '@/components/landing/NewFAQSection';
import MarketingHeader from '@/components/layouts/MarketingHeader';
import { MarketingSection } from '@/components/ui/MarketingSection';
import { measurePerformance, addResourceHints } from '@/utils/performance';
import CriticalCSS from '@/components/CriticalCSS';
import BackToTopButton from '@/components/BackToTopButton';
import Footer from '@/components/Footer';
import SchemaJsonLd from '@/components/SchemaJsonLd';
import { buildSoftwareApplicationSchema } from '@/libs/seo';

const BookingModal = dynamic(() => import('@/components/landing/BookingModal'));

const referenceHubs = [
  { href: '/mcp', title: 'MCP Server', hint: 'Query NuraVolt from Claude, ChatGPT, Cursor' },
  { href: '/reports', title: 'Data reports', hint: 'Open benchmarks on public solar and battery data' },
  { href: '/compare', title: 'Compare platforms', hint: 'Honest comparisons: sensors, vendors, alternatives' },
  { href: '/solar-monitoring', title: 'By country', hint: 'South Africa, Kenya, Nigeria, Spain, KSA, UAE' },
  { href: '/bess', title: 'BESS metrics', hint: 'SoH, RTE, augmentation, LCOS, warranty math' },
  { href: '/pv-metrics', title: 'PV metrics', hint: 'Performance Ratio, CUF, specific yield, availability' },
  { href: '/faults', title: 'Fault library', hint: 'Every PV & BESS failure mode we detect' },
  { href: '/integrations', title: 'Integrations', hint: 'Huawei, Tesla Megapack, and the data we ingest' },
  { href: '/insights', title: 'Insights', hint: 'Warranty disputes, soiling economics, PPA guarantees' },
];

// Direct links to flagship deep pages, the homepage is the strongest indexed
// surface, so linking key articles one click away helps them get crawled.
const flagshipPages = [
  { href: '/bess/state-of-health', title: 'State of Health (SoH)' },
  { href: '/bess/augmentation', title: 'Battery augmentation' },
  { href: '/bess/warranty-as-data-product', title: 'Warranty as a data product' },
  { href: '/pv-metrics/performance-ratio', title: 'Performance Ratio (PR)' },
  { href: '/faults/soiling-loss', title: 'Soiling loss' },
  { href: '/faults/balance-of-system-thermal', title: 'Balance-of-system thermal failure' },
  { href: '/reports/ml-solar-fault-detection-benchmark', title: 'ML solar fault benchmark' },
  { href: '/compare/best-solar-monitoring-software-2026', title: 'Best solar monitoring software 2026' },
  { href: '/compare/best-bess-monitoring-software-2026', title: 'Best BESS monitoring software 2026' },
  { href: '/compare/best-solar-asset-management-software-2026', title: 'Best solar asset management software 2026' },
  { href: '/solar-monitoring/south-africa', title: 'Solar monitoring in South Africa' },
];

export default function Home() {
  const [isBookingModalOpen, setIsBookingModalOpen] = useState(false);

  useEffect(() => {
    measurePerformance();
    addResourceHints();
  }, []);

  return (
    <div className='min-h-screen bg-paper'>
      <SchemaJsonLd data={buildSoftwareApplicationSchema()} />
      <MarketingHeader />

      <CriticalCSS />

      <main>
        <HeroSection />
        <LiveShowcaseTickerStrip />
        <ProofStripSection />
        <TrustBar />
        <ProblemSection />
        <ConsultingServicesSection />
        <MethodologyStripSection />
        <DataFoundationSection />

        {/* Lead form, three intents, one form */}
        <MarketingSection size='default'>
          <div className='max-w-3xl mx-auto mb-10'>
            <div className='font-mono text-meta uppercase tracking-[0.08em] text-ink-3 mb-3'>
              Three ways to start with NuraVolt
            </div>
            <h2 className='text-h1 font-semibold text-ink mb-3'>
              Continuous monitoring, a one-off audit, or a Data Foundation engagement.
            </h2>
            <p className='text-body text-ink-2'>
              Pick the path that fits, most operators start with continuous
              monitoring. A fixed-scope Plant Performance Audit (from €1,000)
              is the diagnostic option. Data Foundation is the read-side data
              layer for smaller plants. Tell us about your asset; we&apos;ll
              reply within 24 hours.
            </p>
          </div>
          <div className='max-w-2xl mx-auto'>
            <AuditLeadForm
              source='homepage_main_cta'
              variant='embedded'
              defaultIntent='monitoring'
            />
          </div>
        </MarketingSection>

        <MarketingSection size='compact'>
          <ResourceCTA
            title='Irradiation data quality, validation methods for reliable operations'
            description='Free 5-page technical guide on sensor calibration and validation techniques for desert climates'
            resourceSlug='irradiation-data-quality'
            variant='banner'
          />
        </MarketingSection>

        {/* MCP Server announcement — the "product in AI" pivot. Placed above the
            reference library so it lands in the mid-scroll, still visible to
            visitors who don't reach the end of the page. */}
        <MarketingSection size='compact' surface='paper-2'>
          <div className='max-w-6xl mx-auto flex flex-col lg:flex-row lg:items-center lg:justify-between gap-6'>
            <div className='max-w-2xl'>
              <div className='inline-flex items-center gap-2 mb-3'>
                <span className='rounded-full bg-primary/10 text-primary px-2 py-0.5 text-[10px] font-semibold tracking-wide'>
                  NEW
                </span>
                <span className='font-mono text-meta uppercase tracking-[0.08em] text-ink-3'>
                  MCP Server
                </span>
              </div>
              <h2 className='text-h1 font-semibold text-ink mb-3'>
                Shams, in Claude. In ChatGPT. In Cursor.
              </h2>
              <p className='text-body text-ink-2'>
                The same fifteen tools Shams uses inside the platform, callable from any
                MCP-aware assistant. Ask your plants questions from wherever your team
                already works.
              </p>
            </div>
            <div className='shrink-0'>
              <Link
                href='/mcp'
                className='inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2.5 text-sm font-medium text-white hover:bg-primary/90 shadow-sm'
              >
                See how it works
                <ArrowRight className='w-4 h-4' />
              </Link>
            </div>
          </div>
        </MarketingSection>

        {/* Reference library, surfaces the programmatic content catalog from the
            homepage so the deep pages gain link equity and get crawled. */}
        <MarketingSection size='default'>
          <div className='max-w-6xl mx-auto'>
            <div className='font-mono text-meta uppercase tracking-[0.08em] text-ink-3 mb-3'>
              Reference library
            </div>
            <h2 className='text-h1 font-semibold text-ink mb-3'>
              The engineering reference behind the platform
            </h2>
            <p className='text-body text-ink-2 max-w-2xl mb-8'>
              Plain-English explanations of the metrics and fault modes we monitor, the same
              definitions our physics-informed models run on.
            </p>
            <div className='grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 border-t border-l border-divider'>
              {referenceHubs.map((hub) => (
                <Link
                  key={hub.href}
                  href={hub.href}
                  className='group border-b border-r border-divider p-6 hover:bg-paper-2 transition-colors'
                >
                  <div className='flex items-center justify-between'>
                    <h3 className='text-h2 font-semibold text-ink group-hover:text-primary transition-colors'>
                      {hub.title}
                    </h3>
                    <ArrowRight className='w-4 h-4 text-ink-3 group-hover:text-primary group-hover:translate-x-1 transition-all' />
                  </div>
                  <p className='text-body text-ink-2 mt-2'>{hub.hint}</p>
                </Link>
              ))}
            </div>

            <div className='mt-8 flex flex-wrap items-center gap-x-2 gap-y-2'>
              <span className='font-mono text-meta uppercase tracking-[0.08em] text-ink-3 mr-1'>
                Popular references
              </span>
              {flagshipPages.map((p, i) => (
                <span key={p.href} className='flex items-center'>
                  {i > 0 && <span className='text-ink-3 mr-2' aria-hidden>·</span>}
                  <Link
                    href={p.href}
                    className='text-body text-ink-2 hover:text-primary underline underline-offset-2 transition-colors'
                  >
                    {p.title}
                  </Link>
                </span>
              ))}
            </div>
          </div>
        </MarketingSection>

        <LatestBlogPosts />

        <NewFAQSection onContactClick={() => setIsBookingModalOpen(true)} />
      </main>

      <Footer />

      <BookingModal
        isOpen={isBookingModalOpen}
        onClose={() => setIsBookingModalOpen(false)}
      />

      <BackToTopButton />
    </div>
  );
}
