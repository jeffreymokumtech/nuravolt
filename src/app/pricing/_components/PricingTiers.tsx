'use client';

import { useState } from 'react';
import { Check } from 'lucide-react';
import { Button } from '@/components/ui/button';
import BookingModal from '@/components/landing/BookingModal';

// Placeholder prices — the billed amount is whatever the Stripe Price says;
// keep these in sync when final pricing is set in Stripe.
// Caps mirror BUSINESS_BANDS in src/lib/billing/plan.ts and are in equivalent
// MW: max(rated MW, storage MWh / 4) per plant.
const BUSINESS_BANDS = [
  { key: 'S', label: 'Up to 2 MW', price: '€99' },
  { key: 'M', label: 'Up to 8 MW', price: '€299' },
  { key: 'L', label: 'Up to 20 MW', price: '€599' },
  // XL: founder decision, not yet created in Stripe. Until
  // STRIPE_PRICE_BUSINESS_XL_MONTHLY exists the checkout link answers 503, so
  // confirm the price here and in Stripe together.
  { key: 'XL', label: 'Up to 60 MW', price: '€1,499' },
] as const;

type BandKey = (typeof BUSINESS_BANDS)[number]['key'];

/**
 * Asset-type toggle for the Business feature list. The platform sells two
 * different jobs to be done, and a storage buyer who never sees the words
 * battery or storage on this page leaves before the demo.
 */
const ASSET_VIEWS = [
  { key: 'pv', label: 'Solar PV' },
  { key: 'storage', label: 'Battery storage' },
] as const;

type AssetView = (typeof ASSET_VIEWS)[number]['key'];

const PV_FEATURES = [
  'Per-inverter soiling intelligence',
  'Cleaning schedule optimizer',
  'Fault detection and O&M ticketing',
];

const STORAGE_FEATURES = [
  'Warranty defense: cycling, temperature and state of health against your warranty terms',
  'Revenue assurance: dispatch and settlement reconciled against your contracts',
  'State of safety: cell voltage and temperature spread, insulation and alarms',
  'Availability assurance: availability and obligation evidence for your offtaker',
];

const RESIDENTIAL_PRICING = {
  month: { price: '€9', suffix: 'per month' },
  year: { price: '€90', suffix: 'per year · 2 months free' },
} as const;

