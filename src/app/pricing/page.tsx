import Link from 'next/link';
import { MarketingSection } from '@/components/ui/MarketingSection';
import { HairlineRule } from '@/components/ui/HairlineRule';
import SchemaJsonLd from '@/components/SchemaJsonLd';
import { getSEOTags, buildBreadcrumbSchema } from '@/libs/seo';
import PricingTiers from './_components/PricingTiers';
import FeatureComparison from './_components/FeatureComparison';

export const metadata = getSEOTags({
  title: 'Pricing, NuraVolt Platform Plans',
  description:
    'Simple plans for solar performance intelligence. Residential from €9/month with a 14-day free trial, Business with capacity-based pricing, or Enterprise with SSO and the MCP OAuth connector.',
  canonicalUrlRelative: '/pricing',
  keywords: [
    'solar monitoring pricing',
    'PV analytics pricing',
    'soiling forecast software cost',
    'solar SaaS plans',
    'NuraVolt pricing',
  ],
});

export default function PricingPage() {
  return (
    <main>
      <SchemaJsonLd
        data={[
          buildBreadcrumbSchema([
            { name: 'Home', urlRelative: '/' },
            { name: 'Pricing', urlRelative: '/pricing' },
          ]),
        ]}
      />

      <MarketingSection size="hero" surface="paper">
        <div className="max-w-3xl">
          <p className="text-sm font-semibold uppercase tracking-wide text-amber-600 mb-3">
            Pricing
          </p>
          <h1 className="text-4xl md:text-5xl font-bold tracking-tight mb-4">
            Plans that scale with your fleet
          </h1>
          <p className="text-lg opacity-80">
            Start with a 14-day free trial for a single rooftop. Business is priced by
            the capacity you manage, in three simple bands. No annual lock-in.
          </p>
        </div>
      </MarketingSection>

      <HairlineRule />

      <MarketingSection surface="paper-2">
        <PricingTiers />
      </MarketingSection>

      <HairlineRule />

      <MarketingSection surface="paper" id="compare">
        <FeatureComparison />
      </MarketingSection>

      <HairlineRule />

      <MarketingSection surface="paper" size="compact">
        <div className="max-w-3xl">
          <h2 className="text-xl font-semibold mb-2">Looking for a fixed-scope engagement?</h2>
          <p className="opacity-80">
            Audits, portfolio diagnostics and the Data Foundation service are priced per
            engagement, separate from platform plans.{' '}
            <Link href="/engagements" className="underline font-medium">
              See professional services
            </Link>
            .
          </p>
        </div>
      </MarketingSection>
    </main>
  );
}
