import type { ArticleView, ContentSection, FAQ, RelatedLink } from './types';

/**
 * Template G — Country pages (/solar-monitoring/[slug]).
 *
 * Each page leads with UNIQUE, cited market substance (marketSections) and is
 * only then followed by generated support sections (grid code, inverter
 * landscape, deployment model). Honesty rule: NuraVolt onboards remotely from
 * existing SCADA and inverter APIs; these pages describe capability and market
 * context and never claim local deployments or customers. A region that cannot
 * carry at least three cited local facts does not ship.
 */

export interface RegionEntry {
  slug: string;
  country: string;
  title: string;
  intro: string;
  quickAnswer: string;
  /** Unique, cited market/regulatory/climate substance. Leads the page. */
  marketSections: ContentSection[];
  /** Grid code and reporting snapshot, mirrors /compliance/reference packs. */
  compliance: { label: string; value: string }[];
  /** Inverter and data-source landscape table. */
  commonInverters: { brand: string; note: string }[];
  /** Matching ROI calculator preset, when one exists. */
  roiRegion?: 'uae' | 'gcc' | 'spain' | 'africa' | 'europe' | 'netherlands';
  faq: FAQ[];
  related: RelatedLink[];
  /** Required: regulator and study citations behind the market facts. */
  sources: string[];
  datePublished: string;
}

const REGIONS_HUB = { label: 'Solar monitoring', href: '/solar-monitoring' };

/**
 * The one place deployment is described. Fixed copy so no region page can
 * drift into claiming local presence we do not have.
 */
function deploymentSection(country: string): ContentSection {
  return {
    heading: `How NuraVolt deploys in ${country}`,
    blocks: [
      {
        type: 'paragraph',
        text: `NuraVolt is software only. There is no hardware to install, no site visit, and no local office required: plants onboard remotely from the data sources they already have, such as inverter vendor APIs, SCADA exports, or data loggers. A typical onboarding takes days, not months, and starts with a historical backfill so the models see a full seasonal cycle before live monitoring begins.`,
      },
      {
        type: 'paragraph',
        text: `Per-inverter soiling estimation, fault detection, and BESS health analytics run on that operational data directly. That matters in markets where dedicated soiling stations and extra instrumentation are hard to procure, import, and maintain: the analytics work with the fleet you already operate.`,
      },
    ],
  };
}

