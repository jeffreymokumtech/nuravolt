'use client';

import Link from 'next/link';
import NuraVoltLogo from '@/components/NuraVoltLogo';

export default function Footer() {
  return (
    <footer className='bg-data-bg text-data-fg'>
      <div className='container mx-auto px-4 sm:px-6 lg:px-8 py-14'>
        <div className='grid grid-cols-2 md:grid-cols-4 gap-8'>
          {/* Column 1: Logo & Tagline */}
          <div className='col-span-2 md:col-span-1'>
            <div className='mb-4'>
              <NuraVoltLogo width={160} height={40} showTagline={false} variant='dark' />
            </div>
            <p className='text-sm text-data-fg-2 mb-4'>
              Energy intelligence for solar &amp; storage
            </p>
            <a
              href='https://www.linkedin.com/company/nuravolt'
              target='_blank'
              rel='noopener noreferrer'
              className='inline-flex items-center text-data-fg-2 hover:text-data-fg transition-colors'
              aria-label='NuraVolt on LinkedIn'
            >
              <svg className='w-5 h-5' fill='currentColor' viewBox='0 0 24 24' aria-hidden='true'>
                <path d='M20.447 20.452h-3.554v-5.569c0-1.328-.027-3.037-1.852-3.037-1.853 0-2.136 1.445-2.136 2.939v5.667H9.351V9h3.414v1.561h.046c.477-.9 1.637-1.85 3.37-1.85 3.601 0 4.267 2.37 4.267 5.455v6.286zM5.337 7.433a2.062 2.062 0 01-2.063-2.065 2.064 2.064 0 112.063 2.065zm1.782 13.019H3.555V9h3.564v11.452zM22.225 0H1.771C.792 0 0 .774 0 1.729v20.542C0 23.227.792 24 1.771 24h20.451C23.2 24 24 23.227 24 22.271V1.729C24 .774 23.2 0 22.222 0h.003z' />
              </svg>
            </a>
          </div>

          <FooterColumn title='Solutions'>
            <FooterLink href='/solutions/bess-monitoring'>BESS Analytics</FooterLink>
            <FooterLink href='/solutions/pv-monitoring'>PV Monitoring</FooterLink>
            <FooterLink href='/solutions/wind-monitoring'>Wind Monitoring</FooterLink>
            <FooterLink href='/solutions/hydrogen-monitoring'>Hydrogen Analytics</FooterLink>
            <FooterLink href='/solar-monitoring'>Solar monitoring by country</FooterLink>
            <FooterLink href='/mcp'>MCP Server</FooterLink>
          </FooterColumn>

          <FooterColumn title='Resources'>
            <FooterLink href='/bess'>BESS metrics</FooterLink>
            <FooterLink href='/pv-metrics'>PV metrics</FooterLink>
            <FooterLink href='/faults'>Fault library</FooterLink>
            <FooterLink href='/integrations'>Integrations</FooterLink>
            <FooterLink href='/docs'>Documentation</FooterLink>
            <FooterLink href='/insights'>Insights</FooterLink>
            <FooterLink href='/reports'>Data reports</FooterLink>
            <FooterLink href='/compare'>Compare platforms</FooterLink>
            <FooterLink href='/blog'>Blog</FooterLink>
            <FooterLink href='/case-studies'>Case Studies</FooterLink>
          </FooterColumn>

          <FooterColumn title='Company'>
            <FooterAnchor target='contact'>Contact</FooterAnchor>
            <FooterLink href='/about'>About</FooterLink>
            <FooterLink href='/pricing'>Pricing</FooterLink>
            <FooterLink href='/engagements'>Professional services</FooterLink>
            <FooterLink href='/privacy-policy'>Privacy</FooterLink>
            <FooterLink href='/tos'>Terms</FooterLink>
          </FooterColumn>
        </div>
      </div>

      <div className='border-t border-data-rule'>
        <div className='container mx-auto px-4 sm:px-6 lg:px-8 py-5 flex flex-col sm:flex-row justify-between items-center gap-2'>
          <p className='font-mono text-meta uppercase tracking-[0.08em] text-data-fg-2'>
            &copy; {new Date().getFullYear()} NuraVolt. All rights reserved.
          </p>
          <p className='font-mono text-meta uppercase tracking-[0.08em] text-data-fg-2'>
            Available across EMEA
          </p>
        </div>
      </div>
    </footer>
  );
}

function FooterColumn({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <h4 className='font-mono text-meta uppercase tracking-[0.08em] text-data-fg mb-4'>
        {title}
      </h4>
      <ul className='space-y-2 text-sm'>{children}</ul>
    </div>
  );
}

function FooterLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <li>
      <Link href={href} className='text-data-fg-2 hover:text-data-fg transition-colors'>
        {children}
      </Link>
    </li>
  );
}

function FooterAnchor({
  target,
  children,
}: {
  target: string;
  children: React.ReactNode;
}) {
  return (
    <li>
      <a
        href={`#${target}`}
        className='text-data-fg-2 hover:text-data-fg transition-colors'
        onClick={(e) => {
          e.preventDefault();
          document.getElementById(target)?.scrollIntoView({ behavior: 'smooth' });
        }}
      >
        {children}
      </a>
    </li>
  );
}
