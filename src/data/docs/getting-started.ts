import type { DocArticle } from './types';

/**
 * Docs category: getting-started.
 *
 * Grounded in src/lib/auth.ts (email/password + Google + magic link,
 * Better Auth organization plugin) and the onboarding wizard in
 * src/components/data-hub/ConnectionWizard.tsx (FULL_ONBOARDING_STEPS,
 * 15-minute default polling interval in src/app/api/connections/route.ts).
 */

const PUBLISHED = '2026-07-05';

export const gettingStartedArticles: DocArticle[] = [
  {
    category: 'getting-started',
    slug: 'create-your-account',
    title: 'Create your account',
    intro: 'Sign up, verify your email, and create the organisation your plants will live in.',
    quickAnswer:
      'Sign up at nuravolt.com with an email and password, with your Google account, or with a passwordless magic link. After signing in, create an organisation. Everything in NuraVolt, plants, data connections, team members, and billing, belongs to an organisation, and the person who creates it becomes its admin.',
    sections: [
      {
        heading: 'Sign-up options',
        blocks: [
          {
            type: 'paragraph',
            text: 'NuraVolt supports three ways to sign in. All three lead to the same account, keyed by your email address.',
          },
          {
            type: 'keyValue',
            pairs: [
              {
                label: 'Email and password',
                value: 'Enter your email and choose a password. You will be asked to verify the email address before you can use the account.',
              },
              {
                label: 'Google',
                value: 'Sign in with your Google account. No separate password to manage, and your email is verified automatically.',
              },
              {
                label: 'Magic link',
                value: 'Enter your email and we send you a one-time sign-in link. Useful if you prefer not to keep another password.',
              },
            ],
          },
        ],
      },
      {
        heading: 'Create your organisation',
        blocks: [
          {
            type: 'paragraph',
            text: 'An organisation is the container for everything you do in NuraVolt: plants, data connections, tickets, team members, and the subscription. On first sign-in you are prompted to create one. Give it your company name, since teammates will see it when you invite them.',
          },
          {
            type: 'paragraph',
            text: 'The person who creates the organisation becomes its admin, with full control over billing, team management, and data connections. You can invite teammates and assign them roles at any time afterwards.',
          },
        ],
      },
      {
        heading: 'What to do next',
        blocks: [
          {
            type: 'paragraph',
            text: 'A new organisation starts without a plan. Pick one from the pricing page to onboard plants: Residential (\u20ac9/month or \u20ac90/year, 14-day free trial) covers one rooftop system up to 100 kW with a single seat, and Business covers commercial fleets in three capacity bands.',
          },
          {
            type: 'list',
            items: [
              'Onboard your first plant with the connection wizard.',
              'Invite the teammates who will operate or view the plant.',
              'Pick the plan that matches your fleet capacity.',
            ],
          },
        ],
      },
    ],
    faq: [
      {
        q: 'Do I need a credit card to sign up?',
        a: 'Signing up and looking around is free, no card needed. To onboard a plant you pick a plan; Residential starts with a 14-day free trial that asks for a card upfront but is not charged until the trial ends.',
      },
      {
        q: 'The magic link email has not arrived. What now?',
        a: 'Check your spam folder first, then request a new link, since each link is single use. If your company mail server delays external mail, signing in with a password or with Google avoids the wait entirely.',
      },
      {
        q: 'Can I belong to more than one organisation?',
        a: 'Yes. You can be a member of several organisations, for example your own company and a client portfolio you help operate, and switch between them. Your role and plant access are set per organisation.',
      },
    ],
    relatedDocs: [
      { category: 'getting-started', slug: 'onboard-your-first-plant' },
      { category: 'team-and-roles', slug: 'inviting-your-team' },
      { category: 'billing', slug: 'plans-and-capacity' },
    ],
    datePublished: PUBLISHED,
  },
  {
    category: 'getting-started',
    slug: 'onboard-your-first-plant',
    title: 'Onboard your first plant',
    intro: 'The connection wizard takes a plant from a name on a form to live analytics in eight steps.',
    quickAnswer:
      'Onboard a plant from the dashboard with the connection wizard: define the plant, describe its equipment, choose a data source, enter credentials, run discovery, match device tags, review field mappings, and confirm. Polling starts on save, first measurements arrive within about 15 minutes, and provisional analytics appear within a day.',
    sections: [
      {
        heading: 'Before you start',
        blocks: [
          {
            type: 'list',
            items: [
              'You need a role that can create plants: ORG_ADMIN or MANAGER. Creating the data connection itself requires ORG_ADMIN.',
              'Have the credentials for your data source at hand, for example a Huawei Northbound account or a SolarEdge API key. The vendor guides in the connecting-data section cover how to get them.',
              'Optional but valuable: plant metadata such as coordinates, module tilt and azimuth, inverter models, and whether the site has a weather station or DustIQ soiling sensor. The more you provide, the better the day-one physics model.',
            ],
          },
        ],
      },
      {
        heading: 'The eight steps',
        blocks: [
          {
            type: 'keyValue',
            pairs: [
              { label: '1. Plant', value: 'Name, location, coordinates, altitude, timezone, and rated capacity in MW.' },
              { label: '2. Equipment', value: 'Inverter groups with tilt, azimuth, model, and MPPT layout, plus weather station and soiling sensor details.' },
              { label: '3. Data sources', value: 'Pick one or more sources that feed this plant, for example a vendor cloud API plus a CSV backfill.' },
              { label: '4. Configure', value: 'Enter credentials for each source and run the connection test.' },
              { label: '5. Discover', value: 'NuraVolt probes the source and finds plants, measurement fields, and device tags.' },
              { label: '6. Match devices', value: 'Match discovered SCADA tags to the inverters you defined in step 2.' },
              { label: '7. Map fields', value: 'Review the automatic field mappings and correct anything ambiguous.' },
              { label: '8. Confirm', value: 'Save and activate. Optionally create a starter performance report for the new plant.' },
            ],
          },
        ],
      },
      {
        heading: 'What the discovery step does',
        blocks: [
          {
            type: 'paragraph',
            text: 'Discovery reads a sample from your source and works out what is in it. It lists the plants the credentials can see, proposes a mapping from your field names to NuraVolt measurement types, each with a confidence score, and collects device-level tags such as per-inverter power channels. High-confidence mappings are accepted automatically; anything ambiguous is queued for your review in the map fields step.',
          },
          {
            type: 'paragraph',
            text: 'Matching device tags to the inverters you defined is what unlocks per-inverter analytics. If you skip the equipment step, NuraVolt still works at plant level, but per-inverter soiling and fault attribution need the device match.',
          },
        ],
      },
      {
        heading: 'What happens after you confirm',
        blocks: [
          {
            type: 'list',
            items: [
              'Polling starts immediately, on a 15-minute interval by default, so the first measurements land within about 15 minutes.',
              'Provisional analytics appear within a day: a physics digital twin built from your plant metadata plus a climate-zone transfer model for soiling.',
              'Estimates improve automatically as your own operating data accrues. See the cold start guide for what to expect when.',
            ],
          },
        ],
      },
    ],
    faq: [
      {
        q: 'Can I skip the equipment step?',
        a: 'Yes, and you can add equipment later. Plant-level analytics work without it, but per-inverter soiling estimation and fault attribution need inverters defined and matched to their SCADA tags.',
      },
      {
        q: 'Can one plant have more than one data source?',
        a: 'Yes. A common setup is a vendor cloud API for live polling plus a CSV upload to backfill history. Each source gets its own credentials, discovery run, and field mapping, and you mark one as primary.',
      },
      {
        q: 'The connection test fails. What should I check?',
        a: 'The wizard lists any required fields you left empty before it lets you test. Beyond that, the most common causes are portal credentials used where API credentials are required, and a wrong regional endpoint. The vendor guides cover the specifics.',
      },
    ],
    relatedDocs: [
      { category: 'connecting-data', slug: 'supported-data-sources' },
      { category: 'connecting-data', slug: 'connect-huawei-fusionsolar' },
      { category: 'analytics', slug: 'cold-start-and-model-maturity' },
      { category: 'getting-started', slug: 'understanding-your-dashboard' },
    ],
    datePublished: PUBLISHED,
  },
  {
    category: 'getting-started',
    slug: 'understanding-your-dashboard',
    title: 'Understanding your dashboard',
    intro: 'Where to find your plants, their soiling and fault analytics, and the maintenance workflow.',
    quickAnswer:
      'The NuraVolt dashboard is organised around your plants. The plants list shows fleet status at a glance; each plant page has an overview plus dedicated soiling, faults, and tickets sections; the data hub manages connections; and settings covers your organisation, team, API keys, and billing.',
    sections: [
      {
        heading: 'Plants list',
        blocks: [
          {
            type: 'paragraph',
            text: 'The landing view after sign-in. One row or card per plant with its capacity, current status, and headline indicators, so you can see across the fleet which sites need attention before opening any of them. Plants you cannot access under your role or per-plant permissions are not shown.',
          },
        ],
      },
      {
        heading: 'Plant overview',
        blocks: [
          {
            type: 'paragraph',
            text: 'Each plant page opens on an overview: production against the expected value from the plant’s digital twin, recent alerts, and the state of its data connections. The expected-versus-measured comparison is the backbone of most NuraVolt analytics, since deviations from expected output are what the soiling and fault models explain.',
          },
        ],
      },
      {
        heading: 'Soiling',
        blocks: [
          {
            type: 'paragraph',
            text: 'The soiling section shows the estimated soiling ratio per inverter and for the plant, a 365-day forecast of how it will evolve, and the cleaning optimiser’s recommended cleaning dates with their expected return. Every estimate carries a model version label so you can tell provisional from mature figures.',
          },
        ],
      },
      {
        heading: 'Faults',
        blocks: [
          {
            type: 'paragraph',
            text: 'The faults section lists active and historical fault detections: what was detected, on which device, the supporting signal evidence, and the severity. From any detection you can open a ticket to hand it to the O&M workflow.',
          },
        ],
      },
      {
        heading: 'Tickets',
        blocks: [
          {
            type: 'paragraph',
            text: 'Tickets track maintenance work from detection to closure through a fixed workflow: NEW, VALIDATED, ASSIGNED, IN_PROGRESS, DONE, with WONT_FIX for detections you decide not to act on. Each ticket keeps its comments and a full status history.',
          },
        ],
      },
      {
        heading: 'Data hub and settings',
        blocks: [
          {
            type: 'paragraph',
            text: 'The data hub is where connections live: their health, last successful poll, and field mappings, plus the wizard for onboarding new plants and sources. Settings covers the organisation profile, team and roles, MCP API keys, and billing.',
          },
        ],
      },
    ],
    faq: [
      {
        q: 'Why does a plant show no data?',
        a: 'Usually one of three things: the connection has not completed its first poll yet, the connection is failing (check its status in the data hub), or the field mapping missed the power measurement. The data hub shows the last poll result for each connection.',
      },
      {
        q: 'Why can a teammate not see a plant I can see?',
        a: 'Plant visibility follows organisation roles and per-plant access grants. A teammate needs at least VIEW access to the plant. Admins and managers can grant access from the team settings.',
      },
    ],
    relatedDocs: [
      { category: 'analytics', slug: 'soiling-intelligence' },
      { category: 'analytics', slug: 'fault-detection-and-tickets' },
      { category: 'team-and-roles', slug: 'roles-and-permissions' },
    ],
    datePublished: PUBLISHED,
  },
];