export const regions: RegionEntry[] = [
  {
    slug: 'south-africa',
    country: 'South Africa',
    title: 'Solar monitoring in South Africa: after load shedding, the tariff era (2026)',
    intro:
      'South Africa built an 8 GW private solar fleet in a hurry. Now that load shedding is suspended, those systems have to perform as investments, not insurance.',
    quickAnswer:
      'South Africa’s private solar fleet passed 8.3 GW by mid 2026, most of it installed in a rush during load shedding. With rotational cuts suspended since 2025 and Eskom tariffs up 12.74 percent in April 2025, the economics have shifted from backup power to yield. Monitoring, not more panels, is where C&I returns now come from.',
    marketSections: [
      {
        heading: 'An 8 GW fleet built in a hurry',
        blocks: [
          {
            type: 'stat',
            items: [
              { value: '8.3 GW', label: 'private solar by mid 2026', sub: 'Eskom NTC data, June 2026' },
              { value: '+215%', label: 'growth since Aug 2022', sub: '2,264 MW to 7,300 MW by Sept 2025' },
              { value: '12.74%', label: 'Eskom tariff increase', sub: 'NERSA approved, April 2025' },
            ],
          },
          {
            type: 'paragraph',
            text: 'Between 2022 and 2026 South Africa imported more solar panels than any other African country, 4.3 GW in 2023 and 3.8 GW in 2024, and private capacity overtook everything Eskom has ever contracted from independent power producers. Much of that fleet was specified, installed, and commissioned at crisis speed, with monitoring an afterthought. The result is a national portfolio where nobody can say with confidence which systems are underperforming, by how much, or why.',
          },
        ],
      },
      {
        heading: 'From blackout hedge to yield asset',
        blocks: [
          {
            type: 'paragraph',
            text: 'Eskom marked 300 consecutive days without load shedding in March 2026, after a 2025 in which rotational cuts totalled only about 26 hours. Its Winter Outlook 2026 base case projects none through August 2026. The crisis that sold most of the fleet is, for now, over. What replaced it is tariff escalation: grid power keeps getting more expensive, which makes every self-generated kilowatt hour more valuable, and every kilowatt hour lost to an undetected fault or unmeasured soiling a recurring cost.',
          },
          {
            type: 'paragraph',
            text: 'Eskom’s virtual wheeling platform also went commercially live in 2025, letting large consumers buy remote generation. Wheeled energy is settled on metered data, which raises the bar for generation-side measurement: a wheeling seller needs to know its real production and losses, not its datasheet numbers.',
          },
        ],
      },
      {
        heading: 'Soiling in South Africa: measure, do not assume',
        blocks: [
          {
            type: 'paragraph',
            text: 'The best measured soiling study in the country, 14 months at the 75 MWp Kalkbult plant in the Northern Cape by Stellenbosch University, IFE, and Scatec, found remarkably low losses: peak monthly average power loss of 1 to 2 percent, with dust deposition of 0.02 to 0.04 grams per square metre per day. That is the opposite of what most yield models assume for a semi-arid site, and it cuts both ways: some South African sites soil far less than budgeted, others, near mines, agriculture, or coastal salt, far more. The only defensible position is per-site, per-inverter measurement from operational data rather than a regional assumption.',
          },
        ],
      },
    ],
    compliance: [
      { label: 'Regulator', value: 'NERSA (National Energy Regulator of South Africa)' },
      { label: 'Up to 100 kW', value: 'Register with the distributor (Eskom or municipality), per NERSA’s February 2026 clarification' },
      { label: 'Above 100 kW', value: 'Register directly with NERSA; grid code compliance and a connection agreement required' },
      { label: 'Licensing', value: 'Embedded generation is licence-exempt under the amended Schedule 2 of the Electricity Regulation Act; registration still applies' },
      { label: 'Wheeling', value: 'Eskom virtual wheeling commercially live since 2025; settlement is on metered data' },
    ],
    commonInverters: [
      { brand: 'Huawei SUN2000', note: 'Direct cloud API integration; common across C&I rooftops' },
      { brand: 'Sungrow', note: 'Direct cloud API integration; C&I and utility scale' },
      { brand: 'SMA', note: 'Logger or portal export; long-standing installed base' },
      { brand: 'Deye / GoodWe hybrids', note: 'CSV or logger export; the load-shedding-era hybrid fleet' },
    ],
    roiRegion: 'africa',
    faq: [
      {
        q: 'Is load shedding still the reason to monitor solar in South Africa?',
        a: 'No. Load shedding has been suspended since mid 2025 and Eskom’s 2026 base case projects none. The driver now is tariff escalation: every kilowatt hour your system fails to produce is bought from the grid at a price that rose 12.74 percent in April 2025 and keeps climbing.',
      },
      {
        q: 'Does a C&I solar system need NERSA registration?',
        a: 'Grid-connected systems up to 100 kW register with the distributor; systems above 100 kW register directly with NERSA and must comply with the grid code and hold a connection agreement. Registration depends on capacity and grid connection, not on whether you export.',
      },
      {
        q: 'How bad is soiling in South Africa?',
        a: 'More variable than assumed. The measured Kalkbult study in the Northern Cape found only 1 to 2 percent peak monthly losses, while sites near mining, agriculture, or coastal salt can lose far more. Measuring per site from inverter data beats any regional assumption.',
      },
    ],
    related: [
      { title: 'Soiling loss', href: '/faults/soiling-loss', description: 'How soiling is detected from operational data.' },
      { title: 'Soiling loss: when is cleaning worth it?', href: '/insights/soiling-cleaning-economics', description: 'The cleaning decision as an economic problem.' },
      { title: 'Compliance reference', href: '/compliance/reference', description: 'Country grid-code packs, including South Africa.' },
      { title: 'Huawei SUN2000 integration', href: '/integrations/huawei', description: 'The vendor API most SA C&I fleets already have.' },
      { title: 'ROI calculator', href: '/roi-calculator', description: 'Estimate recovered losses for your portfolio.' },
    ],
    sources: [
      'Eskom media statement, 300 days without load shedding, March 2026',
      'Engineering News, NERSA SSEG registration clarification, February 2026',
      'Engineering News, rooftop solar past 8 GW, June 2026',
      'Moneyweb, private solar at 7,300 MW, September 2025',
      'Stellenbosch University / IFE / Scatec, Kalkbult soiling study, 2021',
      'NERSA tariff decision, January 2025',
    ],
    datePublished: '2026-07-11',
  },
  {
    slug: 'kenya',
    country: 'Kenya',
    title: 'Solar monitoring in Kenya: captive C&I is the market now (2026)',
    intro:
      'Kenya’s commercial and industrial solar segment is bigger than its utility-scale fleet and growing faster. Portfolios of many small sites are exactly where monitoring is hardest.',
    quickAnswer:
      'Kenya had 514 MW of solar by June 2025, and the largest share, 300.5 MW, is captive C&I, more than all utility-scale plants combined. With all-in commercial grid power near KSh 22 per kWh and net metering live for systems under 1 MW at a 50 percent export credit, returns depend on self-consumption and per-site performance, which is a monitoring problem.',
    marketSections: [
      {
        heading: 'Captive C&I is the Kenyan solar market',
        blocks: [
          {
            type: 'stat',
            items: [
              { value: '514.1 MW', label: 'installed solar, June 2025', sub: 'EPRA / Intersolar Kenya data' },
              { value: '300.5 MW', label: 'captive C&I', sub: 'larger than the 210.3 MW utility fleet' },
              { value: '~KSh 22/kWh', label: 'all-in business tariff', sub: 'including taxes and levies, late 2025' },
            ],
          },
          {
            type: 'paragraph',
            text: 'The Kenyan market did not follow the utility-first path. Manufacturers, cement plants, flower farms, and malls built their own generation to escape commercial tariffs, and captive C&I now exceeds utility scale. Operators like Equator Energy run around 45 MW across dozens of sites and target 300 MW by 2030. That shape, many distributed plants of 100 kW to a few MW, is the hardest to monitor well: no site is big enough for a control room, but together they are a power station.',
          },
        ],
      },
      {
        heading: 'Net metering pays half, so self-consumption is the game',
        blocks: [
          {
            type: 'paragraph',
            text: 'The Energy (Net-Metering) Regulations of 2024 opened net metering to renewable systems under 1 MW, but exports are credited at 50 percent of the applicable retail tariff, credits expire at the end of the utility’s financial year, and the consumer pays for the bidirectional smart meter. The arithmetic is blunt: a kilowatt hour consumed on site is worth twice one exported. Sizing, load matching, and catching underperformance early all hinge on knowing exactly what each site produces and when, which is what per-inverter monitoring provides.',
          },
          {
            type: 'paragraph',
            text: 'On licensing, self-generation on your own premises below 1 MW is exempt from an EPRA generation licence. Above 1 MW, or in any third-party supply structure like a tenant PPA, an EPRA licence applies. Portfolio operators mixing both models need clean per-site production records for the regulator as much as for their investors.',
          },
        ],
      },
    ],
    compliance: [
      { label: 'Regulator', value: 'EPRA (Energy and Petroleum Regulatory Authority)' },
      { label: 'Below 1 MW, own use', value: 'Exempt from a generation licence under the Energy Act 2019' },
      { label: 'Above 1 MW or third-party supply', value: 'EPRA generation licence required, including tenant and offsite PPA structures' },
      { label: 'Net metering', value: 'Legal Notice 104 of 2024: systems under 1 MW, export credited at 50 percent of retail, credits expire at financial year end' },
    ],
    commonInverters: [
      { brand: 'Huawei SUN2000', note: 'Direct cloud API integration; dominant in East African C&I' },
      { brand: 'Sungrow', note: 'Direct cloud API integration' },
      { brand: 'Growatt', note: 'Portal or logger export; common in smaller commercial systems' },
      { brand: 'SMA', note: 'Logger or portal export' },
    ],
    roiRegion: 'africa',
    faq: [
      {
        q: 'Does a C&I solar plant in Kenya need an EPRA licence?',
        a: 'Not if it is below 1 MW and supplies only your own premises. Above 1 MW, or when a third party is supplied under a PPA, an EPRA generation licence is required.',
      },
      {
        q: 'Is exporting to the grid worth it under Kenyan net metering?',
        a: 'Only marginally. Exports earn 50 percent of the retail tariff and unused credits are forfeited at the utility’s financial year end. Maximizing self-consumption is worth roughly twice as much, which makes accurate production and load data the core of the business case.',
      },
      {
        q: 'How do you monitor a portfolio of many small sites?',
        a: 'Through the inverter vendor cloud APIs the sites already report to, normalized into one platform. No site visits or extra hardware: per-inverter data is enough to rank sites, flag faults, and estimate soiling centrally.',
      },
    ],
    related: [
      { title: 'Soiling loss', href: '/faults/soiling-loss', description: 'Detecting recoverable losses from operational data.' },
      { title: 'How to monitor a C&I solar portfolio in 2026', href: '/insights/ci-solar-monitoring-guide-2026', description: 'The practical playbook for distributed fleets.' },
      { title: 'Compliance reference', href: '/compliance/reference', description: 'Country grid-code packs, including Kenya.' },
      { title: 'Huawei SUN2000 integration', href: '/integrations/huawei', description: 'The most common data source in East African C&I.' },
      { title: 'ROI calculator', href: '/roi-calculator', description: 'Estimate recovered losses for your portfolio.' },
    ],
    sources: [
      'Energy Act No. 1 of 2019 (EPRA)',
      'Energy (Net-Metering) Regulations, Legal Notice 104 of 2024',
      'Intersolar Kenya market review, 2025',
      'Stoa Infra & Energy / Renewables Now, Equator Energy portfolio, 2025',
      'GlobalPetrolPrices, Kenya business electricity price, September 2025',
    ],
    datePublished: '2026-07-11',
  },
  {
    slug: 'nigeria',
    country: 'Nigeria',
    title: 'Solar monitoring in Nigeria: net billing, grid collapses and diesel money (2026)',
    intro:
      'Nigeria tripled its solar capacity in 2025 and switched on net billing for C&I systems in June 2026. Every kilowatt hour a plant fails to produce is replaced at diesel prices.',
    quickAnswer:
      'Nigeria added 803 MW of solar in 2025, lifting capacity to about 1.19 GW, nearly all of it distributed. With Band A grid power at N225 per kWh, self-generated diesel power around USD 0.47 per kWh, and NERC’s net billing regime live since June 2026 for systems of 50 kWp to 1.5 MWp, C&I solar economics are among the strongest anywhere, provided the plants actually perform.',
    marketSections: [
      {
        heading: 'Africa’s fastest growing solar market',
        blocks: [
          {
            type: 'stat',
            items: [
              { value: '803 MW', label: 'solar added in 2025', sub: 'up 141 percent year on year' },
              { value: '~1.19 GW', label: 'cumulative capacity', sub: 'about 96 percent distributed, not grid scale' },
              { value: '4', label: 'national grid collapses in 2025', sub: 'down from 12 in 2024' },
            ],
          },
          {
            type: 'paragraph',
            text: 'Nigeria became Africa’s second largest solar market in 2025 and accounted for roughly 80 percent of West Africa’s additions. Almost none of it is utility scale: the fleet is rooftops, mini-grids, and captive C&I plants built to displace generators. Battery storage quadrupled to about 40 MWh in the same year. This is a market of thousands of distributed assets owned by businesses whose alternative power source costs ten times the grid tariff.',
          },
        ],
      },
      {
        heading: 'The arithmetic: every lost kilowatt hour is a diesel kilowatt hour',
        blocks: [
          {
            type: 'paragraph',
            text: 'More than 80 percent of Nigerian firms run generators, and World Bank analysis puts self-generated diesel power around USD 0.47 per kWh, roughly ten times the grid tariff. In April 2024 NERC raised Band A tariffs from N68 to N225 per kWh, which pushed even well-supplied customers toward solar. The consequence for monitoring is unusual: when a string fails or soiling builds up on a Nigerian C&I roof, the lost energy is not bought back at grid prices, it is bought back at diesel prices. The payback on catching faults early is several times what it would be in Europe.',
          },
        ],
      },
      {
        heading: 'Net billing is live since June 2026',
        blocks: [
          {
            type: 'paragraph',
            text: 'NERC commenced its Net Billing Regulations on 3 June 2026. Eligible prosumers with renewable systems from 50 kWp to 1.5 MWp connected to a distribution network can export surplus energy, credited at a NERC-approved export tariff, after signing a Net Billing Agreement with their DisCo, registering with NERC, and installing bidirectional metering. Note the term: this is net billing, not net metering, so exports earn the approved export tariff rather than one-to-one retail credit. It also makes metering-grade generation data a regulatory requirement, not a nice-to-have: the settlement is only as good as the data behind it.',
          },
        ],
      },
    ],
    compliance: [
      { label: 'Regulator', value: 'NERC (Nigerian Electricity Regulatory Commission)' },
      { label: 'Net billing', value: 'Net Billing Regulations 2026, in force since 3 June 2026' },
      { label: 'Eligible systems', value: 'Renewable prosumers from 50 kWp to 1.5 MWp connected to a DisCo network' },
      { label: 'Requirements', value: 'Net Billing Agreement with the DisCo, NERC registration, bidirectional smart meter; exports credited at the NERC-approved export tariff' },
    ],
    commonInverters: [
      { brand: 'Huawei SUN2000', note: 'Direct cloud API integration' },
      { brand: 'Sungrow', note: 'Direct cloud API integration' },
      { brand: 'Deye hybrids', note: 'CSV or logger export; the default for storage-coupled C&I sites' },
      { brand: 'Growatt / Victron', note: 'Portal or logger export; common in hybrid and off-grid designs' },
    ],
    roiRegion: 'africa',
    faq: [
      {
        q: 'Is Nigeria’s June 2026 regime net metering or net billing?',
        a: 'Net billing. Exports are credited at a NERC-approved export tariff rather than one-to-one against retail consumption. The distinction changes the business case: self-consumption remains more valuable than export.',
      },
      {
        q: 'Why does monitoring pay back faster in Nigeria than elsewhere?',
        a: 'Because the replacement cost of lost solar energy is diesel at roughly USD 0.47 per kWh, not grid power. A fault or soiling loss that costs a Spanish plant 60 euros per MWh costs a Lagos factory several times that.',
      },
      {
        q: 'Can sites that run alongside generators be monitored?',
        a: 'Yes. NuraVolt reads the PV and storage side from inverter APIs, loggers, or exports, including on hybrid sites where a genset covers grid outages. The analytics isolate what the solar asset produced and what it should have produced.',
      },
    ],
    related: [
      { title: 'Soiling loss', href: '/faults/soiling-loss', description: 'Detecting recoverable losses from operational data.' },
      { title: 'How to monitor a C&I solar portfolio in 2026', href: '/insights/ci-solar-monitoring-guide-2026', description: 'The playbook for distributed fleets.' },
      { title: 'Compliance reference', href: '/compliance/reference', description: 'Country grid-code packs, including Nigeria.' },
      { title: 'PV string underperformance', href: '/faults/pv-string-underperformance', description: 'The fault class that quietly costs the most.' },
      { title: 'ROI calculator', href: '/roi-calculator', description: 'Estimate recovered losses at your replacement power cost.' },
    ],
    sources: [
      'NERC, Net Billing Regulations 2026',
      'Nairametrics, net billing rollout, June 2026',
      'The Guardian Nigeria, grid collapse timeline, 2024',
      'World Bank, cost of self-generated power analysis',
      'Ecofin Agency, Nigeria 2025 solar additions, February 2026',
      'Nairametrics, Band A tariff review, April 2024',
    ],
    datePublished: '2026-07-11',
  },
  {
    slug: 'spain',
    country: 'Spain',
    title: 'Solar plant monitoring in Spain: CECRE telemetry, negative prices and Calima dust (2026)',
    intro:
      'Spain crossed 50 GW of solar while capture prices collapsed. Plants above 1 MW answer to REE’s control room in real time, and the post-blackout rules add voltage-control homework.',
    quickAnswer:
      'Spain closed 2025 with 48.1 GW of solar and crossed 50 GW in early 2026, while spring 2025 brought 404 negative-price hours and curtailment above 5 GW. Plants over 1 MW must feed real-time telemetry to REE’s CECRE, and after the April 2025 blackout RD 997/2025 tightens voltage-control expectations. In this market, margins come from monitoring, not sunshine.',
    marketSections: [
      {
        heading: '50 GW, and the margin problem',
        blocks: [
          {
            type: 'stat',
            items: [
              { value: '48.1 GW', label: 'solar at end 2025', sub: '7.9 GW added in the year; 50 GW crossed early 2026' },
              { value: '404', label: 'negative-price hours', sub: 'spring 2025' },
              { value: '>5 GW', label: 'solar curtailed', sub: 'during 81 percent of negative-price hours' },
            ],
          },
          {
            type: 'paragraph',
            text: 'Solar is now the largest technology in Spain’s installed capacity mix, and the merchant consequences arrived fast: capture prices are projected near 25 euros per MWh by 2027, while PPA break-evens sit at 32 to 56 euros. When the market price of energy trends toward the marginal cost of sunshine, the plants that stay profitable are the ones that lose the least: to soiling, to faults, to availability gaps, and to curtailment they did not have to accept. Recoverable losses of 2 to 4 percent are the difference between clearing a PPA floor and missing it.',
          },
        ],
      },
      {
        heading: 'CECRE, RD 413/2014, and the post-blackout rules',
        blocks: [
          {
            type: 'paragraph',
            text: 'Spain has the strictest renewable telemetry regime in Europe. Under RD 413/2014, installations above 1 MW must send real-time telemetry to the system operator, and REE’s renewable control centre CECRE monitors them continuously and can issue output setpoints. Plants above 5 MW must additionally operate through an authorized generation control centre as their interlocutor with CECRE.',
          },
          {
            type: 'paragraph',
            text: 'The 28 April 2025 Iberian blackout added a second layer. The ENTSO-E final report traced the cascade to overvoltage and gaps in voltage and reactive-power control, noting that renewables operating in fixed power-factor mode provided no reactive support, and explicitly not blaming excess renewable generation. The surviving regulatory response, RD 997/2025 in force since November 2025, orders CNMC inspections of voltage-control compliance, updates to technical rules on voltage stability and system visibility, and accelerates storage toward 22.5 GW by 2030. Plant operators should expect their voltage-control behaviour to be examined, which means having the telemetry record to show for it.',
          },
        ],
      },
      {
        heading: 'Calima: Saharan dust on the peninsula',
        blocks: [
          {
            type: 'paragraph',
            text: 'Spain is among the European regions most exposed to Saharan dust intrusions, and peer-reviewed soiling mapping of Europe recommends region-specific cleaning strategies for exactly this reason. A calima event soils an entire portfolio at once, but not uniformly: tilt, wind exposure, and subsequent rain vary by site. The operational question after an event is which plants to clean first and which recovered on their own. Per-inverter soiling estimation from operational data answers that portfolio-wide within days, without waiting on a handful of soiling stations.',
          },
        ],
      },
    ],
    compliance: [
      { label: 'System operator', value: 'Red Eléctrica de España (REE), renewable control centre CECRE' },
      { label: 'Above 1 MW', value: 'Real-time telemetry to the system operator, per RD 413/2014' },
      { label: 'Above 5 MW', value: 'Subject to REE power-control instructions via an authorized generation control centre' },
      { label: 'Post-blackout', value: 'RD 997/2025: voltage-control compliance inspections, updated technical rules on voltage stability and visibility' },
    ],
    commonInverters: [
      { brand: 'Power Electronics', note: 'Spanish utility-scale leader; SCADA export' },
      { brand: 'Ingeteam', note: 'Spanish manufacturer; SCADA export' },
      { brand: 'Huawei SUN2000', note: 'Direct cloud API integration; strong in C&I' },
      { brand: 'Sungrow', note: 'Direct cloud API integration' },
      { brand: 'SMA', note: 'Logger or portal export' },
    ],
    roiRegion: 'spain',
    faq: [
      {
        q: 'Which Spanish plants must send telemetry to CECRE?',
        a: 'Installations above 1 MW, including groupings that exceed 1 MW, send real-time telemetry under RD 413/2014. Above 5 MW, plants are also dispatchable by REE and must work through an authorized generation control centre.',
      },
      {
        q: 'What changed for solar operators after the April 2025 blackout?',
        a: 'RD 997/2025 puts voltage and reactive-power control under scrutiny: CNMC will inspect compliance and REE is updating technical rules on voltage stability and system visibility. Operators need a telemetry record that demonstrates correct behaviour, not just production data.',
      },
      {
        q: 'How significant is calima soiling for Spanish plants?',
        a: 'Event-driven and site-specific. Saharan intrusions can soil a whole region in one episode, but recovery varies with rain and site conditions. Measuring the actual per-site loss from inverter data is what turns a dust event into a ranked cleaning plan instead of a blanket cost.',
      },
    ],
    related: [
      { title: 'Soiling loss', href: '/faults/soiling-loss', description: 'How soiling is detected from operational data.' },
      { title: 'Soiling loss: when is cleaning worth it?', href: '/insights/soiling-cleaning-economics', description: 'The cleaning decision as an economic problem.' },
      { title: 'The Iberian blackout and BESS readiness', href: '/blog/iberian-blackout-bess-readiness', description: 'What 28 April 2025 means for storage operators.' },
      { title: 'Compliance reference', href: '/compliance/reference', description: 'Country grid-code packs, including Spain.' },
      { title: 'Case studies', href: '/case-studies', description: 'Including a Spanish utility-scale deployment.' },
    ],
    sources: [
      'Red Eléctrica de España, CECRE and the 2025 system report',
      'ENTSO-E, final report on the 28 April 2025 Iberian grid incident',
      'RD 413/2014 and RD 997/2025 (BOE)',
      'S&P Global and Pexapark, Spanish capture price and curtailment analysis, 2025',
      'Renewable Energy (journal), geographical soiling mapping for Europe, 2024',
    ],
    datePublished: '2026-07-11',
  },
  {
    slug: 'saudi-arabia',
    country: 'Saudi Arabia',
    title: 'Solar monitoring in Saudi Arabia: soiling at half a percent per day (2026)',
    intro:
      'Measured soiling in central Saudi Arabia is among the highest recorded anywhere. At the giga-project scale the Kingdom builds, cleaning strategy is a data problem before it is a labor problem.',
    quickAnswer:
      'Measured soiling in central Saudi Arabia runs at 0.44 to 0.51 percent of output per day, uncleaned modules lose about a third of their output within months, and a single sandstorm can cut production 20 percent. With 12 GW of new solar PPAs signed in 2025 alone, deciding when and where to clean is worth millions per site per year, and it is decided by data.',
    marketSections: [
      {
        heading: 'The measured numbers, not the folklore',
        blocks: [
          {
            type: 'paragraph',
            text: 'Saudi soiling is one of the best-documented in the world, and the documented numbers are severe. The KAPSARC measurements on Saudi Aramco arrays near Riyadh remain the reference point.',
          },
          {
            type: 'table',
            caption: 'Measured soiling losses in Saudi Arabia, peer-reviewed studies.',
            headers: ['Study', 'Location', 'Finding'],
            rows: [
              ['KAPSARC / IEEE', 'Riyadh (3.5 MW and 1.8 MW arrays)', '0.44 to 0.51 percent output loss per day by module type'],
              ['Energies review, 2022', 'Riyadh', '32 percent output loss after 8 months uncleaned'],
              ['Energies review, 2022', 'Dhahran', 'Over 50 percent power loss after 6 months uncleaned'],
              ['Yanbu 2-year study', 'Yanbu Al Sinaiyah', '24 percent cumulative generation loss from soiling'],
              ['Energies review, 2022', 'single event', 'One sandstorm cut output 20 percent'],
            ],
          },
          {
            type: 'paragraph',
            text: 'Cleaning optimization studies for desert climates put the optimal interval at roughly 8 to 15 days, with annual water needs of 6 to 36.5 litres per square metre of module to hold losses under 3 percent. The spread in those numbers is the point: the right cadence depends on season, dust events, and site, so a fixed calendar is always leaving money on one side or the other.',
          },
        ],
      },
      {
        heading: 'Giga scale turns cleaning into portfolio optimization',
        blocks: [
          {
            type: 'paragraph',
            text: 'In July 2025, ACWA Power, Badeel, and Aramco’s SAPCO signed PPAs for 15 GW of renewables, 12 GW of it solar, in a single round. Sudair alone is 1.5 GW; the Al Shuaibah complex approaches 2.6 GW. At that scale nobody cleans a whole plant at once: cleaning crews move block by block, and the scheduling question becomes which blocks, in which order, this week. Per-inverter soiling estimation, derived from the electrical data after weather and temperature correction, gives the ranking without deploying a soiling station per block. Where reference stations exist, they become calibration points rather than the only signal.',
          },
        ],
      },
      {
        heading: 'Grid code, briefly',
        blocks: [
          {
            type: 'paragraph',
            text: 'Transmission-connected plants operate under the Saudi Arabian Grid Code, last updated in May 2024, with WERA as the approving authority, and the Saudi Electricity Company publishes dedicated technical connection standards for large-scale PV. Performance reporting against those obligations comes from the same telemetry the analytics run on.',
          },
        ],
      },
    ],
    compliance: [
      { label: 'Regulator', value: 'WERA (Water and Electricity Regulatory Authority)' },
      { label: 'Grid code', value: 'Saudi Arabian Grid Code, updated May 2024; WERA approves amendments' },
      { label: 'Large-scale PV', value: 'SEC PV Large Scale Technical Connection Standards apply to utility connections' },
    ],
    commonInverters: [
      { brand: 'Sungrow', note: 'Direct cloud API integration; central and string inverters at utility scale' },
      { brand: 'Huawei SUN2000', note: 'Direct cloud API integration' },
      { brand: 'SMA', note: 'SCADA or logger export' },
      { brand: 'Plant SCADA', note: 'Utility-scale sites integrate via SCADA export or historian access' },
    ],
    roiRegion: 'gcc',
    faq: [
      {
        q: 'How often should a plant in Saudi Arabia be cleaned?',
        a: 'Measured optimization studies land at roughly 8 to 15 days for desert climates, but the honest answer is per site and per season. Condition-based cleaning, triggered by measured soiling rather than the calendar, is what the loss rates justify.',
      },
      {
        q: 'Can soiling be measured without installing soiling stations?',
        a: 'Yes. After correcting inverter output for weather, temperature, and curtailment, the residual per-inverter loss tracks soiling. Stations add a physical ground-truth point, but at multi-hundred-MW scale the per-inverter estimate is what makes block-by-block cleaning decisions possible.',
      },
      {
        q: 'What do the measured Saudi soiling studies actually show?',
        a: 'Around half a percent of output lost per day near Riyadh, roughly a third of production gone within 8 months uncleaned, over half in Dhahran within 6 months, and 20 percent from a single sandstorm. Saudi Arabia is the strongest economic case for soiling analytics anywhere.',
      },
    ],
    related: [
      { title: 'Soiling loss', href: '/faults/soiling-loss', description: 'How soiling is detected from operational data.' },
      { title: 'Soiling loss: when is cleaning worth it?', href: '/insights/soiling-cleaning-economics', description: 'Cleaning as an optimization problem.' },
      { title: 'Compliance reference', href: '/compliance/reference', description: 'Country grid-code packs, including Saudi Arabia.' },
      { title: 'ROI calculator', href: '/roi-calculator', description: 'GCC preset with local solar hours and tariffs.' },
    ],
    sources: [
      'IEEE, measured soiling loss for PV plants in central Saudi Arabia (KAPSARC)',
      'Energies 15:8033, soiling review, 2022',
      'Renewable Energy (journal), Yanbu Al Sinaiyah two-year soiling study',
      'PIF press release, ACWA Power / Badeel / SAPCO 15 GW PPAs, July 2025',
      'Saudi Arabian Grid Code (WERA), May 2024',
    ],
    datePublished: '2026-07-11',
  },
  {
    slug: 'uae',
    country: 'UAE',
    title: 'Solar monitoring in the UAE: Shams Dubai, giga parks and dust (2026)',
    intro:
      'The UAE runs some of the world’s largest single-site solar assets next to a fast-growing rooftop segment, in one of the dustiest operating environments on earth.',
    quickAnswer:
      'The UAE combines giga-scale plants, 3.86 GW at the MBR Solar Park and 2 GW at Al Dhafra, with 725 MW of Shams Dubai rooftops across 8,430 buildings. University studies in the Emirates measure dust cutting cell efficiency by double digits within months, and Abu Dhabi’s February 2026 self-supply policy opens a new C&I solar-plus-storage segment.',
    marketSections: [
      {
        heading: 'Two markets in one country',
        blocks: [
          {
            type: 'stat',
            items: [
              { value: '3,860 MW', label: 'MBR Solar Park installed', sub: 'target above 8 GW by 2030' },
              { value: '2 GW', label: 'Al Dhafra, single site', sub: 'about 4 million bifacial panels' },
              { value: '725 MW', label: 'Shams Dubai rooftops', sub: 'across 8,430 buildings, June 2025' },
            ],
          },
          {
            type: 'paragraph',
            text: 'Utility scale in the UAE is a short list of very large assets: the Mohammed bin Rashid Al Maktoum Solar Park, whose Phase 7 adds another 2 GW of PV plus a 1,400 MW, 8,400 MWh battery, and Al Dhafra’s 2 GW single site. Distributed solar is the opposite: thousands of rooftops under DEWA’s Shams Dubai program. Abu Dhabi joined in February 2026 with a Department of Energy self-supply policy that for the first time lets businesses across the emirate install solar plus storage behind the meter, with metering and settlement guidelines to follow. Both segments share one operating reality: dust.',
          },
        ],
      },
      {
        heading: 'Dust economics, measured locally',
        blocks: [
          {
            type: 'paragraph',
            text: 'Khalifa University research measured dust buildup reducing solar cell efficiency by up to 41.45 percent, and a UAE University study in Renewable Energy recorded soiling losses rising 12.7 percent as dust density grew 5.44 grams per square metre over five months of outdoor exposure. Losses are event-driven as much as gradual: a storm can undo a cleaning cycle overnight. The operational questions are the same at 2 GW and at 200 kW: what is each array actually losing right now, and did the last clean recover what it should have. Both are answered by per-inverter soiling estimation from the production data itself, with cleaning verification as a byproduct.',
          },
        ],
      },
      {
        heading: 'Compliance is utility specific',
        blocks: [
          {
            type: 'paragraph',
            text: 'There is no UAE-wide telemetry mandate comparable to Spain’s CECRE regime; obligations are set per utility. In Dubai, Shams Dubai connections require a no-objection certificate and design approval through DEWA’s platform, installation by a DEWA-certified contractor, equipment from the eligible list with ECAS certification, a DEWA inspection, and a bidirectional smart meter. In Abu Dhabi, the Department of Energy’s self-supply framework took effect on 5 February 2026, with binding metering and settlement guidelines to be issued. Clean production records per site are the common denominator across both regimes.',
          },
        ],
      },
    ],
    compliance: [
      { label: 'Dubai (DEWA)', value: 'Shams Dubai: NOC and design approval, DEWA-certified contractor, eligible equipment with ECAS certification, inspection, bidirectional smart meter' },
      { label: 'Abu Dhabi (DoE)', value: 'Solar-plus-storage self-supply policy in effect since 5 February 2026; metering and settlement guidelines pending' },
      { label: 'Telemetry', value: 'No UAE-wide real-time telemetry mandate; obligations are utility specific' },
    ],
    commonInverters: [
      { brand: 'Huawei SUN2000', note: 'Direct cloud API integration; strong in C&I rooftops' },
      { brand: 'Sungrow', note: 'Direct cloud API integration; utility and C&I' },
      { brand: 'SMA', note: 'Logger or portal export' },
      { brand: 'FIMER / ABB legacy', note: 'SCADA or logger export on older utility assets' },
    ],
    roiRegion: 'uae',
    faq: [
      {
        q: 'What does connecting a rooftop system under Shams Dubai involve?',
        a: 'A no-objection certificate and design approval through DEWA’s platform, installation by a DEWA-certified contractor using equipment from the eligible list, a DEWA inspection, and a bidirectional smart meter. Monitoring is not mandated, but settlement runs on the meter, so owners who track production per inverter know whether they are getting what they paid for.',
      },
      {
        q: 'How large are dust losses in the UAE really?',
        a: 'Locally measured studies put worst-case cell efficiency reductions above 40 percent and typical uncleaned losses in the low double digits within months. The variance between sites and seasons is the argument for measuring per site rather than assuming a flat soiling factor.',
      },
      {
        q: 'Does the UAE require real-time telemetry like Spain?',
        a: 'No. There is no federal telemetry mandate; requirements are set per utility. DEWA’s regime centers on certified equipment and bidirectional metering, and Abu Dhabi’s self-supply metering guidelines are still being issued.',
      },
    ],
    related: [
      { title: 'Soiling loss', href: '/faults/soiling-loss', description: 'How soiling is detected from operational data.' },
      { title: 'Soiling loss: when is cleaning worth it?', href: '/insights/soiling-cleaning-economics', description: 'Cleaning as an economic decision.' },
      { title: 'Compliance reference', href: '/compliance/reference', description: 'Country grid-code packs, including the UAE.' },
      { title: 'Tesla Megapack integration', href: '/integrations/tesla-megapack', description: 'BESS data for storage-coupled assets.' },
      { title: 'ROI calculator', href: '/roi-calculator', description: 'UAE preset with local solar hours and tariffs.' },
    ],
    sources: [
      'DEWA, Shams Dubai program documentation',
      'Zawya, Shams Dubai capacity, June 2025',
      'Khalifa University, dust and solar cell efficiency study',
      'UAE University, Renewable Energy (journal), 2019 soiling study',
      'pv magazine, Abu Dhabi self-supply policy, February 2026',
    ],
    datePublished: '2026-07-11',
  },
];

