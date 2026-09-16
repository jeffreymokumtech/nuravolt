'use client';

import { Fragment, useState } from 'react';
import { Check, Minus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import BookingModal from '@/components/landing/BookingModal';

type Cell = boolean | string;

const TIERS = [
  { name: 'Residential', price: '€9/mo · €90/yr' },
  { name: 'Business', price: 'from €99/mo', highlight: true },
  { name: 'Enterprise', price: 'Custom' },
] as const;

interface Row {
  label: string;
  cells: [Cell, Cell, Cell];
}

const GROUPS: { title: string; rows: Row[] }[] = [
  {
    title: 'Monitoring & forecasts',
    rows: [
      { label: 'Production monitoring (live KPIs)', cells: [true, true, true] },
      { label: '7-day power forecast', cells: [true, true, true] },
      { label: 'Plant-level soiling forecast', cells: [true, true, true] },
      { label: 'Cleaning reminders', cells: [true, true, true] },
    ],
  },
  {
    title: 'Analytics & intelligence',
    rows: [
      { label: 'Per-inverter soiling intelligence', cells: [false, true, true] },
      { label: 'Cleaning schedule optimizer', cells: [false, true, true] },
      { label: 'Fault detection (thermal RUL)', cells: [false, true, true] },
      { label: 'Battery / BESS analytics', cells: [false, true, true] },
      { label: 'Wind analytics (wake, power curve, RUL)', cells: [false, true, true] },
      { label: 'Green hydrogen analytics (electrolyzer)', cells: [false, true, true] },
    ],
  },
  {
    title: 'AI & reporting',
    rows: [
      { label: 'AI insights (automatic explanations)', cells: [false, true, true] },
      { label: 'Shams AI agent (chat, drafts tickets and plans)', cells: [false, true, true] },
      { label: 'Custom report builder', cells: [false, true, true] },
      { label: 'O&M ticketing & export', cells: [false, true, true] },
    ],
  },
  {
    title: 'Integrations & scale',
    rows: [
      { label: 'MCP API keys (connect AI assistants)', cells: [false, true, true] },
      { label: 'MCP OAuth connector (per-user access)', cells: [false, false, true] },
      { label: 'Single sign-on (SSO)', cells: [false, false, true] },
      { label: 'Custom data integrations', cells: [false, false, true] },
      { label: 'Priority support & onboarding', cells: [false, false, true] },
    ],
  },
  {
    title: 'Limits',
    rows: [
      { label: 'Capacity under management', cells: ['100 kW', 'Up to 20 MW', 'Unlimited'] },
      { label: 'Plants', cells: ['1', '25', 'Unlimited'] },
      { label: 'Team seats', cells: ['1', '10', 'Unlimited'] },
    ],
  },
];

function CellValue({ value }: { value: Cell }) {
  if (typeof value === 'string') {
    return <span className="text-sm font-medium text-gray-900">{value}</span>;
  }
  return value ? (
    <Check className="mx-auto h-5 w-5 text-green-600" aria-label="Included" />
  ) : (
    <Minus className="mx-auto h-4 w-4 text-gray-300" aria-label="Not included" />
  );
}

export default function FeatureComparison() {
  const [bookingOpen, setBookingOpen] = useState(false);

  const colHighlight = (i: number) => (i === 1 ? 'bg-amber-50/70' : '');

  return (
    <div className="max-w-5xl mx-auto">
      <div className="max-w-2xl mb-8">
        <h2 className="text-2xl font-bold tracking-tight text-gray-900">Compare every feature</h2>
        <p className="mt-2 text-gray-600">
          Residential covers monitoring and forecasts for a single rooftop. Business unlocks the
          full intelligence stack with the Shams AI agent included at a fixed price. Enterprise
          adds unlimited scale, SSO and per-user AI access.
        </p>
      </div>

      <div className="overflow-x-auto rounded-2xl border border-gray-200 bg-white shadow-sm">
        <table className="w-full min-w-[720px] border-collapse text-left">
          <thead>
            <tr className="border-b border-gray-200">
              <th className="p-4 text-sm font-semibold text-gray-900 align-bottom">Features</th>
              {TIERS.map((tier, i) => (
                <th
                  key={tier.name}
                  className={`p-4 text-center align-bottom ${colHighlight(i)} ${
                    tier.highlight ? 'border-x border-amber-200' : ''
                  }`}
                >
                  {tier.highlight && (
                    <span className="inline-block mb-1 rounded-full bg-amber-100 text-amber-800 text-[11px] font-semibold px-2 py-0.5">
                      Most popular
                    </span>
                  )}
                  <div className="text-base font-semibold text-gray-900">{tier.name}</div>
                  <div className="text-xs text-gray-500">{tier.price}</div>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {GROUPS.map((group) => (
              <Fragment key={group.title}>
                <tr className="bg-gray-50">
                  <td
                    colSpan={4}
                    className="px-4 py-2 text-xs font-semibold uppercase tracking-wide text-gray-500"
                  >
                    {group.title}
                  </td>
                </tr>
                {group.rows.map((row) => (
                  <tr key={row.label} className="border-b border-gray-100 last:border-0">
                    <td className="p-4 text-sm text-gray-700">{row.label}</td>
                    {row.cells.map((cell, i) => (
                      <td
                        key={i}
                        className={`p-4 text-center ${colHighlight(i)} ${
                          i === 1 ? 'border-x border-amber-200/60' : ''
                        }`}
                      >
                        <CellValue value={cell} />
                      </td>
                    ))}
                  </tr>
                ))}
              </Fragment>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <td className="p-4" />
              <td className="p-4 text-center align-top">
                <Button asChild className="w-full bg-gray-900 hover:bg-gray-800 text-white">
                  <a href="/api/checkout/residential?interval=month">Start free trial</a>
                </Button>
              </td>
              <td className="p-4 text-center align-top bg-amber-50/70 border-x border-amber-200">
                <Button asChild className="w-full bg-amber-500 hover:bg-amber-600 text-gray-900">
                  <a href="/api/checkout/business?band=S">Choose Business</a>
                </Button>
              </td>
              <td className="p-4 text-center align-top">
                <Button
                  className="w-full bg-gray-900 hover:bg-gray-800 text-white"
                  onClick={() => setBookingOpen(true)}
                >
                  Talk to us
                </Button>
              </td>
            </tr>
          </tfoot>
        </table>
      </div>

      <BookingModal isOpen={bookingOpen} onClose={() => setBookingOpen(false)} />
    </div>
  );
}
