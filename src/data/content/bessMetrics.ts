import type { ArticleView, ContentSection, FAQ, RelatedLink } from './types';

/**
 * Template B — BESS metric / concept catalog (the BESS-lead pages).
 *
 * Substance drawn from notebooks/bess_analytics_crash_course.ipynb and the
 * operator manual public/data/manuals/seed/synthetic/bess-warranty-and-degradation.md.
 * These rank for the exact terms operators search and position NuraVolt as the
 * BESS-analytics authority.
 */

const PUBLISHED = '2026-06-09';

export interface BessMetricEntry {
  slug: string;
  title: string;
  intro: string;
  quickAnswer: string;
  definition: string;
  /** Optional formula, rendered monospace. */
  formula?: string;
  typicalRange: string;
  whyItMatters: string;
  howNuravoltTracks: string;
  /** Slugs of other metrics in this catalog. */
  relatedMetrics: string[];
  /** Cross-catalog links (e.g. fault pages). */
  extraRelated?: RelatedLink[];
  /** Free-form sections appended after the standard template (benchmark tables, contract context). */
  extraSections?: ContentSection[];
  faq: FAQ[];
  sources?: string[];
  datePublished?: string;
}

export const bessMetrics: BessMetricEntry[] = [
  {
    slug: 'state-of-health',
    title: 'State of Health (SoH)',
    intro: 'The headline number for how much battery you have left.',
    quickAnswer:
      'State of Health (SoH) is the ratio of a battery’s present usable capacity to its original rated capacity, expressed as a percentage. A new pack is 100%; most utility warranties guarantee ≥70% at 10 years. SoH is the single number that determines warranty standing and remaining asset value.',
    definition:
      'SoH compares current maximum capacity (measured by a capacity test or estimated from operating data) to the battery’s beginning-of-life rated capacity. It declines through calendar ageing and cycling. It is distinct from State of Charge (SoC), which is how full the battery is right now.',
    formula: 'SoH (%) = (present usable capacity ÷ rated capacity) × 100',
    typicalRange:
      'New: ~100%. Warranty floor: typically ≥70% at 10 years (or ≥60% at 20). LFP reaches 4,000–6,000 full cycles to 80% SoH; NMC 2,000–3,500.',
    whyItMatters:
      'SoH governs the warranty: if it falls below the contracted curve, you may have a claim — or, if your dispatch caused it, a liability. It also sets the revenue capacity you can actually dispatch. Tracking SoH against the contracted curve is the foundation of every BESS analytics programme.',
    howNuravoltTracks:
      'NuraVolt estimates SoH from operating data and periodic capacity tests, trends it against the contracted degradation curve, and projects the date it will cross the warranty threshold. A degradation rate above 2× the contracted curve over a 90-day window raises a warranty-grade alert.',
    relatedMetrics: ['equivalent-full-cycles', 'depth-of-discharge', 'warranty-as-data-product'],
    extraRelated: [
      {
        title: 'BESS capacity fade',
        href: '/faults/bess-capacity-fade',
        description: 'The fault mode when SoH declines too fast.',
      },
      {
        title: 'Best BESS monitoring software in 2026',
        href: '/compare/best-bess-monitoring-software-2026',
        description: 'The platforms that estimate and track SoH, compared.',
      },
    ],
    faq: [
      {
        q: 'What is the difference between SoH and SoC?',
        a: 'SoC (State of Charge) is how full the battery is right now, 0–100%, and changes minute to minute. SoH (State of Health) is how much total capacity the battery still has versus new, and changes over years.',
      },
      {
        q: 'How is SoH measured?',
        a: 'Most accurately by a controlled capacity test (full charge/discharge under defined conditions), scheduled every ~6 months. Between tests it is estimated from operating data — NuraVolt blends both.',
      },
    ],
    sources: [
      'notebooks/bess_analytics_crash_course.ipynb',
      'public/data/manuals/seed/synthetic/bess-warranty-and-degradation.md',
    ],
    datePublished: PUBLISHED,
  },
  {
    slug: 'round-trip-efficiency',
    title: 'Round-trip efficiency (RTE)',
    intro: 'How much energy survives a charge-and-discharge cycle.',
    quickAnswer:
      'Round-trip efficiency (RTE) is the ratio of energy discharged to energy charged over a full cycle, including auxiliary loads like HVAC. Modern Li-ion BESS run ~88–92% AC-AC. Every lost point is energy you paid to store but never sold, so RTE decay directly erodes arbitrage margin.',
    definition:
      'RTE captures all losses in a charge/discharge round trip: cell internal resistance, power-conversion (PCS) losses, and auxiliary consumption (cooling, controls). AC-AC RTE measured at the point of connection is the figure that matters commercially.',
    formula: 'RTE (%) = (energy discharged ÷ energy charged) × 100',
    typicalRange:
      'New AC-AC RTE: ~88–92% including auxiliaries. A sustained drift below ~85% warrants investigation. DC-DC efficiency is higher but commercially less relevant.',
    whyItMatters:
      'RTE sets the spread you keep on every arbitrage cycle. A 2-point loss across thousands of cycles a year is real money. RTE is also diagnostic: a falling trend usually means rising internal resistance, degraded connections, or auxiliary-load creep.',
    howNuravoltTracks:
      'NuraVolt computes RTE per cycle and trends it, separating cell-resistance-driven decay from auxiliary-load growth, and projects the date it crosses the efficiency floor so the cause is fixed before margin is lost.',
    relatedMetrics: ['c-rate', 'state-of-health'],
    extraRelated: [
      {
        title: 'BESS round-trip efficiency decay',
        href: '/faults/bess-rte-decay',
        description: 'The fault mode when RTE falls below the floor.',
      },
    ],
    faq: [
      {
        q: 'Should RTE include auxiliary loads?',
        a: 'For commercial purposes, yes — AC-AC RTE measured at the connection point and including HVAC/controls is what determines your real arbitrage economics. Quoting only DC-DC efficiency flatters the number.',
      },
    ],
    sources: ['notebooks/bess_analytics_crash_course.ipynb'],
    datePublished: PUBLISHED,
  },
  {
    slug: 'depth-of-discharge',
    title: 'Depth of discharge (DoD)',
    intro: 'How deep each cycle goes — and what it costs in lifetime.',
    quickAnswer:
      'Depth of discharge (DoD) is the fraction of a battery’s capacity removed in a discharge, the inverse of the SoC left behind. Warranties are usually quoted at a reference DoD (often 80%). Deeper, more frequent cycling accelerates degradation, so DoD is a core dispatch-versus-longevity lever.',
    definition:
      'DoD = 1 − SoC at the bottom of a discharge. An 80% DoD cycle runs from 100% to 20% SoC. Cycle-life ratings are always stated at a reference DoD, because shallower cycles are gentler and a battery delivers far more shallow cycles than deep ones.',
    formula: 'DoD (%) = 100 − (SoC at end of discharge, %)',
    typicalRange:
      'Warranty reference DoD: commonly 80%. Many operators cap upper SoC at 90% in low-revenue hours to slow ageing. Contracted cycles/day: typically 1.5–2 for storage, higher for ancillary-services assets.',
    whyItMatters:
      'DoD is one of the few degradation drivers fully under operator control. Trading some depth for longevity — or capping upper SoC — can extend warranty life with minimal revenue impact. Exceeding the contracted DoD or cycles/day can also void warranty cover.',
    howNuravoltTracks:
      'NuraVolt decomposes the dispatch profile into cycles and their depths (via rainflow counting), checks them against the contracted DoD and cycles/day limits, and quantifies the degradation cost of each dispatch decision.',
    relatedMetrics: ['equivalent-full-cycles', 'rainflow-counting', 'state-of-charge'],
    extraRelated: [
      {
        title: 'BESS thermal stress',
        href: '/faults/bess-thermal-stress',
        description: 'The other major controllable degradation driver.',
      },
    ],
    faq: [
      {
        q: 'Is shallow cycling always better?',
        a: 'For battery life, generally yes — many shallow cycles age a pack less than a few deep ones for the same throughput. But shallow cycling can leave revenue on the table, so it is an optimisation, not a rule.',
      },
    ],
    sources: [
      'notebooks/bess_analytics_crash_course.ipynb',
      'public/data/manuals/seed/synthetic/bess-warranty-and-degradation.md',
    ],
    datePublished: PUBLISHED,
  },
  {
    slug: 'equivalent-full-cycles',
    title: 'Equivalent full cycles (EFC)',
    intro: 'A single number that normalises messy partial cycling into full-cycle equivalents.',
    quickAnswer:
      'Equivalent full cycles (EFC) express total energy throughput as the number of complete 0–100% cycles it represents, so that many partial cycles are counted fairly. EFC is the unit warranties use for the energy-throughput limit, making it the key cycle-budget metric for any BESS.',
    definition:
      'Real dispatch is a mix of partial charges and discharges, not clean full cycles. EFC sums the energy throughput and divides by the rated capacity, converting irregular operation into an equivalent count of full cycles. Partial cycles are weighted by their depth.',
    formula: 'EFC = cumulative energy throughput ÷ rated capacity',
    typicalRange:
      'Warranty energy-throughput limits are stated in MWh or in EFC. LFP supports ~4,000–6,000 EFC to 80% SoH; NMC ~2,000–3,500. Storage assets typically accrue ~1.5–2 EFC/day.',
    whyItMatters:
      'EFC is one of the two warranty limits (alongside capacity retention) — OEMs honour whichever is reached first. Tracking EFC against the contracted budget tells you whether you’ll hit the throughput cap before the calendar limit, which changes how you should dispatch.',
    howNuravoltTracks:
      'NuraVolt counts EFC continuously from metered throughput, projects the date the contracted EFC budget is exhausted at the current dispatch rate, and flags when cycling intensity puts the throughput limit ahead of the calendar limit.',
    relatedMetrics: ['rainflow-counting', 'depth-of-discharge', 'warranty-as-data-product'],
    faq: [
      {
        q: 'How do partial cycles count toward EFC?',
        a: 'They’re summed by energy: two 50%-depth cycles count as roughly one equivalent full cycle. Rainflow counting is the standard method for turning a partial-cycle profile into weighted full-cycle equivalents.',
      },
    ],
    sources: ['notebooks/bess_analytics_crash_course.ipynb'],
    datePublished: PUBLISHED,
  },
  {
    slug: 'rainflow-counting',
    title: 'Rainflow counting',
    intro: 'The fatigue-analysis method borrowed to count battery cycles correctly.',
    quickAnswer:
      'Rainflow counting is an algorithm — originally from metal-fatigue analysis — that decomposes an irregular SoC time series into a set of discrete charge/discharge cycles with defined depths. It is the rigorous way to turn real, messy BESS operation into the weighted cycle counts that drive equivalent full cycles and degradation models.',
    definition:
      'A battery’s SoC trace is full of nested partial swings. Rainflow counting extracts closed cycles and their amplitudes from that trace, so each partial cycle is attributed a depth. Those depth-weighted cycles feed both EFC accounting and depth-dependent degradation models.',
    typicalRange:
      'Not a value but a method. The output is a histogram of cycles by depth, which is then weighted (deeper cycles age the pack more) into EFC and degradation estimates.',
    whyItMatters:
      'Naively counting cycles (e.g. one per day) badly misrepresents an asset that does many shallow swings or several deep ones. Rainflow counting is what makes EFC, warranty throughput tracking, and degradation attribution defensible rather than approximate.',
    howNuravoltTracks:
      'NuraVolt applies rainflow counting to the SoC series to build a depth-resolved cycle histogram, which then feeds equivalent-full-cycle accounting and the capacity-fade model — so degradation is attributed to the actual cycling pattern, not a daily average.',
    relatedMetrics: ['equivalent-full-cycles', 'depth-of-discharge'],
    faq: [
      {
        q: 'Why use a fatigue algorithm for batteries?',
        a: 'Battery degradation, like metal fatigue, depends on the depth and number of cycles, not just total throughput. Rainflow counting is the established method for extracting depth-resolved cycles from an irregular signal, so it transfers directly to SoC traces.',
      },
    ],
    sources: ['notebooks/bess_analytics_crash_course.ipynb'],
    datePublished: PUBLISHED,
  },
  {
    slug: 'c-rate',
    title: 'C-rate',
    intro: 'How fast you charge or discharge, relative to capacity.',
    quickAnswer:
      'C-rate is the charge or discharge power normalised to capacity: 1C empties a battery in one hour, 0.5C in two, 2C in thirty minutes. High sustained C-rate raises temperature and internal stress and, for LFP, is a leading degradation driver — so it’s both a capability spec and a longevity lever.',
    definition:
      'C-rate = power ÷ energy capacity. A 2 MWh battery discharging at 2 MW runs at 1C. The C-rate a system can sustain defines whether it suits energy (long-duration, low C) or power/ancillary (short-duration, high C) applications.',
    formula: 'C-rate = power (kW) ÷ rated energy (kWh)',
    typicalRange:
      'Storage/arbitrage assets often operate ≤0.5C; ancillary-services and power assets run 1C and above. Continuous operation above ~1C is a notable degradation driver for LFP.',
    whyItMatters:
      'C-rate determines what markets an asset can serve and how hard it ages. Exceeding the OEM’s per-cell C-rate limit is a warranty exclusion and drives heat, which compounds thermal degradation. It’s a key input to degradation-aware dispatch.',
    howNuravoltTracks:
      'NuraVolt monitors instantaneous and sustained C-rate against the OEM limit, flags exceedances as warranty-relevant events, and factors C-rate into the thermal-stress and capacity-fade projections.',
    relatedMetrics: ['round-trip-efficiency', 'depth-of-discharge'],
    extraRelated: [
      {
        title: 'BESS thermal stress',
        href: '/faults/bess-thermal-stress',
        description: 'High C-rate feeds heat, which feeds degradation.',
      },
    ],
    faq: [
      {
        q: 'Does a higher C-rate always degrade the battery faster?',
        a: 'Higher sustained C-rate generally increases heat and stress, and for LFP it ranks among the top degradation drivers. Brief high-C bursts within spec are fine; the risk is continuous operation near or above the rated limit.',
      },
    ],
    sources: [
      'notebooks/bess_analytics_crash_course.ipynb',
      'public/data/manuals/seed/synthetic/bess-warranty-and-degradation.md',
    ],
    datePublished: PUBLISHED,
  },
  {
    slug: 'state-of-charge',
    title: 'State of Charge (SoC) and the SoC window',
    intro: 'How full the battery is — and why dwelling near full ages it.',
    quickAnswer:
      'State of Charge (SoC) is how full a battery is right now, 0–100%. Beyond the live reading, the SoC window you operate in matters: persistent dwell above ~80–90% accelerates calendar ageing — dramatically so for NMC — and operating outside the OEM SoC window is a common warranty exclusion.',
    definition:
      'SoC is the present charge as a fraction of usable capacity. OEMs specify an allowed SoC window (often 10–95%). Where within that window you spend time matters: high average SoC is, for NMC, the single largest controllable degradation driver.',
    formula: 'SoC (%) = (present charge ÷ usable capacity) × 100',
    typicalRange:
      'OEM SoC window: typically 10–95%. Sustained dwell above 90% accelerates NMC calendar degradation by roughly an order of magnitude; LFP is much less sensitive to SoC dwell.',
    whyItMatters:
      'Capping upper SoC at 90% in low-revenue hours is one of the cheapest longevity levers available, especially for NMC. Conversely, leaving an arbitrage asset parked at high SoC overnight quietly burns warranty life. SoC-window violations can also void cover.',
    howNuravoltTracks:
      'NuraVolt monitors SoC dwell distribution against the OEM window, flags prolonged high- or low-SoC dwell as warranty-relevant, and quantifies the calendar-ageing cost of the current SoC strategy.',
    relatedMetrics: ['state-of-health', 'depth-of-discharge'],
    extraRelated: [
      {
        title: 'BESS capacity fade',
        href: '/faults/bess-capacity-fade',
        description: 'High-SoC dwell is a primary driver of fade in NMC.',
      },
    ],
    faq: [
      {
        q: 'Is it bad to keep a battery at 100%?',
        a: 'For NMC, yes — sustained high SoC dwell sharply accelerates calendar ageing. Capping at ~90% during idle/low-revenue periods materially slows degradation with little revenue impact. LFP tolerates high SoC far better.',
      },
    ],
    sources: ['public/data/manuals/seed/synthetic/bess-warranty-and-degradation.md'],
    datePublished: PUBLISHED,
  },
  {
    slug: 'warranty-as-data-product',
    title: 'Warranty as a data product',
    intro: 'Turning operating data into a defensible — or contestable — warranty position.',
    quickAnswer:
      'Treating the BESS warranty as a data product means continuously measuring the operating conditions and degradation the contract actually cares about — SoH curve, energy throughput, SoC/temperature windows, C-rate — so that a claim is backed by evidence and an exclusion can be contested rather than assumed.',
    definition:
      'BESS warranties hinge on two limits (capacity retention and energy throughput) plus operating-window conditions whose violation voids cover. Most operators discover where they stand only when a dispute arises. As a data product, the warranty position is computed continuously from SCADA/BMS data and kept claim-ready.',
    typicalRange:
      'Warranty floors: ≥70% SoH at 10 years (or ≥60% at 20), plus an energy-throughput cap in MWh/EFC. Exclusions commonly cover SoC-window, temperature-window, cycles/day, and C-rate violations.',
    whyItMatters:
      'Warranty disputes are won or lost on data. If you can show degradation exceeding 2× the contracted curve while staying inside every operating window, you have a claim. If the OEM can show a temperature- or SoC-window violation, they have a defence. Whoever holds the better-instrumented record wins.',
    howNuravoltTracks:
      'NuraVolt continuously tracks SoH against the contracted curve, accrues EFC against the throughput budget, and logs every SoC-, temperature-, and C-rate-window event with the cell-level evidence (voltage histograms, 90-day temperature and SoC traces, BMS fault logs) that an OEM claim requires.',
    relatedMetrics: ['state-of-health', 'equivalent-full-cycles', 'c-rate'],
    extraRelated: [
      {
        title: 'Why warranty disputes are won or lost in SCADA data',
        href: '/insights/warranty-disputes-scada-data',
        description: 'The longer argument behind this metric.',
      },
      {
        title: 'Best BESS monitoring software in 2026',
        href: '/compare/best-bess-monitoring-software-2026',
        description: 'The warranty-tracking platforms, compared honestly.',
      },
    ],
    faq: [
      {
        q: 'What evidence does an OEM warranty claim need?',
        a: 'Typically cell-level voltage histograms, the last 90 days of temperature and SoC traces, all relevant BMS fault events, and SoH versus the contracted curve. Capturing this continuously — not reconstructing it after the fact — is what makes a claim defensible.',
      },
      {
        q: 'Can good data also work against me?',
        a: 'It can surface that your own dispatch caused the degradation (e.g. high-SoC dwell or C-rate exceedances). That’s exactly why operators want to see it first — to fix dispatch before it becomes the OEM’s defence.',
      },
    ],
    sources: ['public/data/manuals/seed/synthetic/bess-warranty-and-degradation.md'],
    datePublished: PUBLISHED,
  },
  {
    slug: 'augmentation',
    title: 'Battery augmentation',
    intro: 'Adding capacity mid-life to hold a contracted output as cells fade.',
    quickAnswer:
      'Battery augmentation is the planned addition of cells or modules partway through a BESS’s life to restore capacity lost to degradation, so the asset keeps meeting its contracted MWh. It is the main alternative to overbuilding up front, and in 2026 it is the central degradation-economics decision for storage operators — one that good analytics can defer and shrink.',
    definition:
      'A BESS fades below its nameplate every year, so to keep delivering a fixed contracted energy it must either start oversized (overbuild) or have capacity added later (augment). Augmentation means installing extra modules — often in Year 5–7 — sized to the cumulative capacity loss. The trade-off is capital timing, warranty interaction, and increasingly the investment-tax-credit treatment of the added capacity.',
    formula: 'Augmentation energy ≈ contracted capacity − (rated capacity × current SoH)',
    typicalRange:
      'Overbuild margins of ~15–20% up front, or a first augmentation around Year 5–7, are common. The cheaper path depends on the real degradation rate: a pack ageing slower than the warranty curve can push augmentation out by years and cut its size.',
    whyItMatters:
      'Augmentation reserves are a large line in any storage LCOS model, and mis-timing them is expensive — augment too early and you spend capital you didn’t need; too late and you breach the offtake. Because the right date is set by actual SoH, not the contract’s conservative curve, measured degradation directly moves the spend.',
    howNuravoltTracks:
      'NuraVolt trends measured SoH against the contracted degradation curve, projects the date the asset crosses its contracted-capacity floor, and shows how much augmentation can be deferred and downsized when the real fade rate beats the warranty assumption — turning the augmentation budget into a data-driven schedule.',
    relatedMetrics: ['state-of-health', 'capacity-maintenance', 'equivalent-full-cycles', 'levelized-cost-of-storage'],
    extraRelated: [
      {
        title: 'BESS capacity fade',
        href: '/faults/bess-capacity-fade',
        description: 'The degradation that augmentation exists to offset.',
      },
      {
        title: 'Augment or overbuild? The BESS capacity decision',
        href: '/blog/augment-vs-overbuild',
        description: 'The strategy argument in long form.',
      },
      {
        title: 'Best BESS monitoring software in 2026',
        href: '/compare/best-bess-monitoring-software-2026',
        description: 'The platforms that track the SoH behind this decision.',
      },
    ],
    extraSections: [
      {
        heading: 'The economics, in published numbers',
        blocks: [
          {
            type: 'paragraph',
            text: 'The case for deferring capacity rather than overbuilding it rests on one published trend: batteries keep getting cheaper. BloombergNEF’s annual price survey put lithium-ion pack prices at a record-low 115 dollars per kWh in 2024, down 20 percent in a single year from 139 dollars in 2023, driven by cell manufacturing overcapacity and LFP adoption. Modo Energy’s GB analysis makes the same point from the fleet: with cell costs at record lows, an operating battery could regain 44 percent of its original capacity for less than half the cost of the original install. Augmentation is no longer exotic, either: Modo counted at least 113 MWh of GB capacity added through augmentation of existing batteries in 2024, with a further 220 MWh planned by year-end. And because duration earns, the same intervention can be an upgrade: Modo measured two-hour GB systems earning 37 percent more than one-hour systems over January to August 2024.',
          },
          {
            type: 'table',
            caption: 'Published figures behind the augmentation decision, each row cited.',
            headers: ['Fact', 'Published figure', 'Source'],
            rows: [
              ['Lithium-ion pack price, 2024', '115 dollars per kWh, down 20 percent year on year', 'BloombergNEF Battery Price Survey, December 2024'],
              ['Fleet degradation, first year', 'Up to 5 percent of available energy capacity', 'Modo Energy, GB fleet research'],
              ['Fleet degradation, GB average after 365 cycles', 'About 4.4 percent, with some systems up to 11 percent', 'Modo Energy, GB degradation research 2025'],
              ['Capacity regained per unit spend', '44 percent of original capacity at less than half original cost', 'Modo Energy augmentation explainer, 2024'],
              ['GB capacity added by augmentation, 2024', 'At least 113 MWh, plus 220 MWh planned', 'Modo Energy augmentation explainer, 2024'],
              ['Duration premium, GB, Jan to Aug 2024', 'Two-hour systems earned 37 percent more than one-hour', 'Modo Energy investment-case research, December 2024'],
            ],
          },
        ],
      },
      {
        heading: 'Augment or overbuild: how the decision actually falls',
        blocks: [
          {
            type: 'paragraph',
            text: 'The two standard strategies are oversizing at commissioning or augmenting periodically through life. Overbuild buys certainty at today’s prices and avoids mid-life integration work; augmentation defers capital into cheaper future cells but adds engineering complexity, mixed-age racks, and warranty interactions. The published price trajectory has been shifting the answer toward augmentation, but the deciding variable is plant-specific: the real degradation rate. Measured GB fleet fade of about 4.4 percent per 365 cycles is lower than many warranty curves assume, largely because assets rarely run full-depth discharges, so an operator who trends measured SoH against the contracted curve frequently discovers the first augmentation can be later and smaller than the financial model booked. That discovery is worth real money, and it is only available to operators who measure.',
          },
        ],
      },
    ],
    faq: [
      {
        q: 'What is battery augmentation?',
        a: 'Battery augmentation is adding new cells, modules, or racks to an operating BESS partway through its life to restore capacity lost to degradation, so the asset keeps meeting its contracted energy. It is the alternative to oversizing the system at construction, and it is increasingly attractive because battery prices keep falling: BloombergNEF measured pack prices at a record-low 115 dollars per kWh in 2024.',
      },
      {
        q: 'Augmentation or overbuild — which is cheaper?',
        a: 'It depends on the real degradation rate and on tax treatment. Overbuilding spends capital up front; augmentation defers it into cheaper future cells but may complicate investment-tax-credit eligibility on the added capacity. Operators who measure actual SoH can often defer and shrink augmentation versus the conservative warranty assumption.',
      },
      {
        q: 'When do most operators first augment a BESS?',
        a: 'Frequently around Year 5 to 7, sized to the cumulative capacity lost by then. The exact timing should be driven by measured State of Health crossing the contracted-capacity floor, not by a fixed calendar date. Measured GB fleet degradation of about 4.4 percent per 365 cycles, per Modo Energy, is slower than many warranty curves assume, which often pushes the optimal date later.',
      },
      {
        q: 'How much does battery augmentation cost?',
        a: 'There is no list price; augmentation is an engineered project whose cost tracks cell prices, integration work, and how much capacity is being added. The published anchors: pack prices hit 115 dollars per kWh in 2024 per BloombergNEF, and Modo Energy estimated an operating battery could regain 44 percent of its original capacity for less than half the original install cost at current cell prices.',
      },
    ],
    sources: [
      'public/data/manuals/seed/synthetic/bess-warranty-and-degradation.md',
      'BloombergNEF, Lithium-Ion Battery Pack Prices, December 2024',
      'Modo Energy, augmentation explainer and GB degradation research, 2024 to 2025',
      'Burns and McDonnell, Battery Energy Storage Augmentation: Key Project Considerations',
    ],
    datePublished: '2026-08-12',
  },
  {
    slug: 'capacity-maintenance',
    title: 'Capacity maintenance & the warranty fade threshold',
    intro: 'Keeping usable capacity above the contracted curve over the asset’s life.',
    quickAnswer:
      'Capacity maintenance is the practice of keeping a BESS’s usable capacity above the curve its warranty and offtake guarantee — typically ≥70% State of Health at 10 years. The warranty fade threshold is the line that, once crossed, triggers a claim, an augmentation, or a penalty. Staying above it is the core long-horizon BESS management goal.',
    definition:
      'Every BESS warranty defines a capacity-retention curve (e.g. ≥70% at 10 years, ≥60% at 20) and a set of operating-window conditions that must hold for it to apply. Capacity maintenance is managing dispatch — depth of discharge, SoC window, C-rate, temperature — so the pack tracks at or above that curve, and detecting early when it is heading below.',
    formula: 'Headroom = current SoH − contracted SoH(t)   (must stay ≥ 0)',
    typicalRange:
      'Warranty floors: commonly ≥70% SoH at 10 years (or ≥60% at 20). A degradation rate sustained above ~2× the contracted curve over a 90-day window is the conventional warning that capacity maintenance is failing.',
    whyItMatters:
      'Whether the pack stays above its fade threshold decides three things at once: warranty standing, the timing of any augmentation spend, and offtake compliance. Catching a too-fast fade early can mean a warranty claim while you still have evidence; catching it late means an augmentation you pay for yourself.',
    howNuravoltTracks:
      'NuraVolt continuously compares measured SoH to the contracted fade curve, raises a warranty-grade alert when degradation runs above the threshold rate, and links the cause (high-SoC dwell, C-rate, temperature) so dispatch can be corrected before the floor is breached.',
    relatedMetrics: ['state-of-health', 'augmentation', 'warranty-as-data-product', 'depth-of-discharge'],
    extraRelated: [
      {
        title: 'BESS capacity fade',
        href: '/faults/bess-capacity-fade',
        description: 'The fault mode when capacity maintenance fails.',
      },
    ],
    faq: [
      {
        q: 'What is the warranty fade threshold?',
        a: 'It is the capacity-retention line the warranty guarantees — often ≥70% State of Health at 10 years. Crossing it earlier than the contracted curve allows is what creates a warranty claim; staying above it is the goal of capacity maintenance.',
      },
    ],
    sources: ['public/data/manuals/seed/synthetic/bess-warranty-and-degradation.md'],
    datePublished: '2026-06-15',
  },
  {
    slug: 'availability',
    title: 'BESS availability',
    intro: 'The share of committed time the storage asset could actually respond.',
    quickAnswer:
      'BESS availability is the fraction of contracted time the system was able to charge or discharge on demand, excluding downtime from faults, auxiliary failures, or grid issues. Storage revenue — especially in ancillary and capacity markets — is paid for being ready, so availability, usually energy- or capacity-weighted, is a first-order commercial metric, not a footnote.',
    definition:
      'Availability measures readiness: the time the asset could deliver its committed power and energy versus the time it was committed. For storage it is often weighted by the value of the windows missed, because an outage during a capacity-market event or a high-price hour costs far more than the same minutes when idle. It is distinct from efficiency — a pack can be fully available yet have poor round-trip efficiency.',
    formula: 'Availability (%) = available (committed) time ÷ total committed time × 100',
    typicalRange:
      'Ancillary- and capacity-market contracts commonly require ≥97–99% availability, with penalties for shortfalls and, in some markets, severe non-delivery charges during called events. Auxiliary (HVAC, PCS) faults are a frequent, under-watched cause of lost availability.',
    whyItMatters:
      'In capacity and ancillary markets you are paid to be ready; a missed dispatch during a called event can cost far more than the energy itself and can damage the asset’s market standing. Tracking availability — and attributing downtime to cause — is how operators protect both the penalty exposure and the revenue.',
    howNuravoltTracks:
      'NuraVolt computes availability from PCS, BMS, and auxiliary status, weights lost time by the market value of the windows affected, and attributes downtime to cause (cell fault, PCS trip, cooling failure, grid) so the costliest readiness gaps are fixed first.',
    relatedMetrics: ['round-trip-efficiency', 'state-of-health', 'c-rate'],
    extraRelated: [
      {
        title: 'BESS thermal stress',
        href: '/faults/bess-thermal-stress',
        description: 'Cooling faults are a common cause of lost availability.',
      },
    ],
    faq: [
      {
        q: 'Why does availability matter so much for batteries?',
        a: 'In ancillary and capacity markets you are paid for being ready to respond, not just for energy delivered. A storage asset that is unavailable during a called event can face penalties far larger than the energy value, so readiness — measured as availability — is a primary revenue driver.',
      },
    ],
    sources: ['notebooks/bess_analytics_crash_course.ipynb'],
    datePublished: '2026-06-15',
  },
  {
    slug: 'levelized-cost-of-storage',
    title: 'Levelised Cost of Storage (LCOS)',
    intro: 'The all-in cost per MWh cycled through the battery over its life.',
    quickAnswer:
      'Levelised Cost of Storage (LCOS) is the total lifetime cost of a storage asset — capital, augmentation, O&M, charging energy and losses — divided by the total energy it discharges over its life, in currency per MWh. It is the storage analogue of LCOE and the number that decides whether a project pencils, with degradation and augmentation as major swing factors.',
    definition:
      'LCOS sums every discounted cost over the asset’s life (capex, augmentation reserves, fixed and variable O&M, charging energy, and round-trip losses) and divides by the discounted lifetime energy discharged. Because degradation reduces both the energy delivered and the timing of augmentation spend, the assumed fade rate strongly drives the result.',
    formula: 'LCOS = Σ discounted lifetime costs ÷ Σ discounted lifetime energy discharged',
    typicalRange:
      'LCOS varies widely with duration, cycles per day, and market, but it is dominated by capex, round-trip efficiency, and degradation/augmentation assumptions. Improving real-world RTE or deferring augmentation both pull LCOS down directly.',
    whyItMatters:
      'LCOS is how storage projects are compared and financed. Two inputs operators can actually influence — round-trip efficiency and the degradation rate that sets augmentation timing — flow straight into it, so operational performance and LCOS are tightly linked rather than separate concerns.',
    howNuravoltTracks:
      'NuraVolt feeds LCOS models the measured inputs that usually come from assumptions: real RTE per cycle, actual SoH-driven augmentation timing, and availability — so the cost-per-MWh reflects how the asset is genuinely performing, and the levers that lower it are visible.',
    relatedMetrics: ['round-trip-efficiency', 'augmentation', 'equivalent-full-cycles', 'availability'],
    faq: [
      {
        q: 'What drives Levelised Cost of Storage down the most?',
        a: 'Capex aside, the operational levers are round-trip efficiency (fewer losses per cycle), throughput (more lifetime MWh over the same fixed cost), and degradation — a slower real fade rate defers and shrinks augmentation spend. All three are things measurement and degradation-aware dispatch can improve.',
      },
    ],
    sources: ['notebooks/bess_analytics_crash_course.ipynb'],
    datePublished: '2026-06-15',
  },
];

