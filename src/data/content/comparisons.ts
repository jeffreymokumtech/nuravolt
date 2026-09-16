import { absoluteUrl } from '@/libs/seo';
import type { ArticleView, ContentSection, FAQ, RelatedLink } from './types';

/**
 * Template F — Comparison pages (/compare).
 *
 * Four kinds share one catalog: named vendor comparisons ('vs'), alternative
 * pages ('alternative'), approach comparisons ('category'), and buyer-guide
 * listicles ('listicle'). Every entry is dated (asOf) and carries required
 * sources, because these pages make claims about third parties. Fairness rule:
 * every vs/alternative page includes a "Where {X} wins" section, and we never
 * state a competitor's pricing unless it is public and cited.
 */

export interface ComparisonEntry {
  slug: string;
  kind: 'vs' | 'alternative' | 'category' | 'listicle';
  title: string;
  /** Named competitor for vs/alternative pages. */
  competitor?: { name: string; website: string };
  /** Human-readable snapshot date shown in the intro, e.g. "July 2026". */
  asOf: string;
  intro: string;
  quickAnswer: string;
  sections: ContentSection[];
  faq: FAQ[];
  related: RelatedLink[];
  /** Required: vendor docs and public references behind every claim. */
  sources: string[];
  datePublished: string;
  /** Listicle only: ordered platform list, emitted as ItemList JSON-LD. */
  itemList?: { name: string; url?: string }[];
}

const COMPARE_HUB = { label: 'Compare', href: '/compare' };

const KIND_LABEL: Record<ComparisonEntry['kind'], string> = {
  vs: 'Comparison',
  alternative: 'Alternative',
  category: 'Comparison',
  listicle: 'Buyer guide',
};

