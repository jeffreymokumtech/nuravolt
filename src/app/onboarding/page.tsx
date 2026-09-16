'use client';

import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import NuraVoltLogo from '@/components/NuraVoltLogo';
import { Check } from 'lucide-react';

const TIERS = [
  {
    name: 'Residential',
    price: '€9/mo',
    blurb: 'One rooftop system up to 100 kW. 14-day free trial.',
    features: ['1 plant', 'Soiling forecast', 'Cleaning reminders', 'Power forecast', 'Mobile app'],
    cta: { label: 'Start 14-day trial', href: '/api/checkout/residential?interval=month' },
    highlight: false,
  },
  {
    name: 'Business',
    price: 'From €99/mo',
    blurb: 'For operators running a fleet, priced by MW under management.',
    features: ['Capacity bands up to 20 MW', 'Per-inverter soiling', 'O&M ticketing', 'AI copilot', 'MCP API keys', '10 seats'],
    cta: { label: 'Upgrade to Business', href: '/pricing' },
    highlight: true,
  },
  {
    name: 'Enterprise',
    price: 'Custom',
    blurb: 'Above 20 MW, with SSO and MCP OAuth.',
    features: ['Unlimited capacity', 'SSO', 'MCP OAuth connector', 'Priority support'],
    cta: { label: 'Talk to us', href: '/contact' },
    highlight: false,
  },
];

export default function OnboardingPage() {
  return (
    <div className="min-h-screen bg-gray-50 flex flex-col items-center justify-center py-12 px-4">
      <div className="mb-8">
        <NuraVoltLogo width={220} height={55} showTagline={false} />
      </div>

      <div className="text-center mb-8">
        <h1 className="text-2xl font-bold text-gray-900">Pick a plan</h1>
        <p className="text-gray-600 mt-1">You can change this at any time from billing settings.</p>
        <Link href="/dashboard" className="mt-2 inline-block text-sm text-blue-600 hover:underline">
          ← Back to dashboard
        </Link>
      </div>

      <div className="grid gap-6 md:grid-cols-3 w-full max-w-4xl">
        {TIERS.map((tier) => (
          <Card
            key={tier.name}
            className={`bg-white flex flex-col ${
              tier.highlight ? 'border-blue-600 border-2 shadow-lg' : 'border shadow-sm'
            }`}
          >
            <CardHeader>
              <CardTitle className="text-lg">{tier.name}</CardTitle>
              <p className="text-2xl font-bold text-gray-900">{tier.price}</p>
              <CardDescription>{tier.blurb}</CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col flex-1">
              <ul className="space-y-2 text-sm text-gray-700 flex-1">
                {tier.features.map((f) => (
                  <li key={f} className="flex items-center gap-2">
                    <Check className="h-4 w-4 text-green-600 shrink-0" />
                    {f}
                  </li>
                ))}
              </ul>
              <Button
                asChild
                className={`mt-6 w-full ${
                  tier.highlight
                    ? 'bg-blue-600 hover:bg-blue-700 text-white'
                    : 'bg-gray-900 hover:bg-gray-800 text-white'
                }`}
              >
                {/* API-route CTAs (checkout) need a full navigation, not a client-side Link. */}
                {tier.cta.href.startsWith('/api/') ? (
                  <a href={tier.cta.href}>{tier.cta.label}</a>
                ) : (
                  <Link href={tier.cta.href}>{tier.cta.label}</Link>
                )}
              </Button>
            </CardContent>
          </Card>
        ))}
      </div>

      <Link href="/dashboard" className="mt-8 text-sm text-gray-500 hover:text-gray-700">
        Skip for now and go to the dashboard
      </Link>
    </div>
  );
}