export function getRegion(slug: string): RegionEntry | undefined {
  return regions.find((r) => r.slug === slug);
}

export function normalizeRegion(entry: RegionEntry): ArticleView {
  const sections: ContentSection[] = [
    ...entry.marketSections,
    {
      heading: 'Grid code and reporting obligations',
      blocks: [
        { type: 'keyValue', pairs: entry.compliance },
        {
          type: 'paragraph',
          text: 'NuraVolt ships country grid-code packs that map plant telemetry to the local reporting obligations. See the compliance reference for the full pack list.',
        },
      ],
    },
    {
      heading: 'Inverters and data sources we connect',
      blocks: [
        {
          type: 'table',
          headers: ['Brand', 'Notes'],
          rows: entry.commonInverters.map((i) => [i.brand, i.note]),
          caption: `Common inverter and data platforms in ${entry.country} that NuraVolt reads from.`,
        },
      ],
    },
    deploymentSection(entry.country),
  ];

  if (entry.roiRegion) {
    sections.push({
      heading: 'Estimate the value for your fleet',
      blocks: [
        {
          type: 'paragraph',
          text: `The NuraVolt ROI calculator includes a preset for this market with local solar hours and tariff assumptions. Use it to estimate what recovered soiling and fault losses are worth across your portfolio, then bring the numbers to a call.`,
        },
      ],
    });
  }

  return {
    category: 'Country guide',
    hub: REGIONS_HUB,
    slug: entry.slug,
    urlRelative: `/solar-monitoring/${entry.slug}`,
    title: entry.title,
    intro: entry.intro,
    quickAnswer: entry.quickAnswer,
    sections,
    faq: entry.faq,
    related: entry.related,
    datePublished: entry.datePublished,
    sources: entry.sources,
  };
}