export const comparisons: ComparisonEntry[] = [
  {
    slug: 'best-solar-monitoring-software-2026',
    kind: 'listicle',
    title: 'Best solar monitoring software in 2026: 9 platforms compared',
    asOf: 'August 2026',
    intro:
      'Nine solar monitoring and analytics platforms, compared honestly by category: enterprise asset management, AI analytics, hybrid control, multi-brand loggers, and the free vendor portals.',
    quickAnswer:
      'There is no single best solar monitoring software in 2026, there is a best one per situation. Enterprise asset managers run Power Factors Unity, PowerTrack, or GPM Horizon. Single-vendor fleets often stay on free portals like FusionSolar or iSolarCloud. Independent AI analytics layers like NuraVolt and SmartHelio add per-inverter fault and soiling detection on top of whatever data a fleet already produces.',
    sections: [
      {
        heading: 'How this list works',
        blocks: [
          {
            type: 'paragraph',
            text: 'This comparison is published by NuraVolt, so we are on our own list. To keep it useful anyway, every claim about another platform comes from that vendor’s public documentation or press coverage, last reviewed August 2026, each platform’s genuine strengths are stated plainly, and the verdict is framed per use case rather than as a ranking with ourselves on top. None of these vendors publishes list pricing, so we say so instead of guessing.',
          },
        ],
      },
      {
        heading: 'The nine platforms at a glance',
        blocks: [
          {
            type: 'table',
            caption: 'Categories and typical fits, from public vendor documentation, July 2026.',
            headers: ['Platform', 'Category', 'Best for', 'Standout fact'],
            rows: [
              ['NuraVolt', 'AI analytics, software only', 'C&I and utility fleets wanting per-inverter soiling and fault analytics on existing data', 'Published public-data benchmarks; MCP server for AI assistants'],
              ['Power Factors Unity', 'Enterprise asset management', 'Large IPPs and asset managers across wind, solar, BESS', 'Claims 300+ GW and 18,000 sites under management'],
              ['AlsoEnergy PowerTrack (Stem)', 'Enterprise asset management', 'Solar plus storage portfolios needing commissioning-to-O&M tooling', 'Claims 37+ GW and 800+ BESS sites in 55+ countries'],
              ['GPM Horizon (DNV)', 'Independent monitoring and SCADA', 'Utility-scale portfolios wanting an independent, multi-technology platform', 'Claims 100+ GW across 7,500+ facilities'],
              ['SmartHelio', 'AI analytics, software only', 'Enterprise predictive maintenance programs', 'Claims 8+ GW supported; enterprise roster includes Shell and Tata Power'],
              ['Elum Energy', 'Hybrid control plus monitoring', 'Solar-diesel hybrids and microgrids in Africa and MENA', '2,800+ plants in 90+ countries; on-site controllers plus cloud SCADA'],
              ['Solar-Log', 'Multi-brand logger and portal', 'Installers and small C&I fleets mixing inverter brands', 'Claims 415,000+ plants monitored across roughly 30 inverter brands'],
              ['Huawei FusionSolar', 'Vendor portal', 'All-Huawei fleets', 'Free with Huawei hardware, down to string level'],
              ['Sungrow iSolarCloud', 'Vendor portal', 'All-Sungrow fleets', 'Free with hardware; IV-curve diagnosis and a developer API'],
            ],
          },
        ],
      },
      {
        heading: 'Enterprise asset management: Unity, PowerTrack, GPM Horizon',
        blocks: [
          {
            type: 'paragraph',
            text: 'If you manage hundreds of utility-scale assets with dedicated performance engineers, the enterprise suites are built for you. Power Factors Unity consolidates the former Drive product line and added an AI-powered APM application in April 2026. Stem’s PowerTrack covers commissioning through O&M for solar plus storage and won a smarter E Award in 2026. DNV’s GPM Horizon is the independent-engineer option, with a storage module added in 2025. All three are procurement-grade purchases: expect enterprise sales cycles and no public pricing. For a 20 MW C&I portfolio they are usually more platform than the team can absorb.',
          },
        ],
      },
      {
        heading: 'AI analytics layers: NuraVolt and SmartHelio',
        blocks: [
          {
            type: 'paragraph',
            text: 'Both are software only: no hardware, deployed on the data a fleet already produces. SmartHelio, from Switzerland, focuses on predictive maintenance for enterprise customers and launched an AI agent, GAIA, alongside a MENA expansion in 2026. NuraVolt focuses on per-inverter soiling estimation with a physics digital twin, fault classification, and BESS health analytics, publishes its model accuracy as open benchmarks on public datasets, and ships an MCP server so operators can query their fleet from Claude, ChatGPT, or Cursor. The honest split: SmartHelio has the longer enterprise roster; NuraVolt is the one publishing its numbers and betting on AI-assistant workflows.',
          },
        ],
      },
      {
        heading: 'Hybrid control: Elum Energy',
        blocks: [
          {
            type: 'paragraph',
            text: 'Elum is a different animal: on-site ePowerControl controllers that actively manage solar-diesel hybrids, zero-export constraints, and microgrids, with ePowerMonitor as the cloud layer. For a factory in Lagos or Nairobi running PV against gensets, that control capability is the product, and no pure analytics platform replaces it. The trade-off runs the other way too: a controller company is not an analytics company, and fleets often pair Elum-style control with an independent analytics layer on top.',
          },
        ],
      },
      {
        heading: 'Vendor portals: FusionSolar and iSolarCloud',
        blocks: [
          {
            type: 'paragraph',
            text: 'If every inverter you own is Huawei, FusionSolar is free, deep, and genuinely good, with string-level data and battery integration, and version 9.0 added AI features in December 2025. Sungrow’s iSolarCloud offers the same deal for Sungrow fleets, plus an IV-curve diagnosis feature and a developer API. The structural limits are the same for both: mixed-brand fleets get second-class support, analytics run on the vendor’s terms, and the portal that grades the vendor’s own hardware is never fully independent. Solar-Log fills the multi-brand gap at the logger level for smaller fleets, with claimed support for roughly 30 inverter brands.',
          },
        ],
      },
      {
        heading: 'The verdict, by situation',
        blocks: [
          {
            type: 'table',
            caption: 'Which platform to shortlist first, by fleet profile.',
            headers: ['Your situation', 'Shortlist first'],
            rows: [
              ['100+ utility assets, dedicated performance team', 'Power Factors Unity, PowerTrack, GPM Horizon'],
              ['Single-vendor fleet, basic monitoring is enough', 'FusionSolar or iSolarCloud, free with the hardware'],
              ['Mixed-brand C&I portfolio, no extra hardware wanted', 'NuraVolt or SmartHelio on top of existing data'],
              ['Soiling is the dominant loss (desert, dust corridors)', 'NuraVolt per-inverter soiling, stations as calibration'],
              ['Solar-diesel hybrid or microgrid needing active control', 'Elum Energy, analytics layered separately'],
              ['Installer managing many small mixed-brand sites', 'Solar-Log'],
            ],
          },
          {
            type: 'paragraph',
            text: 'Two of these categories stack rather than compete: a vendor portal or a control layer underneath, and an independent analytics layer on top. That is the most common 2026 architecture in C&I, because it keeps the free data collection while adding per-inverter economics the portals do not attempt.',
          },
        ],
      },
    ],
    faq: [
      {
        q: 'Why is there no pricing in this comparison?',
        a: 'Because none of the nine vendors publishes list pricing for these products as of July 2026. Vendor portals are effectively free with the hardware; everything else is quote-based. Any comparison page showing exact prices for these platforms is guessing.',
      },
      {
        q: 'Is a free vendor portal enough for a C&I fleet?',
        a: 'For a single-brand fleet that only needs alarms and production reporting, often yes. The gaps appear with mixed brands, per-inverter soiling economics, warranty-grade independent records, and portfolio benchmarking, which is where an independent layer earns its cost.',
      },
      {
        q: 'How should a buyer verify vendor accuracy claims?',
        a: 'Ask for the evaluation dataset and per-class results rather than a headline number. NuraVolt publishes its benchmarks on public datasets with per-class F1 scores for exactly this reason; apply the same standard to anyone on this list.',
      },
      {
        q: 'Which platform fits commercial self-consumption monitoring?',
        a: 'For a commercial building consuming its own solar, start with the inverter vendor portal, which handles self-consumption dashboards for its own hardware for free, and add Solar-Log where German-style feed-in management or mixed brands are involved. Layer an independent analytics platform like NuraVolt on top when the question shifts from how much am I producing to how much am I losing, since soiling, faults, and degradation eat self-consumption savings exactly as they eat export revenue.',
      },
    ],
    related: [
      { title: 'Best solar asset management software in 2026', href: '/compare/best-solar-asset-management-software-2026', description: 'The contracts-and-invoices side of the landscape.' },
      { title: 'Best BESS monitoring software in 2026', href: '/compare/best-bess-monitoring-software-2026', description: 'The battery storage side of the landscape.' },
      { title: 'Soiling stations vs software soiling monitoring', href: '/compare/soiling-sensors-vs-software', description: 'The hardware vs software decision in depth.' },
      { title: 'FusionSolar monitoring vs independent analytics', href: '/compare/huawei-fusionsolar-vs-independent-monitoring', description: 'When the free portal is enough and when it is not.' },
      { title: 'Can ML actually detect solar faults?', href: '/reports/ml-solar-fault-detection-benchmark', description: 'Our published accuracy numbers on public data.' },
      { title: 'How to monitor a C&I solar portfolio in 2026', href: '/insights/ci-solar-monitoring-guide-2026', description: 'The buying framework behind this list.' },
    ],
    sources: [
      'powerfactors.com/unity and Solar Power World, April 2026',
      'home.alsoenergy.com/powertrack and Stem press releases, 2024 to 2026',
      'greenpowermonitor.com and DNV press release, 2025',
      'smarthelio.com and PV Tech, June 2026',
      'elum-energy.com company documentation',
      'solar-log.com company documentation',
      'Huawei FusionSolar documentation and ESS News, December 2025',
      'Sungrow iSolarCloud documentation and press releases',
    ],
    datePublished: '2026-08-12',
    itemList: [
      { name: 'NuraVolt', url: 'https://nuravolt.com/' },
      { name: 'Power Factors Unity' },
      { name: 'AlsoEnergy PowerTrack (Stem)' },
      { name: 'GPM Horizon (DNV)' },
      { name: 'SmartHelio' },
      { name: 'Elum Energy' },
      { name: 'Solar-Log' },
      { name: 'Huawei FusionSolar' },
      { name: 'Sungrow iSolarCloud' },
    ],
  },
  {
    slug: 'soiling-sensors-vs-software',
    kind: 'category',
    title: 'Soiling stations vs software soiling monitoring (2026)',
    asOf: 'July 2026',
    intro:
      'Physical soiling stations measure one point precisely. Software estimates every inverter approximately. Which error matters more for your cleaning decisions?',
    quickAnswer:
      'Soiling stations give a measured ground truth at one point but cost hardware, water, maintenance, and site visits per unit, and IEA-PVPS warns soiling is too heterogeneous for single-point measurement. Software estimation derives per-inverter soiling from production data with no hardware, at lower precision per point. Large plants increasingly use both: stations as calibration, software for spatial coverage.',
    sections: [
      {
        heading: 'What each approach actually is',
        blocks: [
          {
            type: 'paragraph',
            text: 'A soiling station is dedicated hardware. The reference-cell type, such as Fracsun’s station (sold as NX Clario since Nextpower acquired Fracsun in November 2025), compares a daily-washed cell against a naturally soiling one. The optical type, such as Kipp and Zonen’s DustIQ, measures scattered light from dust on glass, needs no water, but requires local dust calibration for stated accuracy. Atonometrics’ RDE300 series uses a clean reference cell against a soiled reference module. All three now sit inside larger hardware groups after the November 2025 consolidation, when Nextpower bought Fracsun and DustIQ owner OTT HydroMet bought Atonometrics in the same week.',
          },
          {
            type: 'paragraph',
            text: 'Software soiling monitoring uses no added hardware. A physics model corrects each inverter’s output for weather, temperature, and curtailment; the residual, slowly-varying loss that rain resets is soiling. Because the estimate exists for every inverter, it produces a soiling map of the plant rather than a reading at one mast.',
          },
        ],
      },
      {
        heading: 'The comparison, dimension by dimension',
        blocks: [
          {
            type: 'table',
            caption: 'Stations vs software estimation, from vendor documentation and IEA-PVPS reports, July 2026.',
            headers: ['Dimension', 'Soiling stations', 'Software estimation'],
            rows: [
              ['What it measures', 'Actual soiling at one point, high precision', 'Estimated soiling at every inverter'],
              ['Spatial coverage', 'One point per unit; networks needed for large plants', 'Whole plant by construction'],
              ['Hardware and installation', 'Procurement, import, mounting, power, comms per unit', 'None'],
              ['Ongoing maintenance', 'Water refills, pumps, calibration, site visits (reference type)', 'None on site'],
              ['Retrofit to existing fleets', 'Per-site hardware project', 'Days, from existing data'],
              ['Bankability and IE acceptance', 'Established, measured record', 'Emerging; strongest when calibrated against a station'],
              ['Where it breaks', 'Unrepresentative placement, heterogeneous soiling', 'Sparse or poor-quality inverter data'],
            ],
          },
        ],
      },
      {
        heading: 'The single-point problem is documented, not a sales line',
        blocks: [
          {
            type: 'paragraph',
            text: 'IEA-PVPS Task 13, the industry reference on soiling, states that soiling does not occur homogeneously across a plant, that single-point short-circuit measurements can underestimate the real power impact, and that accounting for heterogeneity requires integrating multiple soiling monitors, an underestimated cost factor. Its 2025 fact sheet is more direct: soiling is highly heterogeneous at module and plant level and requires multi-sensor networks for accurate cleaning decisions, while sensors should ideally be maintenance free because many sites are unmanned. NREL adds that uncertainty grows with distance from the measurement point and nearby sites can soil differently. The same body estimates soiling now costs the industry 4 to 7 percent of global PV energy, a multi-billion-euro annual loss.',
          },
          {
            type: 'paragraph',
            text: 'That is the case for software estimation in one paragraph: it is the only approach whose spatial resolution matches the documented spatial variability of the problem, and it carries none of the per-unit maintenance burden the hardware guidance itself flags.',
          },
        ],
      },
      {
        heading: 'Where stations win, honestly',
        blocks: [
          {
            type: 'paragraph',
            text: 'A station measures; software infers. For resource assessment before construction, for bankability reports an independent engineer must sign, and for validating a cleaning contractor’s performance against a contractual soiling threshold, a measured instrument record carries weight a model does not. Reference stations with automated washing, like Fracsun’s, also remove most of the manual-cleaning labor that made older two-panel stations unpopular. If a lender requires a station, install the station.',
          },
          {
            type: 'paragraph',
            text: 'The practical 2026 answer for large plants is both: one or two stations as calibration anchors, software for the per-inverter map that decides which blocks get cleaned this week. For distributed C&I portfolios, where nobody will maintain a station per rooftop, software estimation is realistically the only option with full coverage.',
          },
        ],
      },
    ],
    faq: [
      {
        q: 'How accurate is software soiling estimation compared to a station?',
        a: 'At the single point where a station sits, the station is more precise. Across a plant, the station tells you nothing about the other blocks, and IEA-PVPS documents that the spatial variation is large. The fair comparison is one precise point versus an approximate map, and cleaning decisions need the map.',
      },
      {
        q: 'What do soiling stations cost?',
        a: 'No major vendor publishes list pricing as of July 2026; Fracsun, DustIQ, and Atonometrics units are all quote-only. Beyond purchase, budget for installation, communications, water logistics for washed-cell types, annual calibration, and site visits, which is the cost line IEA-PVPS calls underestimated once multiple units are needed.',
      },
      {
        q: 'Do rain and cleaning events confuse software estimation?',
        a: 'They are actually the signal’s anchor points: rain and cleaning reset the soiling level, and the model reads the recovery step. Sites with almost no production data history, or with meters that aggregate many inverters, are the genuinely hard cases.',
      },
    ],
    related: [
      { title: 'Fracsun alternative', href: '/compare/fracsun-alternative', description: 'The named-vendor version of this decision.' },
      { title: 'Soiling loss', href: '/faults/soiling-loss', description: 'How soiling appears in operational data.' },
      { title: 'Soiling loss: when is cleaning worth it?', href: '/insights/soiling-cleaning-economics', description: 'The economics after you can measure.' },
      { title: 'Solar monitoring in Saudi Arabia', href: '/solar-monitoring/saudi-arabia', description: 'The market where this decision is worth the most.' },
    ],
    sources: [
      'IEA-PVPS Task 13, Soiling Losses report T13-21:2022 and 2025 fact sheet',
      'NREL, spatial interpolation of soiling measurements (OSTI 1479873)',
      'fracsun.com product and FAQ documentation; Nextpower acquisition disclosure, November 2025',
      'Kipp & Zonen DustIQ product documentation and datasheet',
      'Atonometrics RDE300 documentation; OTT HydroMet acquisition announcement, November 2025',
    ],
    datePublished: '2026-07-11',
  },
  {
    slug: 'fracsun-alternative',
    kind: 'alternative',
    title: 'Fracsun alternative: sensorless soiling monitoring from inverter data',
    competitor: { name: 'Fracsun (Nextpower NX Clario)', website: 'https://www.fracsun.com' },
    asOf: 'July 2026',
    intro:
      'Fracsun’s station is the reference-cell benchmark for measured soiling. The alternative is not a different sensor, it is estimating soiling per inverter from data your plant already produces.',
    quickAnswer:
      'Fracsun (acquired by Nextpower in November 2025, station now sold as NX Clario) measures soiling precisely at one point per station, with hardware, water, and maintenance per unit. NuraVolt estimates soiling per inverter from production data with no hardware at all. Fleets choose software for spatial coverage and retrofit speed, stations for instrument-grade ground truth, and large plants increasingly combine both.',
    sections: [
      {
        heading: 'What Fracsun is, factually',
        blocks: [
          {
            type: 'paragraph',
            text: 'Fracsun’s station compares two identical reference cells, one washed automatically each day and one left to soil, and reports the difference as measured soiling loss. It installs in under an hour, runs self-powered with cellular backhaul, and its published maintenance cadence includes annual water refills, a pump replacement around year five, and annual calibration. As of mid 2024 the network spanned 27 countries and over 12 GW of monitored capacity, and its CLEO model adds AI soiling simulation from weather and particulate data. In November 2025 Nextpower, the tracker manufacturer formerly known as Nextracker, acquired Fracsun outright, and the station is now marketed as NX Clario. Pricing is quote-only; no list price is public.',
          },
        ],
      },
      {
        heading: 'Where Fracsun wins',
        blocks: [
          {
            type: 'list',
            items: [
              'Measured, not modeled: a washed-versus-soiled cell pair is physical ground truth, which independent engineers and lenders accept for bankability and resource assessment.',
              'Automated washing removes the manual-cleaning labor that made older soiling stations unpopular.',
              'Backing of the largest tracker OEM, with integration ambitions toward robotic cleaning.',
              'A published, credible maintenance and calibration regime rather than a black box.',
            ],
          },
        ],
      },
      {
        heading: 'Where the sensorless approach wins',
        blocks: [
          {
            type: 'table',
            caption: 'Station vs sensorless estimation for the soiling job, July 2026.',
            headers: ['Dimension', 'Fracsun / NX Clario station', 'NuraVolt sensorless estimation'],
            rows: [
              ['Coverage', 'One measured point per station', 'Every inverter in the fleet'],
              ['Hardware', 'Station, mounting, comms, water per unit', 'None'],
              ['Deployment', 'Procurement and installation per site', 'Days, from existing inverter or SCADA data'],
              ['Maintenance', 'Water, pump, battery, annual calibration', 'None on site'],
              ['Distributed C&I portfolios', 'Rarely economic per rooftop', 'Same pipeline as a single big plant'],
              ['Bankability record', 'Established instrument standard', 'Emerging; calibrates against stations where present'],
            ],
          },
          {
            type: 'paragraph',
            text: 'The structural argument comes from the industry’s own reference reports: IEA-PVPS documents that soiling is heterogeneous across a plant, that single-point measurements can misstate the real power impact, and that proper coverage needs a network of monitors whose cost is routinely underestimated. Per-inverter estimation is the only approach whose resolution matches that documented variability, and it reaches sites, like a 40-roof C&I portfolio, where nobody will ever install and water a station per roof.',
          },
        ],
      },
      {
        heading: 'The honest decision rule',
        blocks: [
          {
            type: 'paragraph',
            text: 'If a lender or independent engineer requires an instrument record, or you are doing pre-construction resource assessment, buy the station; that is what it is for. If the job is operational, deciding which blocks or sites to clean this week and quantifying what soiling costs the portfolio, sensorless per-inverter estimation covers the whole fleet for less than the maintenance line of a station network. On large desert plants the strongest setup is both: NuraVolt calibrated against one or two stations, software providing the block-level ranking between station readings.',
          },
        ],
      },
    ],
    faq: [
      {
        q: 'Is NuraVolt a drop-in replacement for a Fracsun station?',
        a: 'For operational cleaning decisions, yes, and with per-inverter rather than single-point resolution. For bankability reports that require a physical instrument record, no; keep or add a station for that role and use the software for coverage.',
      },
      {
        q: 'What data does sensorless soiling estimation need?',
        a: 'Per-inverter AC power plus irradiance and temperature, which is standard in inverter vendor APIs and SCADA. A historical backfill covering at least one rain or cleaning cycle sharpens the estimate.',
      },
      {
        q: 'What happened to Fracsun as a company?',
        a: 'Nextpower, formerly Nextracker, acquired Fracsun in November 2025. The ARES station is now sold as NX Clario, and the product line sits inside a tracker hardware group. CLEO’s future branding as a standalone product has not been detailed publicly.',
      },
    ],
    related: [
      { title: 'Soiling stations vs software soiling monitoring', href: '/compare/soiling-sensors-vs-software', description: 'The full category comparison with IEA-PVPS evidence.' },
      { title: 'Soiling loss', href: '/faults/soiling-loss', description: 'How soiling is detected from operational data.' },
      { title: 'Soiling loss: when is cleaning worth it?', href: '/insights/soiling-cleaning-economics', description: 'Turning measurement into a cleaning decision.' },
      { title: 'Can ML actually detect solar faults?', href: '/reports/ml-solar-fault-detection-benchmark', description: 'Our published model accuracy on public data.' },
    ],
    sources: [
      'fracsun.com product pages and FAQ, accessed July 2026',
      'Nextpower FY2026 Q3 10-Q (SEC) and Nextpower NX Clario announcement, November 2025',
      'Fracsun CLEO AI press release, July 2024',
      'US DOE EERE success story on Fracsun',
      'IEA-PVPS Task 13 soiling reports, 2022 and 2025',
    ],
    datePublished: '2026-07-11',
  },
  {
    slug: 'huawei-fusionsolar-vs-independent-monitoring',
    kind: 'category',
    title: 'FusionSolar monitoring vs independent analytics (2026)',
    competitor: { name: 'Huawei FusionSolar', website: 'https://solar.huawei.com' },
    asOf: 'July 2026',
    intro:
      'FusionSolar monitoring is free, deep, and everywhere Huawei inverters are. The question is not whether to use it, it is what to run on top of it.',
    quickAnswer:
      'FusionSolar monitoring, Huawei’s own portal, is genuinely good and effectively free for all-Huawei fleets, with string-level data and battery integration. Its structural limits are single-vendor scope, constrained data export and APIs, and the fact that a vendor portal grading the vendor’s own hardware is not independent. Mixed fleets and operators needing per-inverter soiling, warranty evidence, or AI workflows layer independent analytics on top, usually while keeping FusionSolar underneath.',
    sections: [
      {
        heading: 'What FusionSolar does well',
        blocks: [
          {
            type: 'paragraph',
            text: 'For plants built on Huawei inverters, FusionSolar comes with the hardware at no recurring cost in most regions and covers residential through utility scale. Data granularity reaches string level, LUNA2000 batteries integrate natively, and the December 2025 FusionSolar 9.0 release added AI features and grid-forming support. If your entire fleet is Huawei and your needs end at alarms, dashboards, and production reports, it is hard to argue with free.',
          },
        ],
      },
      {
        heading: 'The structural limits',
        blocks: [
          {
            type: 'table',
            caption: 'FusionSolar vs an independent analytics layer, from Huawei documentation, July 2026.',
            headers: ['Dimension', 'FusionSolar', 'Independent layer (e.g. NuraVolt)'],
            rows: [
              ['Cost', 'Effectively free with Huawei hardware', 'Paid subscription'],
              ['Mixed-brand fleets', 'Third-party inverters get reduced, sometimes site-level-only support', 'Vendor-neutral by design'],
              ['Data access', 'CSV export varies by region; limited automated interfaces; only specific dongles forward data', 'Open API access to your own results'],
              ['Independence', 'The vendor grades its own hardware', 'Analytics independent of any hardware warranty position'],
              ['Per-inverter soiling economics', 'Not a headline capability', 'Core capability, physics-corrected per inverter'],
              ['AI assistant access', 'Portal only', 'MCP server: query the fleet from Claude, ChatGPT, Cursor'],
            ],
          },
          {
            type: 'paragraph',
            text: 'The independence point is not hypothetical. When an inverter underperforms inside its warranty period, the record you bring to Huawei is, by default, Huawei’s own portal data processed by Huawei’s own analytics. An independent computation of the same plant’s performance, from the raw telemetry, is a stronger negotiating position, exactly as it is with BESS warranty claims.',
          },
        ],
      },
      {
        heading: 'Keep FusionSolar, add analytics on top',
        blocks: [
          {
            type: 'paragraph',
            text: 'This is not a rip-and-replace decision. NuraVolt reads Huawei fleets through the vendor API, so FusionSolar keeps doing what it is good at, data collection and device management, while the analytics layer adds what it does not attempt: per-inverter soiling estimation, digital-twin fault detection benchmarked on public data, cross-vendor portfolio ranking when Sungrow or SMA sites join the fleet, and an MCP server that puts the whole thing inside your team’s AI assistant. The stack costs the subscription, not a migration.',
          },
        ],
      },
    ],
    faq: [
      {
        q: 'Should a small all-Huawei fleet pay for independent monitoring?',
        a: 'If alarms and production reports are all you need, no, FusionSolar is free and covers that. The upgrade pays for itself when soiling and fault economics per inverter start mattering, when the fleet mixes brands, or when you need an independent record for warranty or PPA purposes.',
      },
      {
        q: 'Does NuraVolt replace the FusionSolar portal?',
        a: 'No. It reads the same fleet through the Huawei API and runs independent analytics on top. Operators typically keep FusionSolar for device management and use NuraVolt for economics, fault triage, and portfolio views.',
      },
      {
        q: 'What are FusionSolar’s data export options?',
        a: 'Per Huawei’s own documentation as of July 2026: CSV export availability varies by system and region, automated interfaces are limited, and only specific SDongle models can forward data to a third-party management system. Plan integrations around the northbound API rather than ad-hoc exports.',
      },
    ],
    related: [
      { title: 'Huawei SUN2000 integration', href: '/integrations/huawei', description: 'How NuraVolt reads Huawei fleets.' },
      { title: 'Best solar monitoring software in 2026', href: '/compare/best-solar-monitoring-software-2026', description: 'Where vendor portals fit in the full landscape.' },
      { title: 'How to monitor a C&I solar portfolio in 2026', href: '/insights/ci-solar-monitoring-guide-2026', description: 'The layered architecture in practice.' },
      { title: 'Why warranty disputes are won or lost in SCADA data', href: '/insights/warranty-disputes-scada-data', description: 'Why an independent record matters.' },
    ],
    sources: [
      'Huawei FusionSolar product documentation and third-party connection guide (support.huawei.com), accessed July 2026',
      'solar-display.com FusionSolar functions overview',
      'ESS News, FusionSolar 9.0 launch, December 2025',
    ],
    datePublished: '2026-07-11',
  },
  {
    slug: 'smarthelio-alternative',
    kind: 'alternative',
    title: 'SmartHelio alternative for solar AI analytics (2026)',
    competitor: { name: 'SmartHelio', website: 'https://smarthelio.com' },
    asOf: 'July 2026',
    intro:
      'SmartHelio is a strong predictive-maintenance platform. If you are shopping for an alternative, it is usually because your dominant losses are soiling or storage, or because you want accuracy claims you can verify.',
    quickAnswer:
      'SmartHelio, from Switzerland, is an enterprise predictive-maintenance platform with a roster including Shell and Tata Power and a claimed 8+ GW supported. The main software-only alternative with a different center of gravity is NuraVolt: per-inverter soiling economics, BESS health analytics, published public-data benchmarks, and an MCP server for AI assistants. Both run on data the fleet already produces with no added hardware, so the choice comes down to whether your losses are component failures or soiling and storage.',
    sections: [
      {
        heading: 'Where the two overlap',
        blocks: [
          {
            type: 'paragraph',
            text: 'The category is the same: software-only analytics deployed on existing SCADA and inverter data, building models of expected behaviour and flagging the gap. Neither requires new hardware, both target C&I and utility fleets, and neither publishes list pricing as of July 2026. If you are comparing either against buying more sensors, read the soiling stations comparison first; the software-only argument is shared.',
          },
        ],
      },
      {
        heading: 'Where they differ',
        blocks: [
          {
            type: 'table',
            caption: 'Differences by focus, from public materials of both companies, July 2026.',
            headers: ['Dimension', 'SmartHelio', 'NuraVolt'],
            rows: [
              ['Center of gravity', 'Predictive maintenance and failure prediction', 'Per-inverter soiling economics, fault detection, BESS health'],
              ['Scale claims', '8+ GW supported (June 2026)', 'Younger platform; benchmarks published instead of GW claims'],
              ['Enterprise roster', 'Shell, Dominion, ENEOS, Tata Power, others', 'C&I and utility operators in EMEA'],
              ['Accuracy transparency', 'Company-stated accuracy claims', 'Open benchmarks on public datasets with per-class results'],
              ['BESS analytics', 'Not the headline focus', 'SoH, warranty evidence, augmentation planning as a product line'],
              ['AI direction', 'GAIA agent automating monitoring workflows', 'MCP server putting fleet data inside Claude, ChatGPT, Cursor'],
            ],
          },
        ],
      },
      {
        heading: 'Where SmartHelio wins',
        blocks: [
          {
            type: 'paragraph',
            text: 'Track record and enterprise depth. SmartHelio has run predictive maintenance for global IPPs and industrials for years, closed new investment in June 2026 to expand into MENA, and its GAIA agent claims to automate up to 90 percent of daily monitoring and reporting activity. A large asset owner standardizing predictive maintenance across continents will find more reference customers at SmartHelio today.',
          },
        ],
      },
      {
        heading: 'Where NuraVolt wins',
        blocks: [
          {
            type: 'paragraph',
            text: 'Verifiability and the soiling-plus-storage problem. NuraVolt publishes its model accuracy as open benchmarks on public datasets, per class and per horizon, so a buyer can check the numbers rather than trust a deck. Its soiling estimation is per inverter after digital-twin correction, aimed at the cleaning decision itself, and its BESS line covers SoH evidence, warranty claims, and augmentation. The MCP server is a different bet than an in-product agent: instead of automating inside our portal, it makes the fleet queryable from whatever assistant your team already uses.',
          },
        ],
      },
    ],
    faq: [
      {
        q: 'Which is better for a desert or high-soiling portfolio?',
        a: 'Per-inverter soiling economics is NuraVolt’s core capability and not SmartHelio’s headline. For portfolios where dust is the dominant recoverable loss, that focus is the difference; for portfolios where component failure risk dominates, SmartHelio’s predictive maintenance depth argues the other way.',
      },
      {
        q: 'Do either require new hardware?',
        a: 'No. Both are software-only and explicitly market deployment on existing data. That makes the evaluation cheap: both can be trialed on historical data without touching the plant.',
      },
      {
        q: 'How should accuracy claims from either vendor be judged?',
        a: 'Ask for per-class results on a named dataset. NuraVolt publishes exactly that on public data, including the classes where models struggle. Apply the same bar to SmartHelio’s stated accuracy figures, which are company claims without published per-class breakdowns as of July 2026.',
      },
    ],
    related: [
      { title: 'Can ML actually detect solar faults?', href: '/reports/ml-solar-fault-detection-benchmark', description: 'The published benchmark referenced above.' },
      { title: 'Best solar monitoring software in 2026', href: '/compare/best-solar-monitoring-software-2026', description: 'Both platforms in the wider landscape.' },
      { title: 'BESS health monitoring in 2026', href: '/insights/bess-health-monitoring-2026', description: 'The storage analytics side of the comparison.' },
      { title: 'AI assistants for solar operations in 2026', href: '/insights/ai-assistants-solar-operations-2026', description: 'The MCP bet explained.' },
    ],
    sources: [
      'smarthelio.com product pages, accessed July 2026',
      'PV Tech, SmartHelio investment and GAIA launch, June 2026',
      'SmartHelio funding announcements, company site',
      'NuraVolt public-data benchmark, July 2026',
    ],
    datePublished: '2026-08-12',
  },
  {
    slug: 'elum-energy-alternative',
    kind: 'alternative',
    title: 'Elum Energy alternative for C&I solar analytics (2026)',
    competitor: { name: 'Elum Energy', website: 'https://elum-energy.com' },
    asOf: 'July 2026',
    intro:
      'Elum owns the solar-diesel hybrid control niche across Africa and MENA. Whether you need an alternative depends on whether your problem is control or analytics.',
    quickAnswer:
      'Elum Energy sells on-site ePowerControl controllers plus ePowerMonitor cloud SCADA, with 2,800+ plants in 90+ countries and a strong Africa and MENA footprint. If you need active hybrid or zero-export control, Elum is the category leader, not something to replace. If you need deeper analytics, per-inverter soiling, fault economics, BESS health, a software-only layer like NuraVolt is the alternative or the complement on top.',
    sections: [
      {
        heading: 'What Elum is, factually',
        blocks: [
          {
            type: 'paragraph',
            text: 'Elum Energy, founded in Paris in 2016 with an office in Casablanca, makes plant controllers and cloud SCADA. The ePowerControl family handles solar-diesel hybrid coordination, microgrids, zero-export constraints, storage, and utility power plant control; ePowerMonitor is the cloud monitoring layer. The company reports more than 2,800 plants across 90+ countries, raised a 13 million dollar Series B in 2024, and its reference projects run from 1.2 MWp C&I sites in South Africa to 35 MWp utility plants in Angola. Pricing is quote-based.',
          },
        ],
      },
      {
        heading: 'Where Elum wins',
        blocks: [
          {
            type: 'list',
            items: [
              'Active control: genset coordination, zero-export enforcement, and microgrid management are controller jobs. Analytics software does not do them.',
              'The Africa and MENA hybrid niche: local presence and years of references in exactly the markets where solar runs against diesel.',
              'One vendor for the site package: controller hardware, commissioning tooling, and cloud SCADA together.',
            ],
          },
        ],
      },
      {
        heading: 'Where the analytics layer wins',
        blocks: [
          {
            type: 'table',
            caption: 'Control platform vs analytics platform, July 2026.',
            headers: ['Dimension', 'Elum Energy', 'NuraVolt'],
            rows: [
              ['Core job', 'Real-time plant and hybrid control', 'Performance economics: soiling, faults, BESS health'],
              ['Hardware', 'On-site controller per plant', 'None; reads existing data sources'],
              ['Per-inverter soiling estimation', 'Not a headline capability', 'Core capability, physics-corrected'],
              ['Fault detection accuracy', 'Not published', 'Published benchmarks on public datasets'],
              ['BESS health and warranty analytics', 'Storage control focus', 'SoH evidence, warranty claims, augmentation planning'],
              ['Retrofit without site visit', 'Controller installation required', 'Remote onboarding from APIs and exports'],
            ],
          },
          {
            type: 'paragraph',
            text: 'The two are more complementary than competitive. An Elum controller decides, second by second, whether the genset or the array serves the load. It does not tell you that inverter 7 has been drifting 4 percent below its twin for three weeks, or that the site’s soiling loss now justifies a clean. Fleets in Nairobi or Lagos increasingly run both: control at the site, analytics across the portfolio, with the analytics layer reading whatever the controllers and inverters already report.',
          },
        ],
      },
    ],
    faq: [
      {
        q: 'Is NuraVolt a replacement for an Elum controller?',
        a: 'No. Controllers do real-time control; NuraVolt does analytics. The honest framing is alternative for the monitoring and analytics budget, complement for the site as a whole.',
      },
      {
        q: 'Can NuraVolt monitor hybrid solar-diesel sites?',
        a: 'Yes, from the PV and storage data the site already produces via inverter APIs, loggers, or exports. The analytics isolate solar performance regardless of what the genset is doing.',
      },
      {
        q: 'Why consider a second platform in cost-sensitive African C&I markets?',
        a: 'Because the replacement cost of lost solar energy in generator-backed markets is diesel at several times the grid price, which makes undetected soiling and faults unusually expensive. The analytics that find those losses pay back faster in Lagos than in London.',
      },
    ],
    related: [
      { title: 'Solar monitoring in Kenya', href: '/solar-monitoring/kenya', description: 'The captive C&I market where this choice comes up.' },
      { title: 'Solar monitoring in Nigeria', href: '/solar-monitoring/nigeria', description: 'Diesel economics and the June 2026 net billing regime.' },
      { title: 'Solar monitoring in South Africa', href: '/solar-monitoring/south-africa', description: 'The 8 GW fleet built during load shedding.' },
      { title: 'Best solar monitoring software in 2026', href: '/compare/best-solar-monitoring-software-2026', description: 'Where hybrid control fits the wider landscape.' },
    ],
    sources: [
      'elum-energy.com product and reference pages, accessed July 2026',
      'Elum Energy funding history (Series B 2024, growth round 2025), public reporting',
      'World Bank, cost of self-generated power analysis',
    ],
    datePublished: '2026-07-11',
  },
  {
    slug: 'best-solar-asset-management-software-2026',
    kind: 'listicle',
    title: 'Best solar asset management software in 2026: 6 platforms compared',
    asOf: 'August 2026',
    intro:
      'Asset management is not monitoring. It is contracts, invoices, obligations, portfolio reporting, and the technical work that keeps a plant earning for 25 to 35 years. Six platforms, compared honestly by what they actually cover.',
    quickAnswer:
      'For giga-scale IPP portfolios, Power Factors Unity and Stem PowerTrack are the enterprise asset management suites, both built through acquisition and both quote-priced. Raptor Maps owns the aerial-inspection-driven technical side, Clir the owner and investor analytics layer, and Alectris ACTIS the solar-ERP niche for mid-size portfolios. NuraVolt is monitoring-first with O&M ticketing and contract-obligation tracking on top, and is the only one on this list with public pricing.',
    sections: [
      {
        heading: 'How this list works',
        blocks: [
          {
            type: 'paragraph',
            text: 'This comparison is published by NuraVolt, so we are on our own list. Every claim about another platform comes from that vendor’s public documentation, press releases, or investor filings as of August 2026, each platform’s genuine strengths are stated plainly, and we say clearly what NuraVolt does not do. None of the enterprise vendors publishes pricing, so we say so instead of guessing.',
          },
        ],
      },
      {
        heading: 'Asset management vs monitoring: the industry definition',
        blocks: [
          {
            type: 'paragraph',
            text: 'SolarPower Europe’s Asset Management Best Practice Guidelines define the discipline as financial and commercial management, technical asset management, and data management across the project lifecycle, distinct from both O&M and monitoring. In practice the software market splits the same way: monitoring platforms watch the plant, asset management platforms watch the business built on the plant. The context is enormous: per SolarPower Europe’s Global Market Outlook, the world added a record 664 GW of solar in 2025, taking cumulative capacity to 3 TW, and every gigawatt becomes an operating asset someone must manage for decades.',
          },
        ],
      },
      {
        heading: 'The six platforms at a glance',
        blocks: [
          {
            type: 'table',
            caption: 'Categories and typical fits, from public vendor documentation and press, August 2026.',
            headers: ['Platform', 'Category', 'Best for', 'Standout fact'],
            rows: [
              ['Power Factors Unity', 'Enterprise asset management suite', 'Large IPPs and funds across solar, wind, BESS', 'Built by rolling up Greenbyte, 3megawatt BluePoint, and Inaccess; Unity REMI AI launched April 2026 on data from 310 GW of assets'],
              ['Stem PowerTrack', 'Monitoring plus asset performance management', 'Solar plus storage portfolios, strong C&I roots', 'Former AlsoEnergy, acquired by Stem for 695 million dollars; PowerTrack APM launched September 2024; about 36 GW solar under management'],
              ['Raptor Maps (Raptor Solar)', 'Aerial-inspection-driven technical asset management', 'Finding and remediating underperformance at scale', '150+ GW digitized across 50+ countries; 35 million dollar Series C in December 2024'],
              ['Clir Renewables', 'Owner and investor analytics layer', 'Infrastructure funds and asset owners needing benchmarked reporting', 'Benchmarks portfolios against 200+ GW of industry data'],
              ['Alectris ACTIS', 'Solar ERP: monitoring, service, and financials in one', 'Mid-size portfolios wanting one integrated system', 'Markets itself as the first solar ERP; software plus O&M services company'],
              ['NuraVolt', 'AI monitoring and analytics with O&M and contract tracking', 'C&I and utility fleets wanting per-inverter analytics plus obligation tracking', 'Published public-data benchmarks; the only platform here with public pricing'],
            ],
          },
        ],
      },
      {
        heading: 'The enterprise suites: Unity and PowerTrack',
        blocks: [
          {
            type: 'paragraph',
            text: 'Both category leaders were built by acquisition. Power Factors, owned by Vista Equity Partners since 2021, rolled Greenbyte, 3megawatt BluePoint, and Inaccess into the Unity platform: SCADA and monitoring, technical asset management, and the commercial module inherited from BluePoint covering contracts and invoice management. It claims 600+ customers across 25+ markets. Stem acquired AlsoEnergy for 695 million dollars in a deal completed February 2022 and now runs the product as PowerTrack, with the PowerTrack APM suite bridging technical and commercial operations for solar plus storage. Buyers should note Stem’s 2024 to 2025 restructuring toward software, which the company credits for its first full year of positive adjusted EBITDA in 2025. Both are procurement-grade purchases with enterprise sales cycles and no public pricing.',
          },
        ],
      },
      {
        heading: 'The specialists: Raptor Maps, Clir, ACTIS',
        blocks: [
          {
            type: 'paragraph',
            text: 'Raptor Maps approaches asset management from inspection: drone thermography, equipment records, and a map-based digital twin of every site, with anomalies priced by financial impact and routed into remediation workflows. It complements rather than replaces monitoring. Clir sits on the other end: an analytics and reporting layer for owners and investors, benchmarking wind, solar, and BESS portfolios against 200+ GW of industry data, with no SCADA and no invoicing. Alectris ACTIS is the ERP play: monitoring, service management, and asset management financials in one system, from a Greek company that is also an O&M services provider, which suits mid-size European and Middle East portfolios more than giga-scale IPPs.',
          },
        ],
      },
      {
        heading: 'Where NuraVolt fits, and where it does not',
        blocks: [
          {
            type: 'paragraph',
            text: 'NuraVolt is not a financial asset management suite: it does not do invoicing, billing reconciliation, or fund-level financial consolidation. What it covers is the technical and contractual side: per-inverter soiling and fault analytics on existing data, O&M ticketing with validation workflow, and contract intelligence that tracks PPA, warranty, and SLA obligations against measured plant data, so a guarantee breach shows up as an alert with evidence rather than a year-end surprise. For teams whose asset management pain is proving underperformance, warranty standing, and obligation compliance, that is the core of the job. For fund-level financial operations, pair it with one of the suites above. Pricing is public, which no other platform on this list offers.',
          },
        ],
      },
      {
        heading: 'The verdict, by situation',
        blocks: [
          {
            type: 'table',
            caption: 'Which platform to shortlist first, by portfolio profile.',
            headers: ['Your situation', 'Shortlist first'],
            rows: [
              ['Multi-GW IPP or fund, full commercial stack needed', 'Power Factors Unity, Stem PowerTrack'],
              ['Solar plus storage portfolio with C&I roots', 'Stem PowerTrack'],
              ['Underperformance hunting across a large fleet', 'Raptor Maps, with monitoring underneath'],
              ['Investor-grade benchmarked reporting', 'Clir'],
              ['Mid-size portfolio wanting one integrated ERP', 'Alectris ACTIS'],
              ['C&I or utility fleet: analytics, tickets, obligation tracking', 'NuraVolt'],
            ],
          },
        ],
      },
    ],
    faq: [
      {
        q: 'What is the difference between solar asset management and solar monitoring software?',
        a: 'Monitoring software watches plant performance in real time: production, alarms, availability. Asset management software manages the business around the plant: contracts, invoices, obligations, compliance, and portfolio reporting. SolarPower Europe’s best-practice guidelines treat them as distinct disciplines, and most operators run one of each, or a platform that spans both.',
      },
      {
        q: 'Why is there no pricing in this comparison?',
        a: 'Because none of the enterprise vendors publishes pricing for these products as of August 2026: Unity, PowerTrack, Raptor Solar, Clir, and ACTIS are all quote-based. NuraVolt publishes its pricing publicly, which is why it is the exception noted in the table.',
      },
      {
        q: 'Do I need both an asset management platform and a monitoring platform?',
        a: 'Large portfolios usually do, or they buy a suite that includes both. The common 2026 architecture is a monitoring or SCADA layer feeding an asset management layer. Smaller C&I portfolios often start with monitoring plus ticketing and add financial tooling only when the portfolio or its investors demand it.',
      },
    ],
    related: [
      { title: 'Best solar monitoring software in 2026', href: '/compare/best-solar-monitoring-software-2026', description: 'The monitoring side of this landscape.' },
      { title: 'How to monitor a C&I solar portfolio in 2026', href: '/insights/ci-solar-monitoring-guide-2026', description: 'The layered architecture in practice.' },
      { title: 'Why warranty disputes are won or lost in SCADA data', href: '/insights/warranty-disputes-scada-data', description: 'The evidence side of obligation tracking.' },
      { title: 'PPA performance guarantees explained', href: '/insights/ppa-performance-guarantees', description: 'The contract terms an asset manager tracks.' },
    ],
    sources: [
      'Stem investor releases and Businesswire, AlsoEnergy acquisition 2021 to PowerTrack APM 2024, FY2025 results',
      'powerfactors.com Unity documentation; PRNewswire Unity REMI launch, April 2026; Vista Equity Partners acquisition, 2021',
      'Solar Power World and pv-tech.org, Power Factors acquisitions of Greenbyte and 3megawatt, 2021',
      'raptormaps.com and PRNewswire Series C announcement, December 2024',
      'clir.eco portfolio and news pages, accessed August 2026',
      'actiserp.com and alectris.com company documentation',
      'SolarPower Europe, Asset Management Best Practice Guidelines and Global Market Outlook 2026 to 2030',
    ],
    datePublished: '2026-08-12',
    itemList: [
      { name: 'Power Factors Unity' },
      { name: 'Stem PowerTrack' },
      { name: 'Raptor Maps Raptor Solar' },
      { name: 'Clir Renewables' },
      { name: 'Alectris ACTIS' },
      { name: 'NuraVolt', url: 'https://nuravolt.com/' },
    ],
  },
  {
    slug: 'best-bess-monitoring-software-2026',
    kind: 'listicle',
    title: 'Best BESS monitoring software in 2026: 7 platforms compared',
    asOf: 'August 2026',
    intro:
      'Battery storage monitoring splits into three different products that get shopped as one: battery-science analytics on telemetry, operations platforms with BESS modules, and market revenue analytics. Seven platforms, sorted honestly by which problem each one solves.',
    quickAnswer:
      'There is no single best BESS monitoring software in 2026 because the category is really three. For battery-science analytics on BMS telemetry, the leaders are TWAICE, ACCURE, Elysia with Zitara, and PowerUp. For operations platforms with storage modules, Power Factors Unity claims 34+ GWh of BESS under management. For market revenue benchmarking, Modo Energy is the FCA-regulated reference. NuraVolt covers warranty, cycling, and revenue intelligence built from contract terms and published market prices, attaching to telemetry as it is connected.',
    sections: [
      {
        heading: 'How this list works',
        blocks: [
          {
            type: 'paragraph',
            text: 'This comparison is published by NuraVolt, so we are on our own list. Every claim about another platform comes from that vendor’s public documentation, press releases, or published research as of August 2026, and the verdict is framed per use case rather than as a ranking with ourselves on top. Only one vendor on this list publishes any self-serve pricing tier, so we say so instead of guessing numbers.',
          },
        ],
      },
      {
        heading: 'Why BESS monitoring became its own discipline',
        blocks: [
          {
            type: 'paragraph',
            text: 'The numbers argue operations, not cell quality, is where storage value is won or lost. EPRI’s failure incident database shows BESS failure rates fell roughly 97 percent between 2018 and 2023, and its root-cause analysis attributes 65 percent of classifiable incidents to operation and integration against only 11 percent from cell or module defects. ACCURE’s 2025 fleet report across 18+ GWh found 19 percent of hardware components caused operational problems, only 83 percent of projects met nameplate capacity at site acceptance, and state-of-charge errors of plus or minus 15 percent are common in LFP systems. Modo Energy’s GB research measured average fleet degradation around 4.4 percent after 365 cycles, with some systems up to 11 percent. None of that is visible from a generation dashboard, which is why battery-specific analytics exist.',
          },
        ],
      },
      {
        heading: 'The seven platforms at a glance',
        blocks: [
          {
            type: 'table',
            caption: 'Categories and typical fits, from public vendor documentation and press, August 2026.',
            headers: ['Platform', 'Category', 'Best for', 'Standout fact'],
            rows: [
              ['TWAICE', 'Battery analytics on telemetry', 'Owner-operators tracking SoH and warranty across mixed fleets', 'Warranty tracker tied to 50+ KPIs; 24 million euro EIB financing, February 2026'],
              ['ACCURE', 'Battery analytics on telemetry', 'Safety-first operators and utilities', 'Monitors 20+ safety anomaly types; publishes an annual fleet report covering 18+ GWh'],
              ['Elysia + Zitara (Fortescue)', 'Cloud analytics plus embedded edge software', 'Large BESS needing validated SoC and SoH at cell level, on site', 'Zitara acquisition announced January 2026 pairs cloud analytics with on-premises battery software'],
              ['PowerUp (Socomec)', 'Battery analytics on telemetry', 'Operators hunting imbalance and HVAC risk', 'Claims correcting imbalance can recover 10 to 20 percent of capacity; CEA-Liten spin-out'],
              ['Power Factors Unity', 'Operations platform with BESS module', 'Utility-scale portfolios running solar, wind, and storage in one APM', 'Claims 34+ GWh of BESS under management'],
              ['Modo Energy', 'Market revenue analytics', 'Investors and asset managers benchmarking revenue, not telemetry', 'FCA-regulated benchmark provider for GB, ERCOT, Australia, Germany'],
              ['NuraVolt BESS', 'Warranty, cycling, and revenue intelligence', 'Operators wanting contract-aware analytics before and after telemetry hookup', 'Three-lane revenue ledger: measured, declared, and benchmark, never summed'],
            ],
          },
        ],
      },
      {
        heading: 'Battery-science analytics: TWAICE, ACCURE, Elysia, PowerUp',
        blocks: [
          {
            type: 'paragraph',
            text: 'These four run physics and machine-learning models over BMS telemetry. TWAICE, from Munich, centers on SoH and a warranty tracker that alerts before contract thresholds are crossed, and claims an average 5 percent improvement in recoverable energy across deployments. ACCURE, from Aachen, leads with safety: continuous screening for 20+ anomaly types aimed at preventing thermal runaway, plus health and performance analytics, published annually as a fleet benchmark. Elysia, Fortescue’s battery intelligence arm, acquired Zitara in January 2026 to pair its cloud analytics with embedded software that computes validated SoC, SoH, and predictive power limits on site at cell level. PowerUp, a French CEA-Liten spin-out now backed by Socomec, specializes in imbalance and early risk detection, reporting that 75 percent of BESS sites show early HVAC-related risk signals. All four need an operational telemetry feed, and none publishes pricing.',
          },
        ],
      },
      {
        heading: 'Operations platforms and market analytics: Unity and Modo',
        blocks: [
          {
            type: 'paragraph',
            text: 'Power Factors Unity treats BESS as one asset class inside an enterprise asset performance management platform: real-time monitoring and dispatch, compliance workflows, and hybrid portfolio views, with a claimed 34+ GWh of storage under management. It is the fit when storage lives inside a larger renewables portfolio and the buyer wants one platform. Modo Energy is a different product entirely: revenue benchmarking and forecasting built from market and settlement data, not plant telemetry, and the self-described only FCA-regulated benchmark administrator for battery storage. Asset managers use Modo to know what their battery should have earned; it will not tell you a rack is drifting. Modo is also the only platform on this list with a public self-serve free tier.',
          },
        ],
      },
      {
        heading: 'Where NuraVolt BESS fits, stated honestly',
        blocks: [
          {
            type: 'paragraph',
            text: 'NuraVolt approaches storage from the contract and the market rather than from the cell. The engine runs ASTM rainflow cycle counting, chemistry-aware degradation and warranty tracking, sub-asset imbalance screening, and a perfect-foresight arbitrage audit against published day-ahead prices, with GB settled half-hourly and Iberia hourly. Revenue is kept as a three-lane ledger, measured, declared, and benchmark, which are never summed, so a modelled number can never impersonate a metered one. Where no BMS feed is connected yet, every figure is computed from real algorithms over real published prices against the declared nameplate and is tagged provisional; connecting telemetry upgrades the same views to measured. That makes it useful from day one of an evaluation, and honest about which numbers are which, but a plant that needs cell-level safety screening today should look at the battery-science four above.',
          },
        ],
      },
      {
        heading: 'The verdict, by situation',
        blocks: [
          {
            type: 'table',
            caption: 'Which platform to shortlist first, by need.',
            headers: ['Your situation', 'Shortlist first'],
            rows: [
              ['Warranty exposure across a mixed-OEM fleet', 'TWAICE, NuraVolt'],
              ['Safety and thermal-runaway risk is the board question', 'ACCURE, Elysia + Zitara'],
              ['Rack imbalance and balance-of-plant issues suspected', 'PowerUp, ACCURE'],
              ['Storage inside a large multi-technology portfolio', 'Power Factors Unity'],
              ['Benchmarking revenue for finance or refinancing', 'Modo Energy'],
              ['Contract-aware analytics before telemetry is even connected', 'NuraVolt'],
            ],
          },
        ],
      },
    ],
    faq: [
      {
        q: 'What does BESS monitoring software actually monitor?',
        a: 'Three different things depending on the product: battery health and safety from BMS telemetry (SoH, SoC accuracy, imbalance, anomaly screening), operational performance inside an asset management platform (availability, dispatch, alarms), and commercial performance against the market (revenue versus benchmark). Most operators eventually need all three; almost no single product covers them.',
      },
      {
        q: 'Why does state of health matter more than state of charge?',
        a: 'SoC says how full the battery is now; SoH says how much battery is left at all. SoH determines warranty standing, augmentation timing, and bankable capacity. ACCURE’s 2025 fleet report found SoC estimation errors of plus or minus 15 percent are common in LFP systems, which corrupts both dispatch and health estimates built on top of it.',
      },
      {
        q: 'Is battery degradation actually a big problem in practice?',
        a: 'Measured fleet data says it is real but manageable: Modo Energy found GB grid-scale batteries lost about 4.4 percent of capacity after 365 cycles on average, less than many warranty curves assume, because assets rarely run full-depth discharges. The risk is the tail: some systems in the same study degraded up to 11 percent, and finding out late converts a warranty claim into a self-funded augmentation.',
      },
    ],
    related: [
      { title: 'State of Health (SoH)', href: '/bess/state-of-health', description: 'The metric this whole category orbits.' },
      { title: 'Battery augmentation', href: '/bess/augmentation', description: 'What degradation costs when it arrives.' },
      { title: 'Warranty as a data product', href: '/bess/warranty-as-data-product', description: 'Why warranty tracking needs continuous data.' },
      { title: 'BESS health monitoring in 2026', href: '/insights/bess-health-monitoring-2026', description: 'The long-form guide behind this list.' },
      { title: 'Best solar monitoring software in 2026', href: '/compare/best-solar-monitoring-software-2026', description: 'The PV side of the landscape.' },
    ],
    sources: [
      'twaice.com product pages; EIB press release, February 2026',
      'accure.net product pages; ACCURE 2025 Energy Storage System Health and Performance Report coverage, Renewable Energy Magazine and pv-magazine-usa, September to October 2025',
      'EPRI BESS Failure Incident Database and 2024 root-cause white paper',
      'elysia.co and zitara.com, acquisition announcements, January 2026',
      'powerup-technology.com; Socomec and Energy-Storage.news coverage, 2025 to 2026',
      'powerfactors.com Unity and BESS press releases',
      'modoenergy.com benchmarking methodology, GB degradation research, and pricing page, accessed August 2026',
    ],
    datePublished: '2026-08-12',
    itemList: [
      { name: 'TWAICE' },
      { name: 'ACCURE Battery Intelligence' },
      { name: 'Elysia + Zitara (Fortescue)' },
      { name: 'PowerUp (Socomec)' },
      { name: 'Power Factors Unity' },
      { name: 'Modo Energy' },
      { name: 'NuraVolt BESS', url: 'https://nuravolt.com/bess' },
    ],
  },
  {
    slug: 'raycatch-alternative',
    kind: 'alternative',
    title: 'Raycatch (DeepSolar) alternative for AI solar diagnostics (2026)',
    competitor: { name: 'Raycatch DeepSolar', website: 'https://deepsolar.ai' },
    asOf: 'August 2026',
    intro:
      'Raycatch pioneered hardware-free AI diagnostics for PV. The product lives on as DeepSolar, but it has changed owners twice since 2022, which is exactly why operators go looking for an alternative.',
    quickAnswer:
      'DeepSolar, originally built by Israeli startup Raycatch, is an AI diagnostics layer that turns existing monitoring data into ROI-ranked O&M task lists with no new hardware. The product is real, but its corporate story is unstable: Raycatch’s assets were sold to BladeRanger in November 2022, then to PainReform, a NASDAQ-listed former pharma company, in March 2025, and raycatch.com is offline as of August 2026. NuraVolt is the closest software-only alternative, adding per-inverter soiling economics, BESS analytics, published accuracy benchmarks, and public pricing.',
    sections: [
      {
        heading: 'What DeepSolar is, factually',
        blocks: [
          {
            type: 'paragraph',
            text: 'DeepSolar is a cloud-based automated AI diagnostics platform for PV plants. It ingests production data from a plant’s existing monitoring systems, runs daily analysis, and produces a diagnostic mapping plus a prioritized, ROI-ranked task list down to string level, explicitly with no new hardware, software, or site visits. Raycatch material claimed more than 4 GW of solar assets analyzed, an identified 4 to 5 percent of average recoverable yield, and up to 30 percent O&M cost savings, and the product won an Intersolar Award. Diagnostic coverage spans cleaning recommendations, MPPT and inverter efficiency, disconnections, PID, and underperforming panels under warranty.',
          },
        ],
      },
      {
        heading: 'The ownership history a buyer should know',
        blocks: [
          {
            type: 'paragraph',
            text: 'These are public facts, not commentary. Raycatch was founded in Tel Aviv in 2015 and raised about 6.1 million dollars, backed among others by BayWa r.e. Energy Ventures. In November 2022 its assets were acquired by BladeRanger, an Israeli robotic panel-cleaning company, for 1.5 million dollars. In March 2025 BladeRanger sold DeepSolar to PainReform Ltd., a NASDAQ-listed company that was previously a clinical-stage pharmaceutical business, for 4.5 million dollars in shares and securities. DeepSolar now operates as PainReform’s solar unit; it joined the NVIDIA Connect program in August 2025 and announced a forecasting module, DeepSolar Predict, in pilots as of November 2025. As of August 2026, raycatch.com does not load, while deepsolar.ai is live but publishes no customer roster, track-record numbers, or pricing. For an operator signing a multi-year analytics contract, vendor continuity belongs in the diligence checklist alongside the feature list.',
          },
        ],
      },
      {
        heading: 'Where DeepSolar wins',
        blocks: [
          {
            type: 'paragraph',
            text: 'The core idea is genuinely good and the deployment model is frictionless: full compatibility claims across monitoring systems and hardware, no IT project, and a daily ROI-ranked action list that field teams can execute directly. The diagnostic breadth from production data alone is wide, and the claimed impact figures came from analysis across 75 utility-scale plants totaling 1.2 GW. A portfolio owner who wants automated daily diagnostics dropped on top of an existing monitoring stack, with minimal integration effort, is squarely in DeepSolar’s original design center.',
          },
        ],
      },
      {
        heading: 'Where NuraVolt wins',
        blocks: [
          {
            type: 'paragraph',
            text: 'Same software-only category, different construction. NuraVolt publishes its model accuracy as open benchmarks on public datasets, per class and per horizon, where DeepSolar’s current site publishes no verifiable accuracy evidence. Soiling is treated as an economic decision, estimated per inverter after digital-twin weather and temperature correction and fed into cleaning-schedule optimization, not only flagged as a cleaning recommendation. NuraVolt also covers what DeepSolar does not attempt: BESS health, warranty, and revenue analytics, an O&M ticketing workflow, contract-obligation tracking, and an MCP server that makes the fleet queryable from AI assistants. Pricing is public, and the company is the operating business itself rather than a unit of a listed company from another industry.',
          },
        ],
      },
    ],
    faq: [
      {
        q: 'Is Raycatch still in business?',
        a: 'The Raycatch company as founded is gone: its assets were sold to BladeRanger in November 2022, and the DeepSolar product was sold on to PainReform Ltd. in March 2025, where it now operates as a solar business unit. The raycatch.com website was offline as of August 2026; the product lives at deepsolar.ai.',
      },
      {
        q: 'Does DeepSolar require hardware?',
        a: 'No. It is explicitly software-only, running on data from existing monitoring systems, which was Raycatch’s founding pitch. NuraVolt takes the same approach, so a comparison between the two is about analytics depth, evidence, and scope rather than deployment model.',
      },
      {
        q: 'What should replace the 4 to 5 percent recoverable-yield claim in an evaluation?',
        a: 'Your own plant’s number. Any competent analytics layer should quantify recoverable loss from your historical data during a trial, per loss bucket, before you commit. Ask every vendor, NuraVolt included, to show the recoverable-yield estimate for your actual fleet and to explain which model produced it and how that model scores on a named dataset.',
      },
    ],
    related: [
      { title: 'Can ML actually detect solar faults?', href: '/reports/ml-solar-fault-detection-benchmark', description: 'The published benchmark to hold every AI diagnostics vendor to.' },
      { title: 'Best solar monitoring software in 2026', href: '/compare/best-solar-monitoring-software-2026', description: 'Where AI diagnostics layers fit in the landscape.' },
      { title: 'Fracsun alternative: sensorless soiling monitoring', href: '/compare/fracsun-alternative', description: 'The soiling-specific version of the same software-only argument.' },
      { title: 'Soiling loss', href: '/faults/soiling-loss', description: 'The recoverable loss both platforms chase.' },
    ],
    sources: [
      'deepsolar.ai product pages, accessed August 2026; raycatch.com unreachable, observed August 2026',
      'Jerusalem Post and SolarQuarter, BladeRanger asset acquisition, November 2022',
      'MarketScreener and Investing.com, PainReform acquisition of DeepSolar, completed March 2025',
      'GlobeNewswire, NVIDIA Connect acceptance August 2025 and DeepSolar Predict update November 2025',
      'pv-tech.org and pv-magazine.com, Raycatch DeepSolar product coverage and Intersolar Award',
      'Crunchbase, Raycatch funding history',
    ],
    datePublished: '2026-08-12',
  },
  {
    slug: 'solar-log-alternative',
    kind: 'alternative',
    title: 'Solar-Log alternative: analytics beyond the data logger (2026)',
    competitor: { name: 'Solar-Log', website: 'https://www.solar-log.com' },
    asOf: 'August 2026',
    intro:
      'Solar-Log is the European multi-brand monitoring incumbent, with hardware loggers on more than 415,000 plants. The reason to look for an alternative is rarely reliability. It is that a logger company is not an analytics company.',
    quickAnswer:
      'Solar-Log, owned by Swiss utility BKW since 2015, monitors 415,000+ plants across 141 countries through its Base data loggers and Enerest 4 cloud portal, with compatibility claims spanning 3,000+ components and 30+ inverter brands plus German-grade feed-in management. What it does not offer is AI analytics: no soiling estimation, no degradation or warranty analytics, no BESS revenue intelligence, and features are license-gated per function. NuraVolt is the analytics alternative or complement: software-only, running on the data a Solar-Log fleet already exports.',
    sections: [
      {
        heading: 'What Solar-Log is, factually',
        blocks: [
          {
            type: 'paragraph',
            text: 'Solar-Log GmbH, from Geislingen-Binsdorf in Germany, has shipped PV monitoring since 2007 and has been part of the BKW Group since 2015. The system is hardware-anchored: a Solar-Log Base data logger on site, paired with the Solar-Log WEB Enerest 4 cloud portal for monitoring, alarms convertible into tracked tasks, fleet dashboards, and reporting. Its live counters show more than 415,000 plants and 17.5 GWp monitored in 141 countries. Two capabilities stand out structurally: manufacturer independence, with claimed compatibility for over 3,000 components across 30+ inverter brands, and feed-in management, the grid-operator power-control and direct-marketing interfaces that German and EU plants are legally required to support. Enerest 4 stores data on EU servers and accepts selected third-party loggers.',
          },
        ],
      },
      {
        heading: 'Where Solar-Log wins',
        blocks: [
          {
            type: 'paragraph',
            text: 'Installed base and regulatory depth. Nineteen years of shipping, a utility owner, ISO 9001, 14001 and 27001 certification, and a portal that is a genuine operations cockpit: unlimited custom monitoring rules, string and MPP-tracker-level deviation detection, and public embeddable dashboards. For a German or Austrian C&I plant that must implement grid-operator telecontrol and direct-marketer interfaces, Solar-Log’s PM licenses solve a compliance problem most analytics platforms do not touch. An installer standardizing hundreds of small mixed-brand sites on one logger family gets exactly what the product was built for. EU data residency is contractual, not aspirational.',
          },
        ],
      },
      {
        heading: 'Where the analytics alternative wins',
        blocks: [
          {
            type: 'paragraph',
            text: 'Solar-Log’s fault detection is rule and threshold based, built on inverter status codes and deviation alarms. Nothing in its product pages or the Enerest 4 datasheet offers soiling estimation, cleaning-schedule economics, ML-based loss attribution, degradation or warranty analytics, or storage revenue intelligence; battery support is event monitoring in a self-consumption context. The commercial model also stacks licenses: plant-size expansions, feed-in management modes, Modbus TCP, FTP export, and API access are separately purchased, and API access specifically is sold as paid Plant API packages. NuraVolt requires no hardware and no license ladder: it consumes the data a fleet already produces, including via the FTP, MQTT, and API interfaces Enerest 4 itself provides, and adds the analytics layer on top: per-inverter soiling economics, fault classification with published benchmark accuracy, digital-twin expected-power modelling, and BESS analytics. For many fleets the honest answer is both: Solar-Log keeps collecting and controlling, NuraVolt does the analytics.',
          },
        ],
      },
      {
        heading: 'The honest decision rule',
        blocks: [
          {
            type: 'paragraph',
            text: 'If your need is compliant data collection, feed-in management, and solid threshold monitoring across mixed brands, Solar-Log is a category reference and NuraVolt does not replace the logger layer. If your need is knowing what the losses cost and what to do about them, soiling versus degradation versus downtime, priced per inverter, a rule-based portal will not produce that, and an analytics layer will. Buyers replacing Solar-Log outright are usually consolidating onto inverter-vendor portals plus an independent analytics layer; buyers keeping it usually add the analytics layer on top of the existing loggers.',
          },
        ],
      },
    ],
    faq: [
      {
        q: 'Does Solar-Log require its own hardware?',
        a: 'Yes, monitoring runs through an on-site Solar-Log Base logger, with only two third-party logger families accepted into the Enerest 4 portal as of August 2026 (Huawei SmartLogger and meteocontrol blue Log X, the latter needing a license). NuraVolt, by contrast, is software-only and ingests data from existing loggers, portals, or SCADA exports, including from Solar-Log systems.',
      },
      {
        q: 'Does Solar-Log do soiling monitoring or AI analytics?',
        a: 'Its published product pages and the Enerest 4 datasheet describe rule-based deviation detection, status-code alarms, and reporting, with no soiling estimation, machine-learning diagnostics, degradation analytics, or cleaning-schedule optimization as of August 2026. Fleets that need those capabilities layer an analytics platform over the logger data.',
      },
      {
        q: 'Is Solar-Log pricing public?',
        a: 'Not from the vendor: logger hardware has street prices at third-party resellers, but portal fees and the function licenses (plant-size expansion, feed-in management, API packages) are sold without published prices. Budget for the license ladder when comparing total cost against a flat-priced analytics subscription.',
      },
    ],
    related: [
      { title: 'Best solar monitoring software in 2026', href: '/compare/best-solar-monitoring-software-2026', description: 'Solar-Log and the alternatives in the full landscape.' },
      { title: 'FusionSolar monitoring vs independent analytics', href: '/compare/huawei-fusionsolar-vs-independent-monitoring', description: 'The same layered argument for vendor portals.' },
      { title: 'Solar monitoring for Spain', href: '/solar-monitoring/spain', description: 'Where European grid-compliance needs meet analytics.' },
      { title: 'Soiling loss', href: '/faults/soiling-loss', description: 'The recoverable loss a threshold portal cannot price.' },
    ],
    sources: [
      'solar-log.com product pages and live plant counters, accessed August 2026',
      'Solar-Log WEB Enerest 4 datasheet (solar-log.com media library)',
      'solar-log.com license catalog and Enerest 4 online help (Plant API packages)',
      'solarpowermanagement.net, BKW acquisition of Solare Datensysteme, 2015',
      'CISA ICS advisory ICSA-24-303-02, October 2024',
    ],
    datePublished: '2026-08-12',
  },
  {
    slug: 'alsoenergy-alternative',
    kind: 'alternative',
    title: 'AlsoEnergy (PowerTrack) alternative for solar monitoring (2026)',
    competitor: { name: 'Stem PowerTrack (formerly AlsoEnergy)', website: 'https://www.stem.com' },
    asOf: 'August 2026',
    intro:
      'AlsoEnergy no longer exists as a standalone company: it is Stem PowerTrack now. That transition, and the enterprise procurement that comes with it, is why operators comparison-shop.',
    quickAnswer:
      'AlsoEnergy was acquired by Stem, Inc. for 695 million dollars in a deal completed in February 2022, and its platform now runs as Stem PowerTrack, with the PowerTrack APM suite launched in September 2024 and roughly 36 GW of solar under management. It remains one of the strongest solar plus storage asset performance platforms, especially for C&I portfolios. Operators seeking an alternative usually want deeper independent analytics, lighter procurement, or public pricing; NuraVolt offers all three as a software-only layer on existing data.',
    sections: [
      {
        heading: 'What PowerTrack is, factually',
        blocks: [
          {
            type: 'paragraph',
            text: 'PowerTrack is the former AlsoEnergy platform, historically one of the strongest C&I solar monitoring products and now the core of Stem’s software business. Stem announced the 695 million dollar acquisition in December 2021 and completed it on February 1, 2022; the deal added 32.85 GW of solar assets under management, and Stem cited around 36 GW in 2025. PowerTrack APM, launched September 2024, extends monitoring into asset performance management for solar plus storage, aiming to bridge technical and commercial operations. Context a buyer should know: Stem went through a hard 2024 to 2025 restructuring away from battery hardware resale toward software, including a workforce reduction of about 27 percent, and reported fiscal 2025 as its first full year of positive adjusted EBITDA, crediting the software pivot. The PowerTrack product remains actively developed.',
          },
        ],
      },
      {
        heading: 'Where PowerTrack wins',
        blocks: [
          {
            type: 'paragraph',
            text: 'Breadth and pedigree in solar plus storage. PowerTrack spans commissioning through O&M across roughly 50 countries, with hardware integration depth built over two decades of AlsoEnergy history and storage capabilities reinforced by Stem’s energy-storage lineage. A portfolio owner running utility-scale solar alongside grid-scale batteries, who wants monitoring, controls, and commercial reporting under one enterprise contract, is PowerTrack’s target customer, and the platform’s scale claims are among the largest in the category. For large C&I fleets it remains one of the most proven platforms in the market.',
          },
        ],
      },
      {
        heading: 'Where the independent alternative wins',
        blocks: [
          {
            type: 'paragraph',
            text: 'Three axes. Analytics depth per euro: NuraVolt’s center of gravity is the loss economics PowerTrack treats as one feature among many, per-inverter soiling estimation after digital-twin correction, fault classification with accuracy published as open benchmarks on public datasets, and BESS warranty, cycling, and revenue intelligence with modelled and measured numbers kept in separate lanes. Procurement weight: PowerTrack is an enterprise sale with quote-based pricing; NuraVolt publishes its pricing and onboards from existing data without a hardware or SCADA project. Independence: Stem is a storage company whose software grades storage-adjacent assets; an independent layer with no hardware interest produces the warranty and underperformance evidence an owner can take into a dispute. The honest converse: NuraVolt does not do plant controls, dispatch, or commercial invoicing, so a buyer needing those keeps an operations platform and layers analytics beside it.',
          },
        ],
      },
    ],
    faq: [
      {
        q: 'Is AlsoEnergy still a company?',
        a: 'Not as a standalone brand. Stem, Inc. completed its 695 million dollar acquisition of AlsoEnergy on February 1, 2022, and the product line now runs as Stem PowerTrack, extended by the PowerTrack APM suite launched in September 2024. Existing AlsoEnergy deployments continue under the Stem brand.',
      },
      {
        q: 'Is PowerTrack pricing public?',
        a: 'No, it is an enterprise quote-based sale as of August 2026. NuraVolt publishes its pricing publicly, which makes budget comparison possible before a sales cycle rather than after it.',
      },
      {
        q: 'Can an analytics layer replace PowerTrack?',
        a: 'It depends which half you use. PowerTrack’s monitoring, reporting, and analytics workload can be covered by an independent layer over existing data acquisition. Its controls, dispatch, and commissioning tooling cannot: those need an operations platform. Fleets commonly run monitoring-grade data collection, an operations layer where controls are needed, and independent analytics for economics and evidence.',
      },
    ],
    related: [
      { title: 'Best solar asset management software in 2026', href: '/compare/best-solar-asset-management-software-2026', description: 'PowerTrack in the asset management landscape.' },
      { title: 'Best solar monitoring software in 2026', href: '/compare/best-solar-monitoring-software-2026', description: 'The monitoring category overview.' },
      { title: 'Best BESS monitoring software in 2026', href: '/compare/best-bess-monitoring-software-2026', description: 'The storage side of the comparison.' },
      { title: 'Why warranty disputes are won or lost in SCADA data', href: '/insights/warranty-disputes-scada-data', description: 'Why independence matters for evidence.' },
    ],
    sources: [
      'Businesswire, Stem acquisition of AlsoEnergy, December 2021 and February 2022',
      'Stem investor releases: PowerTrack APM launch September 2024, Q1 2025 results, FY2025 results',
      'Stem SEC filings, 2024 to 2025 restructuring disclosures',
      'stem.com PowerTrack product pages, accessed August 2026',
    ],
    datePublished: '2026-08-12',
  },
  {
    slug: 'solar-monitoring-software-pricing',
    kind: 'category',
    title: 'Solar monitoring software pricing in 2026: what it actually costs',
    asOf: 'August 2026',
    intro:
      'Almost nobody in this market publishes a price. Here is why, what the real cost models look like, where the hidden costs sit, and the few prices that are actually public.',
    quickAnswer:
      'Solar monitoring software pricing in 2026 is mostly quote-based: the enterprise platforms (Power Factors Unity, Stem PowerTrack, GPM Horizon, SmartHelio, TWAICE, ACCURE) publish no prices, vendor portals like FusionSolar and iSolarCloud are bundled free with the hardware, and logger systems like Solar-Log sell separately priced function licenses. The public exceptions: NuraVolt publishes its full tier ladder, from 9 euros per month residential to Business from 99 euros per month priced by MW under management, and Modo Energy offers a self-serve free tier for market analytics.',
    sections: [
      {
        heading: 'Why monitoring vendors do not publish pricing',
        blocks: [
          {
            type: 'paragraph',
            text: 'The category grew up selling to utility-scale owners through enterprise sales cycles, where pricing is negotiated per portfolio: fleet size, data sources, SCADA integration scope, and support tier all move the number. Every enterprise platform we track confirms this pattern as of August 2026: Power Factors Unity, Stem PowerTrack, GPM Horizon, SmartHelio, Raptor Maps, Clir, TWAICE, ACCURE, and Elum all sell through demo-request funnels with no rate card. The practical consequence for a buyer is that comparing costs requires running several parallel sales cycles, and any comparison page on the internet showing exact prices for these platforms is guessing.',
          },
        ],
      },
      {
        heading: 'The five cost models in the market',
        blocks: [
          {
            type: 'table',
            caption: 'How solar monitoring is actually priced, from public vendor documentation, August 2026.',
            headers: ['Model', 'Who uses it', 'What to watch'],
            rows: [
              ['Quote-based enterprise SaaS', 'Unity, PowerTrack, GPM Horizon, SmartHelio, TWAICE, ACCURE', 'Sales-cycle time and per-portfolio negotiation; no public benchmark'],
              ['Free vendor portal bundled with hardware', 'Huawei FusionSolar, Sungrow iSolarCloud', 'Free for that brand only; mixed fleets get second-class support'],
              ['Hardware plus function licenses', 'Solar-Log', 'Logger purchase, then separately priced licenses for plant size, feed-in management, and API access'],
              ['Published tiered SaaS by capacity', 'NuraVolt', 'Public ladder priced by MW under management; the exception in the category'],
              ['Freemium market analytics', 'Modo Energy', 'Free tier is market data, not plant telemetry monitoring'],
            ],
          },
        ],
      },
      {
        heading: 'The prices that are actually public',
        blocks: [
          {
            type: 'paragraph',
            text: 'NuraVolt publishes its full ladder: Residential at 9 euros per month for one rooftop system up to 100 kW, Business from 99 euros per month priced in capacity bands (up to 2, 8, 20, or 60 MW under management) with the Shams AI agent included at a fixed price, and custom Enterprise above 60 MW. There is a 14-day free trial and no annual lock-in; capacity counts solar MW and storage MWh together. Modo Energy, in the adjacent market-analytics category, offers a self-serve free tier with paid Business and Enterprise tiers behind contact-sales. Those are, to our knowledge, the only published price points among the platforms covered on this site as of August 2026. We publish ours because a C&I operator evaluating software should be able to budget before entering a sales cycle, and because per-MW pricing keeps the comparison honest as a fleet grows.',
          },
        ],
      },
      {
        heading: 'The hidden costs a quote does not show',
        blocks: [
          {
            type: 'table',
            caption: 'Costs that surface after the headline subscription, from public vendor documentation.',
            headers: ['Hidden cost', 'Where it appears'],
            rows: [
              ['On-site logger or gateway hardware', 'Logger-based systems; hardware sold via resellers with separate street prices'],
              ['Per-function licenses', 'Solar-Log sells plant-size expansions, feed-in management modes, and FTP export as separate licenses'],
              ['API access sold separately', 'Solar-Log Plant API packages; constrained export on vendor portals'],
              ['Integration projects', 'Enterprise platforms integrating SCADA, EMS, and data warehouses'],
              ['Sales-cycle time', 'Weeks to months of evaluation before a quote-based platform shows a number'],
              ['Seat and plant caps', 'Tiered products cap users or plants; check the ceiling against your fleet plan'],
            ],
          },
        ],
      },
      {
        heading: 'How to budget a monitoring evaluation',
        blocks: [
          {
            type: 'paragraph',
            text: 'Anchor on what your fleet loses without analytics, not on the license fee. Published fleet studies put average PV underperformance against P50 estimates at 8.6 percent (kWh Analytics, 2025), and NREL estimates comprehensive O&M could lift average fleet performance ratio from 91.7 to at least 95 percent; for most C&I portfolios either number dwarfs any software subscription. Then price the stack in layers: data collection you may already own (inverter portals, existing loggers), an analytics layer priced transparently enough to budget, and enterprise platforms only where controls, dispatch, or commercial reporting genuinely require them.',
          },
        ],
      },
    ],
    faq: [
      {
        q: 'How much does solar monitoring software cost?',
        a: 'For single-brand fleets, vendor portals like FusionSolar and iSolarCloud are effectively free with the hardware. Published independent analytics starts at 9 euros per month for a single rooftop and from 99 euros per month for C&I fleets priced by MW under management (NuraVolt). Enterprise asset management platforms are quote-based and publish no prices as of August 2026.',
      },
      {
        q: 'Why do most monitoring vendors not publish pricing?',
        a: 'Because they sell negotiated enterprise contracts where portfolio size, integration scope, and support tier move the price, and because unpublished pricing preserves negotiating room. It is a rational sales model for utility-scale deals and a poor fit for C&I buyers who need to budget before committing to a sales cycle.',
      },
      {
        q: 'Is free vendor-portal monitoring really free?',
        a: 'For a single-brand fleet with basic needs, essentially yes: the cost is bundled into the hardware. The non-obvious costs are structural: second-class support for mixed-brand fleets, constrained data export and APIs, and analytics limited to what the manufacturer chooses to show about its own hardware. Fleets typically keep the free portal for data collection and add an independent layer when those limits start costing yield.',
      },
    ],
    related: [
      { title: 'NuraVolt pricing', href: '/pricing', description: 'The published tier ladder referenced above.' },
      { title: 'Best solar monitoring software in 2026', href: '/compare/best-solar-monitoring-software-2026', description: 'The platforms behind these cost models.' },
      { title: 'Best solar asset management software in 2026', href: '/compare/best-solar-asset-management-software-2026', description: 'The enterprise end of the budget.' },
      { title: 'Solar-Log alternative: analytics beyond the data logger', href: '/compare/solar-log-alternative', description: 'The license-ladder cost model in detail.' },
    ],
    sources: [
      'nuravolt.com/pricing, published tiers, August 2026',
      'modoenergy.com pricing page, accessed August 2026',
      'solar-log.com license catalog and Enerest 4 datasheet, accessed August 2026',
      'Vendor product pages for Unity, PowerTrack, GPM Horizon, SmartHelio, TWAICE, ACCURE, and Elum, accessed July to August 2026 (no public pricing on any)',
      'kWh Analytics, Solar Risk Assessment 2025; NREL O&M best-practices report, 3rd edition',
    ],
    datePublished: '2026-08-21',
  },
];

export function getComparison(slug: string): ComparisonEntry | undefined {
  return comparisons.find((c) => c.slug === slug);
}

export function normalizeComparison(entry: ComparisonEntry): ArticleView {
  const schemaExtras: Record<string, any>[] = [];
  if (entry.itemList?.length) {
    schemaExtras.push({
      '@context': 'https://schema.org',
      '@type': 'ItemList',
      name: entry.title,
      url: absoluteUrl(`/compare/${entry.slug}`),
      numberOfItems: entry.itemList.length,
      itemListElement: entry.itemList.map((item, i) => ({
        '@type': 'ListItem',
        position: i + 1,
        name: item.name,
        ...(item.url && { url: item.url }),
      })),
    });
  }

  return {
    category: KIND_LABEL[entry.kind],
    hub: COMPARE_HUB,
    slug: entry.slug,
    urlRelative: `/compare/${entry.slug}`,
    title: entry.title,
    intro: entry.intro,
    quickAnswer: entry.quickAnswer,
    sections: entry.sections,
    faq: entry.faq,
    related: entry.related,
    datePublished: entry.datePublished,
    sources: entry.sources,
    ...(schemaExtras.length && { schemaExtras }),
  };
}