export default function PricingTiers() {
  const [bookingOpen, setBookingOpen] = useState(false);
  const [band, setBand] = useState<BandKey>('S');
  const [interval, setInterval] = useState<'month' | 'year'>('month');
  const [assetView, setAssetView] = useState<AssetView>('pv');

  const selectedBand = BUSINESS_BANDS.find((b) => b.key === band)!;
  const assetFeatures = assetView === 'storage' ? STORAGE_FEATURES : PV_FEATURES;

  return (
    <>
      <div className="grid gap-6 lg:grid-cols-3 max-w-5xl mx-auto">
        {/* Residential */}
        <div className="rounded-2xl border border-gray-200 bg-white p-8 flex flex-col shadow-sm">
          <h3 className="text-lg font-semibold text-gray-900">Residential</h3>
          <div className="mt-2 flex items-baseline gap-1.5">
            <span className="text-4xl font-bold text-gray-900">
              {RESIDENTIAL_PRICING[interval].price}
            </span>
            <span className="text-sm text-gray-500">{RESIDENTIAL_PRICING[interval].suffix}</span>
          </div>
          <p className="mt-3 text-sm text-gray-600">
            One rooftop system up to 100 kW. Know when to clean, and what it costs you not to.
          </p>

          <div className="mt-4 grid grid-cols-2 gap-1.5" role="radiogroup" aria-label="Billing interval">
            {(['month', 'year'] as const).map((i) => (
              <button
                key={i}
                type="button"
                role="radio"
                aria-checked={interval === i}
                onClick={() => setInterval(i)}
                className={`rounded-lg border px-2 py-2 text-xs font-medium transition-colors ${
                  interval === i
                    ? 'border-gray-900 bg-gray-50 text-gray-900'
                    : 'border-gray-200 text-gray-600 hover:border-gray-300'
                }`}
              >
                {i === 'month' ? 'Monthly' : 'Yearly · save €18'}
              </button>
            ))}
          </div>

          <ul className="mt-5 space-y-2.5 text-sm text-gray-700 flex-1">
            {[
              '14-day free trial',
              '1 plant, up to 100 kW',
              'Power & soiling forecasts',
              'Cleaning reminders',
              'Production monitoring',
              'Mobile app · 1 seat',
            ].map((feature) => (
              <li key={feature} className="flex gap-2">
                <Check className="h-4 w-4 text-green-600 shrink-0 mt-0.5" />
                {feature}
              </li>
            ))}
          </ul>
          <Button asChild className="mt-8 w-full bg-gray-900 hover:bg-gray-800 text-white">
            <a href={`/api/checkout/residential?interval=${interval}`}>Start free trial</a>
          </Button>
          <p className="mt-2 text-center text-xs text-gray-500">
            Card required · cancel anytime during the trial
          </p>
        </div>

        {/* Business */}
        <div className="rounded-2xl border-amber-500 border bg-white p-8 flex flex-col shadow-lg ring-1 ring-amber-500/30">
          <span className="self-start mb-3 rounded-full bg-amber-100 text-amber-800 text-xs font-semibold px-3 py-1">
            Most popular
          </span>
          <h3 className="text-lg font-semibold text-gray-900">Business</h3>
          <div className="mt-2 flex items-baseline gap-1.5">
            <span className="text-4xl font-bold text-gray-900">{selectedBand.price}</span>
            <span className="text-sm text-gray-500">per month</span>
          </div>
          <p className="mt-3 text-sm text-gray-600">
            For operators running a fleet of solar or storage. Priced by capacity under
            management.
          </p>

          <div className="mt-4 grid grid-cols-2 gap-1.5" role="radiogroup" aria-label="Fleet size">
            {BUSINESS_BANDS.map((b) => (
              <button
                key={b.key}
                type="button"
                role="radio"
                aria-checked={band === b.key}
                onClick={() => setBand(b.key)}
                className={`rounded-lg border px-2 py-2 text-xs font-medium transition-colors ${
                  band === b.key
                    ? 'border-amber-500 bg-amber-50 text-amber-900'
                    : 'border-gray-200 text-gray-600 hover:border-gray-300'
                }`}
              >
                {b.label}
              </button>
            ))}
          </div>

          <div
            className="mt-2 grid grid-cols-2 gap-1.5"
            role="radiogroup"
            aria-label="Asset type"
          >
            {ASSET_VIEWS.map((v) => (
              <button
                key={v.key}
                type="button"
                role="radio"
                aria-checked={assetView === v.key}
                onClick={() => setAssetView(v.key)}
                className={`rounded-lg border px-2 py-2 text-xs font-medium transition-colors ${
                  assetView === v.key
                    ? 'border-gray-900 bg-gray-50 text-gray-900'
                    : 'border-gray-200 text-gray-600 hover:border-gray-300'
                }`}
              >
                {v.label}
              </button>
            ))}
          </div>

          <ul className="mt-5 space-y-2.5 text-sm text-gray-700 flex-1">
            {[
              'Shams AI agent included',
              `Fleet capacity ${selectedBand.label.toLowerCase()}`,
              ...assetFeatures,
              'AI insights on every plant',
              'MCP API keys for AI assistants',
              '10 seats, up to 25 plants',
            ].map((feature) => (
              <li key={feature} className="flex gap-2">
                <Check className="h-4 w-4 text-green-600 shrink-0 mt-0.5" />
                {feature}
              </li>
            ))}
          </ul>
          <p className="mt-4 text-xs text-gray-500">
            Fixed monthly price. Shams is included, with fair use limits instead of per
            token billing.
          </p>
          <Button asChild className="mt-4 w-full bg-amber-500 hover:bg-amber-600 text-gray-900">
            <a href={`/api/checkout/business?band=${band}`}>Upgrade to Business</a>
          </Button>
        </div>

        {/* Enterprise */}
        <div className="rounded-2xl border border-gray-200 bg-white p-8 flex flex-col shadow-sm">
          <h3 className="text-lg font-semibold text-gray-900">Enterprise</h3>
          <div className="mt-2 flex items-baseline gap-1.5">
            <span className="text-4xl font-bold text-gray-900">Custom</span>
          </div>
          <p className="mt-3 text-sm text-gray-600">
            Above 60 equivalent MW, or fleets that need SSO and user-level AI access.
          </p>
          <ul className="mt-6 space-y-2.5 text-sm text-gray-700 flex-1">
            {[
              'Unlimited capacity, plants and seats',
              'MCP OAuth connector (per-user access control)',
              'SSO',
              'Custom data integrations',
              'Priority support and onboarding',
            ].map((feature) => (
              <li key={feature} className="flex gap-2">
                <Check className="h-4 w-4 text-green-600 shrink-0 mt-0.5" />
                {feature}
              </li>
            ))}
          </ul>
          <Button
            className="mt-8 w-full bg-gray-900 hover:bg-gray-800 text-white"
            onClick={() => setBookingOpen(true)}
          >
            Talk to us
          </Button>
        </div>
      </div>

      <p className="text-center text-sm opacity-70 mt-8 max-w-2xl mx-auto">
        Prices exclude VAT. Plans are billed in EUR through Stripe and can be
        cancelled any time from billing settings. Capacity is the sum of your plants&apos;
        equivalent MW, where a plant&apos;s equivalent MW is the larger of its rated MW and
        its storage MWh divided by 4. Solar and wind plants have no storage MWh, so they
        count as their rated MW.
      </p>

      <BookingModal isOpen={bookingOpen} onClose={() => setBookingOpen(false)} />
    </>
  );
}