const BESS_HUB = { label: 'BESS metrics', href: '/bess' };

export function getBessMetric(slug: string): BessMetricEntry | undefined {
  return bessMetrics.find((m) => m.slug === slug);
}

export function normalizeBessMetric(entry: BessMetricEntry): ArticleView {
  const sections: ContentSection[] = [
    { heading: 'Definition', blocks: [{ type: 'paragraph', text: entry.definition }] },
    ...(entry.formula
      ? [{ heading: 'Formula', blocks: [{ type: 'code' as const, text: entry.formula }] }]
      : []),
    { heading: 'Typical range', blocks: [{ type: 'paragraph', text: entry.typicalRange }] },
    { heading: 'Why it matters', blocks: [{ type: 'paragraph', text: entry.whyItMatters }] },
    {
      heading: 'How NuraVolt tracks it',
      blocks: [{ type: 'paragraph', text: entry.howNuravoltTracks }],
    },
    ...(entry.extraSections ?? []),
  ];

  const related: RelatedLink[] = [
    ...entry.relatedMetrics
      .map((slug) => bessMetrics.find((m) => m.slug === slug))
      .filter((m): m is BessMetricEntry => Boolean(m))
      .map((m) => ({ title: m.title, href: `/bess/${m.slug}`, description: m.intro })),
    ...(entry.extraRelated ?? []),
  ];

  return {
    category: 'BESS metric',
    hub: BESS_HUB,
    slug: entry.slug,
    urlRelative: `/bess/${entry.slug}`,
    title: entry.title,
    intro: entry.intro,
    quickAnswer: entry.quickAnswer,
    sections,
    faq: entry.faq,
    related,
    datePublished: entry.datePublished,
    sources: entry.sources,
  };
}
