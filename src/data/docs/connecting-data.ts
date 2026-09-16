import type { DocArticle } from './types';

/**
 * Docs category: connecting-data.
 *
 * Grounded in src/components/data-hub/vendor-availability.ts (availability
 * tiers), src/lib/services/{huawei-api-service,solaredge-api-service}.ts and
 * src/lib/services/credentials.ts (Secrets Manager + per-customer KMS).
 */

const PUBLISHED = '2026-07-05';

export const connectingDataArticles: DocArticle[] = [
  {
    category: 'connecting-data',
    slug: 'supported-data-sources',
    title: 'Supported data sources',
    intro: 'Which inverter clouds, SCADA systems and file formats you can connect today.',
    quickAnswer:
      'Available today: Huawei FusionSolar, SolarEdge Monitoring, InfluxDB, and CSV upload. In beta with setup help from us: Modbus TCP and SQL SCADA. Coming soon: Sungrow iSolarCloud, SMA Sunny Portal, Fronius Solar.web, GoodWe and SunSpec. Cloud sources are polled every 15 minutes by default.',
    sections: [
      {
        heading: 'Availability by source',
        blocks: [
          {
            type: 'table',
            headers: ['Source', 'Type', 'Status'],
            rows: [
              ['Huawei FusionSolar', 'Manufacturer cloud (Northbound API)', 'Available'],
              ['SolarEdge Monitoring', 'Manufacturer cloud (monitoring API)', 'Available'],
              ['InfluxDB', 'Time-series database', 'Available'],
              ['CSV upload', 'Files', 'Available'],
              ['Modbus TCP', 'Direct to devices', 'Beta'],
              ['SQL SCADA', 'SCADA and historians', 'Beta'],
              ['Sungrow iSolarCloud', 'Manufacturer cloud', 'Coming soon'],
              ['SMA Sunny Portal', 'Manufacturer cloud', 'Coming soon'],
              ['Fronius Solar.web', 'Manufacturer cloud', 'Coming soon'],
              ['GoodWe', 'Manufacturer cloud', 'Coming soon'],
              ['SunSpec', 'Direct to devices', 'Coming soon'],
            ],
            caption: 'Connector availability, July 2026.',
          },
          {
            type: 'paragraph',
            text: 'Beta sources are accepted by the platform but their automated connection test and discovery are still limited, so expect us to help during setup. Coming-soon sources show in the wizard but cannot be selected yet. If you need one of them, tell us; connector priority is driven by customer demand.',
          },
        ],
      },
      {
        heading: 'How polling works',
        blocks: [
          {
            type: 'paragraph',
            text: 'Cloud connections are polled on a schedule, every 15 minutes by default. Each poll pulls the latest device readings for every plant on the connection and lands them in your data lake storage, plus a latest-value snapshot that powers dashboard tiles. You do not need to keep a browser open; polling runs server side.',
          },
          {
            type: 'paragraph',
            text: 'Vendor APIs enforce rate limits, so very large fleets are polled sequentially. If a vendor throttles us, the poller backs off and catches up on the next cycle.',
          },
        ],
      },
    ],
    faq: [
      {
        q: 'My inverter brand is not listed. Can I still use NuraVolt?',
        a: 'Often yes. If the plant has a SCADA system or historian you can connect through SQL SCADA or InfluxDB, and most inverters speak Modbus TCP locally. CSV upload works for evaluations with historical exports.',
      },
      {
        q: 'How fresh is the data on my dashboard?',
        a: 'Cloud sources update every 15 minutes by default. Analytics such as soiling ratios update daily, since they are computed from full days of production data.',
      },
    ],
    relatedDocs: [
      { category: 'connecting-data', slug: 'connect-huawei-fusionsolar' },
      { category: 'connecting-data', slug: 'connect-solaredge' },
      { category: 'connecting-data', slug: 'credentials-security' },
      { category: 'getting-started', slug: 'onboard-your-first-plant' },
    ],
    datePublished: PUBLISHED,
  },
  {
    category: 'connecting-data',
    slug: 'connect-huawei-fusionsolar',
    title: 'Connect Huawei FusionSolar',
    intro: 'Create a Northbound API account in FusionSolar and connect it to NuraVolt.',
    quickAnswer:
      'NuraVolt connects to Huawei FusionSolar through the Northbound API. You need a Northbound (openAPI) account created by your FusionSolar company administrator, plus your region endpoint. NuraVolt discovers your stations and devices automatically and polls real-time device data every 15 minutes.',
    sections: [
      {
        heading: 'What you need',
        blocks: [
          {
            type: 'list',
            items: [
              'A FusionSolar company administrator login (to create the API account).',
              'A Northbound API account: in FusionSolar go to System, then Company Management, then Northbound Management, and create an API account with the stations you want to share.',
              'Your region endpoint. European plants typically use eu5.fusionsolar.huawei.com; the wizard offers the regional options.',
            ],
          },
        ],
      },
      {
        heading: 'Connecting in the wizard',
        blocks: [
          {
            type: 'list',
            items: [
              'In the connection wizard choose Huawei FusionSolar under Manufacturer cloud.',
              'Enter the Northbound account username and password, and pick your region.',
              'Run the connection test, then discovery. NuraVolt lists your stations and their inverters, meters and sensors.',
              'Confirm the plants you want to onboard. Field mappings for Huawei devices are applied automatically.',
            ],
          },
          {
            type: 'paragraph',
            text: 'After you confirm, your credentials are moved into encrypted secret storage and polling starts on the next 15-minute cycle.',
          },
        ],
      },
      {
        heading: 'What NuraVolt reads',
        blocks: [
          {
            type: 'paragraph',
            text: 'The connector reads station lists, device inventories, and real-time device KPIs such as AC and DC power, energy counters, and temperatures. It only reads; NuraVolt never sends control commands to your plant.',
          },
        ],
      },
    ],
    faq: [
      {
        q: 'The connection test fails with an authentication error.',
        a: 'Check that the account is a Northbound API account, not a normal portal login, and that the region endpoint matches where your company account is hosted. Huawei locks accounts after repeated failures, so wait a few minutes before retrying.',
      },
      {
        q: 'Some of my stations are missing after discovery.',
        a: 'The Northbound account only exposes the stations that were shared with it. Ask your FusionSolar administrator to add the missing stations to the API account, then run discovery again.',
      },
    ],
    relatedDocs: [
      { category: 'connecting-data', slug: 'supported-data-sources' },
      { category: 'connecting-data', slug: 'credentials-security' },
      { category: 'getting-started', slug: 'onboard-your-first-plant' },
    ],
    datePublished: PUBLISHED,
  },
  {
    category: 'connecting-data',
    slug: 'connect-solaredge',
    title: 'Connect SolarEdge',
    intro: 'Generate a SolarEdge monitoring API key and connect your sites.',
    quickAnswer:
      'NuraVolt connects to the SolarEdge monitoring API with an API key. An account key exposes every site under your account; a site key exposes one site. Generate the key in the SolarEdge monitoring portal under Admin, then Site Access, and paste it into the connection wizard.',
    sections: [
      {
        heading: 'Account key or site key',
        blocks: [
          {
            type: 'keyValue',
            pairs: [
              {
                label: 'Account API key',
                value: 'Best for installers and fleet operators. One key exposes all sites under the account, and new sites appear automatically.',
              },
              {
                label: 'Site API key',
                value: 'Best for a single plant or a homeowner. The key is scoped to one site only.',
              },
            ],
          },
          {
            type: 'paragraph',
            text: 'You can find or generate keys in the SolarEdge monitoring portal. Site owners will find the site key under Site Admin; account administrators manage account keys under the account settings.',
          },
        ],
      },
      {
        heading: 'Connecting in the wizard',
        blocks: [
          {
            type: 'list',
            items: [
              'Choose SolarEdge Monitoring under Manufacturer cloud.',
              'Paste the API key. If it is a site key, also enter the site id shown in the portal.',
              'Run the test and discovery. NuraVolt lists your sites, inverters and meters.',
              'Confirm the plants to onboard. Mappings are applied automatically.',
            ],
          },
        ],
      },
    ],
    faq: [
      {
        q: 'SolarEdge rate limits the API. Will polling break?',
        a: 'The monitoring API allows a daily request budget per key. The NuraVolt poller batches requests and spaces polls to stay inside it. Very large accounts may see slightly longer refresh intervals.',
      },
    ],
    relatedDocs: [
      { category: 'connecting-data', slug: 'supported-data-sources' },
      { category: 'connecting-data', slug: 'credentials-security' },
      { category: 'getting-started', slug: 'onboard-your-first-plant' },
    ],
    datePublished: PUBLISHED,
  },
  {
    category: 'connecting-data',
    slug: 'credentials-security',
    title: 'How your credentials are stored',
    intro: 'Encryption, storage and data residency for connection credentials.',
    quickAnswer:
      'Connection credentials are moved into AWS Secrets Manager encrypted with a KMS key dedicated to your organisation, hosted in the EU (eu-west-1). The platform database keeps only a reference to the secret, never the credential itself. API responses always mask sensitive fields.',
    sections: [
      {
        heading: 'Storage model',
        blocks: [
          {
            type: 'list',
            items: [
              'When a connection is created its credentials are used once to verify and discover the source.',
              'They are then written to AWS Secrets Manager under a per-customer encryption key (AWS KMS) and removed from the connection record, which keeps only the secret reference.',
              'All secret storage lives in the EU (eu-west-1 region). Secrets are not replicated to other regions.',
              'Connection details returned by the API mask tokens, passwords and keys.',
            ],
          },
        ],
      },
      {
        heading: 'Access and revocation',
        blocks: [
          {
            type: 'paragraph',
            text: 'Only the server-side polling and discovery services can read secrets, and only for the connection they belong to. You can rotate credentials at the vendor at any time and update the connection; deleting a connection deletes its secret. We recommend using read-only or monitoring-scoped vendor accounts wherever the vendor supports them.',
          },
        ],
      },
    ],
    faq: [
      {
        q: 'Can NuraVolt control my plant through these credentials?',
        a: 'No. Connectors only call read endpoints (station lists, device inventories, telemetry). Use monitoring-scoped vendor accounts for extra assurance.',
      },
    ],
    relatedDocs: [
      { category: 'connecting-data', slug: 'supported-data-sources' },
      { category: 'team-and-roles', slug: 'roles-and-permissions' },
    ],
    datePublished: PUBLISHED,
  },
];
