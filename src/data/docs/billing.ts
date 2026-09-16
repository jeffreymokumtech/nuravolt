import type { DocArticle } from './types';

/**
 * Docs category: billing.
 *
 * Mirrors src/lib/billing/plan.ts (PLAN_LIMITS, BUSINESS_BANDS); update both
 * together when pricing changes.
 */

const PUBLISHED = '2026-07-05';

export const billingArticles: DocArticle[] = [
  {
    category: 'billing',
    slug: 'plans-and-capacity',
    title: 'Plans and capacity',
    intro: 'How the Residential, Business and Enterprise tiers are boxed by capacity under management.',
    quickAnswer:
      'NuraVolt is priced by the capacity you manage, measured in equivalent MW: for each plant, the larger of its rated MW and its storage MWh divided by 4. Residential is €9/month (or €90/year) with a 14-day free trial and covers one rooftop system up to 100 kW with one seat. Business comes in four capacity bands, up to 2, 8, 20 or 60 equivalent MW of total fleet capacity, with up to 25 plants and 10 seats. Enterprise is custom for fleets above 60 equivalent MW or teams that need SSO and per-user AI access.',
    sections: [
      {
        heading: 'The three tiers',
        blocks: [
          {
            type: 'table',
            headers: ['Plan', 'Capacity', 'Plants', 'Seats', 'Notable features'],
            rows: [
              ['Residential (€9/mo or €90/yr)', 'Up to 100 kW', '1', '1', 'Soiling & power forecasts, cleaning reminders, mobile app'],
              ['Business S', 'Up to 2 equivalent MW', '25', '10', 'Per-inverter soiling, cleaning optimizer, fault detection, BESS + wind + hydrogen analytics, reports, MCP API keys, AI copilot'],
              ['Business M', 'Up to 8 equivalent MW', '25', '10', 'Same as Business S, larger capacity band'],
              ['Business L', 'Up to 20 equivalent MW', '25', '10', 'Same as Business S, larger capacity band'],
              ['Business XL', 'Up to 60 equivalent MW', '25', '10', 'Same as Business S, sized for grid-scale storage and larger fleets'],
              ['Enterprise', 'Unlimited', 'Unlimited', 'Unlimited', 'SSO, MCP OAuth connector, priority support'],
            ],
            caption: 'Capacity is the sum of your plants’ equivalent MW.',
          },
          {
            type: 'paragraph',
            text: 'Capacity is measured in equivalent MW: for each plant, the larger of its rated capacity (MW) and its storage energy capacity (MWh) divided by 4. Solar and wind plants carry no storage MWh, so they count as their rated MW and nothing about their price changes. A battery only prices on energy once it is longer than 4 hours, which is the reference duration used for capacity de-rating in GB and Iberia. Adding a plant that would push you over your band is blocked with an upgrade prompt, and the billing page shows a live usage meter with the MW and MWh behind it.',
          },
        ],
      },
      {
        heading: 'Upgrades, downgrades and cancellation',
        blocks: [
          {
            type: 'list',
            items: [
              'Residential starts with a 14-day free trial (card required); it converts to €9/month or €90/year unless cancelled during the trial.',
              'Business is billed monthly in EUR through Stripe and starts from the pricing page.',
              'Band upgrades take effect immediately after checkout.',
              'Manage payment methods, invoices and cancellation from Settings, then Billing, which opens the Stripe portal.',
              'Cancelling keeps the plan active until the end of the paid period, after which the organisation loses plan access until a plan is chosen again — existing data is kept.',
            ],
          },
        ],
      },
    ],
    faq: [
      {
        q: 'What happens if my fleet grows past my band?',
        a: 'Existing plants keep working. Adding capacity beyond the band is blocked until you upgrade to the next band or Enterprise.',
      },
      {
        q: 'How is a battery priced?',
        a: 'On its equivalent MW: the larger of its rated MW and its storage MWh divided by 4. A 50 MW / 100 MWh two-hour battery counts as 50 MW. The same 50 MW inverter with 400 MWh counts as 100 MW, because the longer asset carries four times the racks, warranty surface and analytics.',
      },
      {
        q: 'Is there a free trial?',
        a: 'Residential comes with a 14-day free trial (card required, cancel anytime before it ends). For Business fleet pilots, contact us.',
      },
    ],
    relatedDocs: [
      { category: 'getting-started', slug: 'create-your-account' },
      { category: 'team-and-roles', slug: 'inviting-your-team' },
    ],
    datePublished: PUBLISHED,
  },
];
