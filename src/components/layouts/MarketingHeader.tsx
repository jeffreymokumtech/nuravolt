'use client';

/**
 * MarketingHeader, the single source-of-truth nav for every public-facing
 * page on the NuraVolt site. Used by PublicLayout (which wraps most public
 * pages), the homepage, and the solutions sub-layout. If you need to add or
 * reorder a nav item, this is the only file to touch.
 */

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import dynamic from 'next/dynamic';
import { ChevronDown, ArrowRight } from 'lucide-react';
import NuraVoltLogo from '@/components/NuraVoltLogo';
import { Button } from '@/components/ui/button';
import { useSession } from '@/lib/auth-client';

// Lazy import, only loads when the user clicks "Book a call".
const BookingModal = dynamic(() => import('@/components/landing/BookingModal'));

interface MarketingHeaderProps {
  /** Optional override for the primary CTA destination (default: /#audit-lead-form). */
  ctaHref?: string;
  /** Optional override for the primary CTA label (default: "Talk to us"). */
  ctaLabel?: string;
}

export default function MarketingHeader({
  ctaHref = '/#audit-lead-form',
  ctaLabel = 'Talk to us',
}: MarketingHeaderProps) {
  const [isPlatformDropdownOpen, setIsPlatformDropdownOpen] = useState(false);
  const [isSolutionsDropdownOpen, setIsSolutionsDropdownOpen] = useState(false);
  const [isResourcesDropdownOpen, setIsResourcesDropdownOpen] = useState(false);
  const [isBookingModalOpen, setIsBookingModalOpen] = useState(false);
  const { data: session } = useSession();
  const isSignedIn = !!session?.user;
  const platformDropdownRef = useRef<HTMLDivElement>(null);
  const solutionsDropdownRef = useRef<HTMLDivElement>(null);
  const resourcesDropdownRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (
        platformDropdownRef.current &&
        !platformDropdownRef.current.contains(event.target as Node)
      ) {
        setIsPlatformDropdownOpen(false);
      }
      if (
        solutionsDropdownRef.current &&
        !solutionsDropdownRef.current.contains(event.target as Node)
      ) {
        setIsSolutionsDropdownOpen(false);
      }
      if (
        resourcesDropdownRef.current &&
        !resourcesDropdownRef.current.contains(event.target as Node)
      ) {
        setIsResourcesDropdownOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  return (
    <>
      <nav className='sticky top-0 z-50 bg-paper/95 backdrop-blur-sm border-b border-divider'>
        <div className='container mx-auto px-4 sm:px-6 lg:px-8'>
          <div className='flex justify-between items-center h-16'>
            <div className='flex items-center'>
              <Link href='/' className='flex items-center'>
                <NuraVoltLogo width={180} height={44} showTagline={false} className='h-9' />
              </Link>
            </div>

            <div className='hidden md:flex items-center gap-7'>
              {/* Platform */}
              <div className='relative' ref={platformDropdownRef}>
                <button
                  type='button'
                  className={navTriggerClass}
                  onClick={() => setIsPlatformDropdownOpen(!isPlatformDropdownOpen)}
                  aria-expanded={isPlatformDropdownOpen}
                >
                  Platform
                  <ChevronDown
                    className={`ml-1 h-3.5 w-3.5 transition-transform ${
                      isPlatformDropdownOpen ? 'rotate-180' : ''
                    }`}
                  />
                </button>
                {isPlatformDropdownOpen && (
                  <div className={dropdownClass + ' w-72'}>
                    <DropdownItem
                      href='/mcp'
                      title='MCP Server · NEW'
                      hint='Query NuraVolt from Claude, ChatGPT, Cursor'
                      onClick={() => setIsPlatformDropdownOpen(false)}
                    />
                    <DropdownItem
                      href='/platform/features'
                      title='Features'
                      hint='What the platform does end-to-end'
                      onClick={() => setIsPlatformDropdownOpen(false)}
                    />
                    <DropdownItem
                      href='/platform/reporting'
                      title='Reporting & Dashboards'
                      hint='Interactive dashboards & scheduled PDF delivery'
                      onClick={() => setIsPlatformDropdownOpen(false)}
                    />
                    <DropdownItem
                      href='/platform/integrations'
                      title='Data Integrations'
                      hint='SCADA, inverter clouds, InfluxDB, Modbus & CSV'
                      onClick={() => setIsPlatformDropdownOpen(false)}
                    />
                    <DropdownItem
                      href='/faults'
                      title='Fault library'
                      hint='Every PV & BESS fault mode we detect'
                      onClick={() => setIsPlatformDropdownOpen(false)}
                    />
                    <DropdownItem
                      href='/compliance/reference'
                      title='Compliance'
                      hint='Grid codes & reporting obligations per country'
                      onClick={() => setIsPlatformDropdownOpen(false)}
                    />
                    <div className='border-t border-divider mt-1 pt-1'>
                      <Link
                        href='/showcase'
                        className='block px-4 py-3 text-primary hover:bg-paper-2 transition-colors font-semibold text-sm'
                        onClick={() => setIsPlatformDropdownOpen(false)}
                      >
                        Try the Live Demo →
                      </Link>
                    </div>
                  </div>
                )}
              </div>

              {/* Our Solutions, BESS first */}
              <div className='relative' ref={solutionsDropdownRef}>
                <button
                  type='button'
                  className={navTriggerClass}
                  onClick={() => setIsSolutionsDropdownOpen(!isSolutionsDropdownOpen)}
                  aria-expanded={isSolutionsDropdownOpen}
                >
                  Solutions
                  <ChevronDown
                    className={`ml-1 h-3.5 w-3.5 transition-transform ${
                      isSolutionsDropdownOpen ? 'rotate-180' : ''
                    }`}
                  />
                </button>
                {isSolutionsDropdownOpen && (
                  <div className={dropdownClass + ' w-72'}>
                    <DropdownItem
                      href='/solutions/bess-monitoring'
                      title='BESS Analytics'
                      hint='Warranty, cycling, degradation-aware dispatch'
                      onClick={() => setIsSolutionsDropdownOpen(false)}
                    />
                    <DropdownItem
                      href='/solutions/audit'
                      title='NuraVolt Audit'
                      hint='One-off optimizer, warranty & compliance audits'
                      onClick={() => setIsSolutionsDropdownOpen(false)}
                    />
                    <DropdownItem
                      href='/bess'
                      title='BESS metrics explained'
                      hint='SoH, RTE, EFC, rainflow & more'
                      onClick={() => setIsSolutionsDropdownOpen(false)}
                    />
                    <DropdownItem
                      href='/solutions/pv-monitoring'
                      title='PV Monitoring'
                      hint='Soiling, fault detection, portfolio analytics'
                      onClick={() => setIsSolutionsDropdownOpen(false)}
                    />
                    <DropdownItem
                      href='/pv-metrics'
                      title='PV metrics explained'
                      hint='PR, CUF, specific yield, availability & more'
                      onClick={() => setIsSolutionsDropdownOpen(false)}
                    />
                    <DropdownItem
                      href='/solutions/wind-monitoring'
                      title='Wind Monitoring'
                      hint='Turbine performance & predictive maintenance'
                      onClick={() => setIsSolutionsDropdownOpen(false)}
                    />
                    <DropdownItem
                      href='/solutions/hydrogen-monitoring'
                      title='Hydrogen Analytics'
                      hint='Electrolyzer efficiency, stack health & economics'
                      onClick={() => setIsSolutionsDropdownOpen(false)}
                    />
                    <DropdownItem
                      href='/solar-monitoring'
                      title='Solar monitoring by country'
                      hint='South Africa, Kenya, Nigeria, Spain, KSA, UAE'
                      onClick={() => setIsSolutionsDropdownOpen(false)}
                    />
                    <DropdownItem
                      href='/engagements'
                      title='Professional Services'
                      hint='Audits, diagnostics & the Data Foundation service'
                      onClick={() => setIsSolutionsDropdownOpen(false)}
                    />
                  </div>
                )}
              </div>

              <Link href='/agent' className={navLinkClass}>
                Shams
              </Link>

              <Link href='/integrations' className={navLinkClass}>
                Integrations
              </Link>

              <Link href='/pricing' className={navLinkClass}>
                Pricing
              </Link>

              {/* Resources */}
              <div className='relative' ref={resourcesDropdownRef}>
                <button
                  type='button'
                  className={navTriggerClass}
                  onClick={() => setIsResourcesDropdownOpen(!isResourcesDropdownOpen)}
                  aria-expanded={isResourcesDropdownOpen}
                >
                  Resources
                  <ChevronDown
                    className={`ml-1 h-3.5 w-3.5 transition-transform ${
                      isResourcesDropdownOpen ? 'rotate-180' : ''
                    }`}
                  />
                </button>
                {isResourcesDropdownOpen && (
                  <div className={dropdownClass + ' w-72'}>
                    <DropdownItem
                      href='/resources'
                      title='Technical Resources'
                      hint='Whitepapers, checklists & guides'
                      onClick={() => setIsResourcesDropdownOpen(false)}
                    />
                    <DropdownItem
                      href='/docs'
                      title='Documentation'
                      hint='Platform guides, onboarding & billing'
                      onClick={() => setIsResourcesDropdownOpen(false)}
                    />
                    <DropdownItem
                      href='/insights'
                      title='Insights'
                      hint='Warranty, soiling & PPA economics'
                      onClick={() => setIsResourcesDropdownOpen(false)}
                    />
                    <DropdownItem
                      href='/reports'
                      title='Data reports'
                      hint='Open benchmarks on public solar & battery data'
                      onClick={() => setIsResourcesDropdownOpen(false)}
                    />
                    <DropdownItem
                      href='/compare'
                      title='Compare platforms'
                      hint='NuraVolt vs sensors, vendors & alternatives'
                      onClick={() => setIsResourcesDropdownOpen(false)}
                    />
                    <DropdownItem
                      href='/about'
                      title='About'
                      hint='Who builds NuraVolt & why'
                      onClick={() => setIsResourcesDropdownOpen(false)}
                    />
                    <DropdownItem
                      href='/case-studies'
                      title='Case Studies'
                      hint='Real-world results & ROI'
                      onClick={() => setIsResourcesDropdownOpen(false)}
                    />
                    <DropdownItem
                      href='/roi-calculator'
                      title='ROI Calculator'
                      hint='Calculate your savings'
                      onClick={() => setIsResourcesDropdownOpen(false)}
                    />
                  </div>
                )}
              </div>

              <Link href='/blog' className={navLinkClass}>
                Blog
              </Link>

              <button
                type='button'
                onClick={() => setIsBookingModalOpen(true)}
                className={navLinkClass}
              >
                Contact
              </button>

              {isSignedIn ? (
                <Button size='sm' asChild>
                  <Link href='/dashboard'>
                    Dashboard
                    <ArrowRight className='w-3.5 h-3.5 ml-1.5 inline' />
                  </Link>
                </Button>
              ) : (
                <>
                  <Link href='/sign-in' className={navLinkClass}>
                    Log in
                  </Link>
                  <Button size='sm' variant='outline' asChild>
                    <Link href='/sign-up'>Sign up</Link>
                  </Button>
                  <Button size='sm' asChild>
                    <Link href={ctaHref}>
                      {ctaLabel}
                      <ArrowRight className='w-3.5 h-3.5 ml-1.5 inline' />
                    </Link>
                  </Button>
                </>
              )}
            </div>
          </div>
        </div>
      </nav>

      <BookingModal isOpen={isBookingModalOpen} onClose={() => setIsBookingModalOpen(false)} />
    </>
  );
}

const navLinkClass =
  'text-sm text-ink-2 hover:text-ink transition-colors font-medium';
const navTriggerClass =
  'flex items-center text-sm text-ink-2 hover:text-ink transition-colors font-medium';
const dropdownClass =
  'absolute top-full left-0 mt-2 bg-paper rounded-sm shadow-sm border border-divider py-1 z-50';

function DropdownItem({
  href,
  title,
  hint,
  onClick,
}: {
  href: string;
  title: string;
  hint: string;
  onClick: () => void;
}) {
  return (
    <Link
      href={href}
      className='block px-4 py-3 hover:bg-paper-2 transition-colors'
      onClick={onClick}
    >
      <div className='text-sm font-semibold text-ink'>{title}</div>
      <div className='text-meta text-ink-3 mt-0.5'>{hint}</div>
    </Link>
  );
}
