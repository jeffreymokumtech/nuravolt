'use client';

import { useRef } from 'react';
import { motion, useInView } from 'framer-motion';
import { Button } from '@/components/ui/button';
import Link from 'next/link';
import {
  Activity,
  ArrowRight,
  Check,
  ChevronRight,
  LineChart,
  Network,
  ShieldCheck,
  TrendingUp,
  Users,
} from 'lucide-react';
import AuditLeadForm from '@/components/landing/AuditLeadForm';
import { HairlineRule } from '@/components/ui/HairlineRule';
import { MarketingSection } from '@/components/ui/MarketingSection';

import { goToLeadForm, type LeadIntent } from '@/components/landing/leadFormIntent';

const PORTFOLIO_MAILTO =
  'mailto:contact@nuravolt.com?subject=Portfolio%20Diagnostic&body=Hi%20Jeffrey%2C%0A%0AWe%27d%20like%20to%20scope%20a%20Portfolio%20Diagnostic%20for%3A%0A%0ANumber%20of%20plants%3A%20%0ATotal%20capacity%20%28MW%29%3A%20%0ACountries%2Fregions%3A%20%0AAsset%20mix%20%28PV%2FBESS%2Fwind%29%3A%20';

const FORECASTING_MAILTO =
  'mailto:contact@nuravolt.com?subject=Power%20Forecasting%20for%20Trading&body=Hi%20Jeffrey%2C%0A%0AWe%27d%20like%20to%20scope%20a%20power%20forecasting%20engagement%3A%0A%0ANumber%20of%20plants%3A%20%0ATotal%20capacity%20%28MW%29%3A%20%0AMarket%20%28EPEX%2FNord%20Pool%2FIberian%2FAdmie%2Fother%29%3A%20%0ATrading%20setup%20%28own%20desk%2FBRP%2Faggregator%29%3A%20';

const COMPLIANCE_MAILTO =
  'mailto:contact@nuravolt.com?subject=Compliance%20%26%20Reporting%20Pack&body=Hi%20Jeffrey%2C%0A%0AWe%27d%20like%20to%20discuss%20a%20Compliance%20%26%20Reporting%20Pack%3A%0A%0APlant%28s%29%3A%20%0AApplicable%20regulations%20%28CSRD%2FAI%20Act%2FEU%20Battery%2Fother%29%3A%20%0AReporting%20cadence%20needed%3A%20';

interface Tier {
  id: string;
  badge?: string;
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  duration: string;
  tagline: string;
  bullets: string[];
  creditBack?: string;
  ctaLabel: string;
  ctaIntent?: LeadIntent;
  ctaHref?: string;
  highlighted?: boolean;
}

const TIERS: Tier[] = [
  {
    id: 'monitoring',
    badge: 'Most common path',
    icon: Activity,
    title: 'Continuous monitoring',
    duration: 'Ongoing subscription',
    tagline:
      'Live SoH, soiling, fault, and revenue tracking on your operational data, every day.',
    bullets: [
      'Live ingestion from SCADA, inverter clouds, BMS, or CSV exports',
      'Daily soiling ratio, fault sweep, SoH trajectory, revenue-at-risk',
      'Alerting + ticketing with revenue-weighted prioritisation',
      'CSRD ESRS E1, EU AI Act, EU Battery Regulation evidence baked in',
      'No annual lock-in. Pricing scoped to plant or portfolio',
    ],
    creditBack:
      'Subscription pricing is scoped to your portfolio. Most operators start here. If you\'d rather prove the value with a fixed-scope diagnostic first, see the Plant Performance Audit below.',
    ctaLabel: 'Start continuous monitoring',
    ctaIntent: 'monitoring',
    highlighted: true,
  },
  {
    id: 'audit',
    icon: LineChart,
    title: 'Plant Performance Audit',
    duration: '2-3 weeks',
    tagline:
      'Find out what your SCADA data is hiding, without committing to a subscription.',
    bullets: [
      'SCADA data ingestion + anomaly sweep',
      'Revenue-weighted availability analysis (not just uptime %)',
      'Top-5 findings with € impact',
      '90-minute findings call + PDF report for the board',
      'Typically surfaces 2-5% of recoverable annual revenue',
    ],
    creditBack:
      'Credit-back: sign a 12-month platform subscription within 60 days and the audit fee credits in full against your first invoice.',
    ctaLabel: 'Request audit scoping',
    ctaIntent: 'audit',
  },
  {
    id: 'foundation',
    icon: Network,
    title: 'Data Foundation',
    duration: '2-3 weeks',
    tagline:
      'Read-side data layer for plants under ~20 MW or with no usable SCADA. Standalone, not a setup step.',
    bullets: [
      'Read-side ingestion: SCADA, Modbus TCP/RTU, OPC UA, inverter clouds (Huawei/SMA/Sungrow/Fronius/SolarEdge), MQTT, InfluxDB, CSV',
      'Register mapping + unit validation (catches scaling bugs before ML does)',
      'Normalized, timestamped, queryable. Documented schema + API access',
      'Handover documentation + read-only dashboards',
      'Use it standalone, or layer NuraVolt monitoring on top later',
    ],
    creditBack:
      'Scope depends on plant complexity. Modern plants with standard Modbus TCP or inverter-cloud APIs are quickest; legacy SCADA, multi-protocol sites, or on-prem installations need more setup time. Fixed quote after a 30-minute scoping call.',
    ctaLabel: 'Talk to us about Data Foundation',
    ctaIntent: 'foundation',
  },
  {
    id: 'portfolio',
    icon: Users,
    title: 'Portfolio Diagnostic',
    duration: '4-6 weeks',
    tagline:
      'The multi-plant version of the Audit, for asset managers and IPPs with fleets.',
    bullets: [
      'Sized for 5-20 plants, bundled to keep per-asset effort efficient',
      'Cross-plant benchmarking (availability, PR, soiling, MTBF)',
      'Portfolio loss attribution: which plants are dragging the fleet?',
      'Per-asset and portfolio-level board-ready report',
      'Same credit-back mechanic against a portfolio platform subscription',
    ],
    ctaLabel: 'Scope a portfolio engagement',
    ctaHref: PORTFOLIO_MAILTO,
  },
  {
    id: 'forecasting',
    badge: 'Trading desks',
    icon: TrendingUp,
    title: 'Power Forecasting for Trading',
    duration: 'Ongoing retainer',
    tagline:
      'Day-ahead and intraday power forecasts for merchant sellers, BRPs, and aggregators.',
    bullets: [
      'Day-ahead forecasts in time for gate closure (EPEX/Nord Pool/Iberian/Admie/etc.)',
      'Intraday updates every 15 min with ensemble confidence bands',
      'Physics-informed ML: digital twin + NWP + real-time irradiance',
      'MAE/MAPE SLA tied to your trading window',
      'Delivered via API (JSON/CSV), Kafka, or native EMS/SCADA push',
      'Fleet retainers for 10+ plants; bespoke for balancing-responsible parties',
    ],
    creditBack:
      'For traders with own desks, BRPs, VPP aggregators, and merchant IPPs. We tune the forecast to your trading gate windows, not generic D+1 delivery.',
    ctaLabel: 'Scope a forecasting engagement',
    ctaHref: FORECASTING_MAILTO,
  },
  {
    id: 'compliance',
    badge: 'Annual retainer',
    icon: ShieldCheck,
    title: 'Compliance & Reporting Pack',
    duration: 'Ongoing',
    tagline: 'Regulator-ready documentation generated from your live plant data.',
    bullets: [
      'ESRS E1 data pack (energy E1-5 + GHG E1-6) mapped to CSRD',
      'AI Act model cards for every forecasting/dispatch/fault-detection model',
      'EU Battery Regulation passport data feed for BESS ≥ 2 kWh (mandatory Feb 2027)',
      'Quarterly auditor pack + tamper-evident fault attribution log',
      'Typically layered on top of the platform subscription',
    ],
    ctaLabel: 'Discuss compliance scope',
    ctaHref: COMPLIANCE_MAILTO,
  },
];

interface FlowEntry {
  title: string;
  subtitle: string;
}

const FLOW_ENTRIES: FlowEntry[] = [
  { title: 'Continuous monitoring', subtitle: 'Subscription · most common' },
  { title: 'Plant Performance Audit', subtitle: 'Fixed-scope · diagnostic' },
  { title: 'Data Foundation', subtitle: 'Read-side · smaller plants' },
];

const FLOW_DESTINATION: FlowEntry = {
  title: 'Platform + Compliance',
  subtitle: 'Live evidence + CSRD / AI Act / Battery Reg',
};

const FAQS = [
  {
    q: 'Do I need an audit to start monitoring?',
    a: "No. Continuous monitoring is the default path for most operators. You plug us into your live data and we run soiling, fault, SoH, and revenue tracking from day one. The Plant Performance Audit is the option if you want a fixed-scope diagnostic with a credit-back mechanic before committing to a subscription, it's still available, it just isn't required.",
  },
  {
    q: 'What if I just need data integration without analytics?',
    a: "That's exactly what the Data Foundation engagement is for. We set up read-side ingestion (Modbus TCP, OPC UA, inverter clouds, MQTT, CSV, InfluxDB), register mapping, unit validation, and a normalized timeseries you can query yourself. Standalone, fixed quote. No platform subscription required. Most useful for plants under ~20 MW or sites where the existing SCADA can't give you clean data.",
  },
  {
    q: 'What happens in the 2-3 weeks of the audit?',
    a: 'Week 1: we ingest your SCADA / inverter-cloud / time-series data and run a sanity pass (scaling, units, gaps, timezone). Week 2: anomaly sweep against the physics-informed digital twin, revenue-weighted availability analysis, and loss disaggregation. Week 3: we write the report and schedule a 90-minute findings call with your team. You get a PDF you can forward to your board.',
  },
  {
    q: 'What data access do you need from us?',
    a: 'Ideally: historical SCADA or inverter-cloud data (minimum 6 months for the audit; from day one for monitoring), plant nameplate spec (capacity, inverter model, tracker config), and a weather reference (we can substitute Open-Meteo / CAMS if none). We sign an NDA first, and no data leaves our infrastructure for anything other than this engagement unless you explicitly agree.',
  },
  {
    q: 'How does the audit credit-back work mechanically?',
    a: "You pay the agreed audit fee up front via invoice. If you sign a 12-month platform subscription within 60 days of the audit report delivery date, the full audit fee is deducted as a one-off credit against your first platform invoice. No expiry tricks. If you don't continue, you keep the report and there's nothing further to pay.",
  },
  {
    q: 'Can we do the audit without committing to the platform?',
    a: "Yes. That is the default expectation for the audit path. Around 50-60% of audit clients continue onto the platform; the rest take the report and either run the findings through their existing tooling or hand it to a TA consultant. Either way is fine, we don't lock the deliverable behind a subscription.",
  },
];

export default function EngagementsPage() {
  const heroRef = useRef(null);
  const heroInView = useInView(heroRef, { once: true });

  return (
    <>
      {/* Hero, paper, hairline-bordered */}
      <MarketingSection size='hero' as='div'>
        <motion.div
          ref={heroRef}
          className='max-w-4xl'
          initial={{ opacity: 0, y: 20 }}
          animate={heroInView ? { opacity: 1, y: 0 } : { opacity: 0, y: 20 }}
          transition={{ duration: 0.6 }}
        >
          <div className='font-mono text-meta uppercase tracking-[0.08em] text-ink-3 mb-3'>
            Engagements · three primary paths
          </div>
          <h1 className='text-h1 sm:text-display font-semibold text-ink mb-6'>
            Three ways to engage NuraVolt.
          </h1>
          <p className='text-body text-ink-2 max-w-2xl mb-8'>
            <strong className='font-semibold text-ink'>Continuous monitoring</strong>{' '}
            for operators who want live SoH, soiling, and fault tracking on day
            one. A fixed-scope{' '}
            <strong className='font-semibold text-ink'>Plant Performance Audit</strong>{' '}
            for buyers who want a one-off diagnostic first (credit-back if you
            continue).{' '}
            <strong className='font-semibold text-ink'>Data Foundation</strong>{' '}
            for smaller plants and SCADA-replacement read-side engagements.
            Portfolio Diagnostic, Power Forecasting, and Compliance Pack run
            alongside as needed.
          </p>
          <div className='flex flex-col sm:flex-row gap-3'>
            <Button size='lg' onClick={() => goToLeadForm('monitoring')}>
              Start continuous monitoring
              <ArrowRight className='w-4 h-4 ml-2' />
            </Button>
            <Button size='lg' variant='outline' asChild>
              <Link href='/showcase'>See the platform live</Link>
            </Button>
          </div>
        </motion.div>
      </MarketingSection>

      <HairlineRule />

      {/* Tiers, hairline-divided list, not bordered cards */}
      <MarketingSection size='default'>
        <div className='max-w-6xl mx-auto'>
          <div className='font-mono text-meta uppercase tracking-[0.08em] text-ink-3 mb-3'>
            Engagement tiers
          </div>
          <h2 className='text-h1 font-semibold text-ink mb-10'>
            Three primary paths, three optional add-ons
          </h2>

          <div className='border-t border-divider'>
            {TIERS.map((tier, i) => (
              <motion.div
                key={tier.id}
                id={tier.id}
                initial={{ opacity: 0, y: 12 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true }}
                transition={{ delay: i * 0.06 }}
                className={`border-b border-divider py-10 ${
                  tier.highlighted ? 'bg-paper-2' : ''
                }`}
              >
                <div className='grid grid-cols-1 lg:grid-cols-12 gap-x-8 gap-y-6'>
                  {/* Left rail, icon + headline + duration + tagline */}
                  <div className='lg:col-span-4'>
                    <div className='flex items-center gap-3 mb-4'>
                      <tier.icon className='w-5 h-5 text-ink-3' />
                      {tier.badge && (
                        <span className='font-mono text-meta uppercase tracking-[0.08em] text-primary'>
                          {tier.badge}
                        </span>
                      )}
                    </div>
                    <h3 className='text-h2 font-semibold text-ink mb-3'>
                      {tier.title}
                    </h3>
                    <div className='font-mono text-meta uppercase tracking-[0.08em] text-ink-3 mb-4'>
                      Duration · {tier.duration}
                    </div>
                    <p className='text-body text-ink-2'>{tier.tagline}</p>
                  </div>

                  {/* Right rail, bullets + creditBack + CTA */}
                  <div className='lg:col-span-8'>
                    <ul className='space-y-3 mb-5'>
                      {tier.bullets.map((b) => (
                        <li key={b} className='flex items-start gap-3'>
                          <Check className='w-4 h-4 text-signal-positive flex-shrink-0 mt-1' />
                          <span className='text-body text-ink-2'>{b}</span>
                        </li>
                      ))}
                    </ul>
                    {tier.creditBack && (
                      <div className='border-l-2 border-primary pl-4 mb-6'>
                        <p className='text-body text-ink-2'>{tier.creditBack}</p>
                      </div>
                    )}
                    {tier.ctaIntent ? (
                      <Button
                        size='lg'
                        variant={tier.highlighted ? 'default' : 'outline'}
                        onClick={() => goToLeadForm(tier.ctaIntent!)}
                      >
                        {tier.ctaLabel}
                        <ArrowRight className='w-4 h-4 ml-2' />
                      </Button>
                    ) : (
                      <Button
                        size='lg'
                        variant={tier.highlighted ? 'default' : 'outline'}
                        asChild
                      >
                        <a href={tier.ctaHref}>
                          {tier.ctaLabel}
                          <ArrowRight className='w-4 h-4 ml-2' />
                        </a>
                      </Button>
                    )}
                  </div>
                </div>
              </motion.div>
            ))}
          </div>
        </div>
      </MarketingSection>

      <HairlineRule />

      {/* Flow, three entry points → platform + compliance */}
      <MarketingSection size='default' surface='paper-2'>
        <div className='max-w-5xl mx-auto'>
          <div className='font-mono text-meta uppercase tracking-[0.08em] text-ink-3 mb-3'>
            How these fit together
          </div>
          <h2 className='text-h2 font-semibold text-ink mb-4'>
            Three entry points · one platform + compliance layer
          </h2>
          <p className='text-body text-ink-2 max-w-3xl mb-10'>
            Most operators start with continuous monitoring. Some prefer a
            fixed-scope audit first, then convert (audit fee credits back
            against the platform). Smaller plants and SCADA-replacement
            engagements start at the Data Foundation. All three converge on
            the same platform and compliance layer. Portfolio Diagnostic and
            Power Forecasting run alongside as standalone retainers.
          </p>

          <div className='grid grid-cols-1 md:grid-cols-[1fr_auto_1fr] gap-6 md:gap-4 items-center'>
            <div className='space-y-3'>
              {FLOW_ENTRIES.map((step, idx) => (
                <div
                  key={step.title}
                  className='border border-divider rounded-sm p-4 bg-paper'
                >
                  <div className='font-mono text-meta uppercase tracking-[0.08em] text-ink-3 mb-1'>
                    Entry · 0{idx + 1}
                  </div>
                  <div className='font-semibold text-ink mb-0.5'>{step.title}</div>
                  <div className='font-mono text-meta uppercase tracking-[0.08em] text-ink-3'>
                    {step.subtitle}
                  </div>
                </div>
              ))}
            </div>

            <div className='hidden md:flex flex-col items-center justify-center text-ink-3'>
              <ChevronRight className='w-6 h-6' />
            </div>
            <div className='flex md:hidden justify-center text-ink-3'>
              <ChevronRight className='w-6 h-6 rotate-90' />
            </div>

            <div className='border border-data-rule rounded-sm p-5 bg-data-bg text-data-fg'>
              <div className='font-mono text-meta uppercase tracking-[0.08em] text-data-fg-2 mb-2'>
                Destination
              </div>
              <div className='font-semibold text-data-fg mb-1'>
                {FLOW_DESTINATION.title}
              </div>
              <div className='font-mono text-meta uppercase tracking-[0.08em] text-data-fg-2'>
                {FLOW_DESTINATION.subtitle}
              </div>
            </div>
          </div>
        </div>
      </MarketingSection>

      <HairlineRule />

      {/* Founder credential strip */}
      <MarketingSection size='default'>
        <div className='max-w-4xl mx-auto'>
          <div className='border-t border-b border-divider py-8 grid grid-cols-1 sm:grid-cols-[80px_1fr] gap-6 items-start'>
            <div className='w-16 h-16 rounded-sm bg-data-bg text-data-fg flex items-center justify-center font-mono text-xl font-semibold border border-data-rule'>
              JdJ
            </div>
            <div>
              <div className='font-mono text-meta uppercase tracking-[0.08em] text-ink-3 mb-2'>
                Built by
              </div>
              <h3 className='text-h2 font-semibold text-ink mb-2'>
                Jeffrey de Jong
              </h3>
              <p className='text-body text-ink-2 mb-3'>
                MSc Economics &amp; Statistics (Utrecht University) · former ML
                engineer at one of Germany&apos;s largest utility-scale solar
                developers. 8+ years shipping data &amp; ML engineering for
                utility-scale solar, BESS, and wind.
              </p>
              <Link
                href='/about'
                className='inline-flex items-center gap-1 font-mono text-meta uppercase tracking-[0.08em] text-primary hover:underline'
              >
                More about the team
                <ArrowRight className='w-3 h-3' />
              </Link>
            </div>
          </div>
        </div>
      </MarketingSection>

      <HairlineRule />

      {/* FAQ */}
      <MarketingSection size='default' surface='paper-2'>
        <div className='max-w-3xl mx-auto'>
          <div className='font-mono text-meta uppercase tracking-[0.08em] text-ink-3 mb-3'>
            FAQ
          </div>
          <h2 className='text-h1 font-semibold text-ink mb-8'>
            Frequently asked
          </h2>
          <div className='border-t border-divider'>
            {FAQS.map((f) => (
              <details key={f.q} className='border-b border-divider group'>
                <summary className='cursor-pointer list-none flex justify-between items-start py-5 hover:bg-paper transition-colors'>
                  <span className='font-semibold text-ink pr-4'>{f.q}</span>
                  <ChevronRight className='w-4 h-4 text-ink-3 group-open:rotate-90 transition-transform mt-1 flex-shrink-0' />
                </summary>
                <p className='text-body text-ink-2 pb-5 pr-8 max-w-3xl'>{f.a}</p>
              </details>
            ))}
          </div>
        </div>
      </MarketingSection>

      <HairlineRule />

      {/* Lead form */}
      <MarketingSection size='default'>
        <div className='max-w-3xl mx-auto mb-10'>
          <div className='font-mono text-meta uppercase tracking-[0.08em] text-ink-3 mb-3'>
            Start here · pick your intent above
          </div>
          <h2 className='text-h1 font-semibold text-ink mb-3'>
            Continuous monitoring, a one-off audit, or a Data Foundation engagement.
          </h2>
          <p className='text-body text-ink-2'>
            Tell us about your plant and we&apos;ll reply within 24 hours.
            Switch intent at the top of the form to flip the scoping path.
          </p>
        </div>
        <AuditLeadForm
          source='engagements_page'
          variant='embedded'
          defaultIntent='monitoring'
        />
      </MarketingSection>
    </>
  );
}
