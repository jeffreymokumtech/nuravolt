import type { ArticleView, ContentSection, FAQ, RelatedLink } from './types';

/**
 * Template E — PV performance-metric catalog (the PV-side counterpart to the
 * BESS metrics catalog). Performance Ratio, CUF, specific yield, availability
 * and the temperature-corrected variants are the exact terms PV operators and
 * asset managers search, and they anchor NuraVolt's PV-monitoring authority.
 *
 * Shares the BessMetric rendering shape (definition / formula / range / why /
 * how-we-track) via normalizePvMetric().
 */

const PUBLISHED = '2026-06-15';

export interface PvMetricEntry {
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

export const pvMetrics: PvMetricEntry[] = [
  {
    slug: 'performance-ratio',
    title: 'Solar Performance Ratio (PR): formula, averages and what is good',
    intro: 'The headline efficiency number for a PV plant, independent of weather.',
    quickAnswer:
      'Performance Ratio (PR) is the ratio of a PV plant’s actual energy yield to the yield it would have produced at its nameplate efficiency under the irradiation it actually received. It normalises out the weather, so it is the single number that says how well the plant is converting available sunlight. Average PR for modern plants is roughly 80 to 90 percent (Fraunhofer ISE); measured weather-adjusted fleet averages in the US run 91 to 94 percent, while unmanaged distributed fleets can sit near 79 percent.',
    definition:
      'PR divides measured AC energy by the theoretical energy from the plane-of-array irradiation at STC efficiency. Because it cancels the irradiance the plant received, a falling PR points to losses inside the plant — soiling, degradation, downtime, clipping, thermal losses — rather than to a cloudy month. It is the EN 61724 benchmark metric for plant health.',
    formula: 'PR = actual energy yield ÷ (POA irradiation × nameplate DC ÷ STC irradiance)',
    typicalRange:
      'Well-run utility-scale plants: PR ≈ 0.80–0.85. New plants can exceed 0.85 in mild climates; hot desert sites sit lower because of temperature losses. A PR below ~0.75, or a downward trend, signals recoverable loss.',
    whyItMatters:
      'PR is the term in nearly every O&M contract and performance guarantee, and the metric lenders track. A 2-point PR slip on a large plant is six figures a year in lost generation. Because it strips out weather, a falling PR is the earliest honest signal that something inside the plant — not the sky — is costing yield.',
    howNuravoltTracks:
      'NuraVolt computes PR continuously from POA irradiance and AC output, decomposes the gap to nameplate into named loss buckets (soiling, temperature, availability, clipping, degradation), and trends each — so a PR decline is attributed to a cause and a euro figure, not just flagged.',
    relatedMetrics: ['temperature-corrected-pr', 'specific-yield', 'capacity-utilization-factor', 'energy-performance-index'],
    extraRelated: [
      {
        title: 'Soiling loss',
        href: '/faults/soiling-loss',
        description: 'A leading recoverable drain on PR.',
      },
      {
        title: 'PV string underperformance',
        href: '/faults/pv-string-underperformance',
        description: 'Hardware loss that drags PR down and never recovers with rain.',
      },
      {
        title: 'Best solar monitoring software in 2026',
        href: '/compare/best-solar-monitoring-software-2026',
        description: 'The platforms that track PR, compared honestly.',
      },
    ],
    extraSections: [
      {
        heading: 'Average performance ratio: published benchmarks',
        blocks: [
          {
            type: 'paragraph',
            text: 'There is no single "average PR" because studies measure different flavours of the metric: raw PR includes temperature losses, weather-adjusted PR corrects them out, which is why fleet studies report higher numbers than raw rules of thumb. The table below only contains published, sourced figures.',
          },
          {
            type: 'table',
            caption: 'Published PR benchmarks. PR definition varies by study (raw vs weather-adjusted); each row cites its source.',
            headers: ['Fleet / era', 'Performance ratio', 'Source'],
            rows: [
              ['Modern plants, industry-wide rule of thumb', 'About 80 to 90 percent (raw)', 'Fraunhofer ISE, Photovoltaics Report'],
              ['Plants built before 2000', 'About 70 percent', 'Fraunhofer ISE, Photovoltaics Report'],
              ['US fleet study, 250 systems, 157 MW', '93.5 percent average (adjusted)', 'Deline et al. 2020, via US DOE performance report 2022'],
              ['California fleet, 2,200 reporting systems', '91.7 percent weather-adjusted average', 'Walker et al. 2019, via US DOE performance report 2022'],
              ['Germany, 100 systems, 2010', '70 to 90 percent, median 84 percent', 'Reich et al. 2012, Progress in Photovoltaics'],
              ['US federal buildings, 75 mostly unmanaged systems', 'About 79 percent average when running', 'US DOE performance report 2022'],
              ['1980s-era systems', 'Around 70 percent', 'IEA-PVPS Task 13 long-term performance report'],
            ],
          },
          {
            type: 'paragraph',
            text: 'Two more published numbers frame what "good" means. NREL’s O&M best-practices report (3rd edition) estimates that comprehensive O&M could lift the average age-and-temperature-adjusted PR of US systems from 91.7 percent to at least 95 percent, which is the recoverable-loss argument in one sentence. And kWh Analytics’ Solar Risk Assessment 2025 found US PV sites underperforming their P50 production estimates by 8.6 percent on average across roughly 34,000 system-months, meaning the typical plant has more recoverable loss than its owner assumes. Module degradation compounds this slowly: NREL’s Jordan and Kurtz compendium puts median crystalline-silicon degradation at 0.5 to 0.6 percent per year, with the mean nearer 0.8 percent.',
          },
        ],
      },
      {
        heading: 'PR in contracts: guarantees for IPPs and utilities',
        blocks: [
          {
            type: 'paragraph',
            text: 'PR guarantees used to be the standard performance clause in EPC and O&M contracts, and they still appear, most often where the EPC and the O&M provider are the same company. SolarPower Europe’s O&M Best Practice Guidelines now recommend availability and response-time guarantees instead, citing a minimum guaranteed contractual availability of 98 percent over a year as best practice, because an O&M contractor controls uptime but not irradiance sensors, soiling regimes, or degradation. For an IPP the practical consequence cuts both ways: if your contract carries a PR guarantee, the metering and sensor basis of the PR calculation decides disputes, and if it carries an availability guarantee instead, PR becomes your own internal health metric rather than the contractor’s liability, which makes independent PR tracking more important, not less.',
          },
        ],
      },
    ],
    faq: [
      {
        q: 'What is a good Performance Ratio?',
        a: 'For a well-run utility-scale plant, a raw PR of 0.80 to 0.85 is the classic rule of thumb, and weather-adjusted fleet averages in published US studies run 91 to 94 percent. New plants in mild climates can exceed the rule of thumb; hot sites run lower because high cell temperature depresses efficiency. The trend matters more than the absolute: a steadily falling PR is the signal to act.',
      },
      {
        q: 'What is the average performance ratio of a solar plant?',
        a: 'Published benchmarks put modern plants at roughly 80 to 90 percent raw PR (Fraunhofer ISE), with weather-adjusted fleet averages of 91.7 to 93.5 percent in large US studies and a median of 84 percent in a 100-system German sample. Unmanaged distributed fleets score far worse: a 75-system US federal study averaged about 79 percent. The spread between those numbers is mostly management, not hardware.',
      },
      {
        q: 'How do you calculate performance ratio?',
        a: 'Divide the energy the plant actually exported by the energy it theoretically could have produced: plane-of-array irradiation multiplied by nameplate DC capacity and divided by irradiance at standard test conditions. The result is a fraction, usually 0.7 to 0.9. The sensor basis matters: a drifting or soiled irradiance sensor changes PR without anything changing in the plant.',
      },
      {
        q: 'What causes performance ratio to drop?',
        a: 'The usual suspects, roughly in order of how often they are recoverable: soiling, inverter or string downtime, curtailment and clipping accounting errors, thermal derating, sensor drift, and module degradation. Degradation is the slowest, at a published median of 0.5 to 0.6 percent per year for crystalline silicon; anything falling faster than that has another cause, and attributing the drop to a named cause is the whole job of PR analytics.',
      },
      {
        q: 'Why is PR better than just looking at energy output?',
        a: 'Raw output rises and falls with the weather, so a low-output month tells you nothing on its own. PR normalises out the irradiation the plant actually received, isolating losses that are inside the plant and therefore (often) recoverable.',
      },
    ],
    sources: [
      'IEC 61724-1 performance monitoring',
      'Fraunhofer ISE, Photovoltaics Report',
      'US DOE / NREL, Understanding Solar Photovoltaic System Performance, February 2022',
      'NREL, Best Practices for Operation and Maintenance of Photovoltaic and Energy Storage Systems, 3rd edition (NREL/TP-7A40-73822)',
      'IEA-PVPS, Analysis of Long-Term Performance of PV Systems, T13-05:2014',
      'Jordan and Kurtz, Compendium of Photovoltaic Degradation Rates, NREL 2016',
      'kWh Analytics, Solar Risk Assessment 2025',
      'SolarPower Europe, O&M Best Practice Guidelines v5.0',
      'nuravolt/digitaltwin/hybrid_model.py',
    ],
    datePublished: '2026-08-21',
  },
  {
    slug: 'temperature-corrected-pr',
    title: 'Temperature-corrected Performance Ratio',
    intro: 'PR with the weather’s heat penalty removed, so real losses stand out.',
    quickAnswer:
      'Temperature-corrected PR adjusts standard Performance Ratio for module temperature, removing the seasonal efficiency loss caused by hot cells. Because raw PR sags every summer purely from heat, the corrected version is what reveals genuine, recoverable losses — and is the fairer basis for comparing months or benchmarking sites in different climates.',
    definition:
      'A silicon module loses roughly 0.3–0.45%/°C above 25°C. Standard PR therefore drops in summer even on a perfectly healthy plant. Temperature-corrected PR (PR_temp, per IEC 61724) applies the modules’ temperature coefficient to normalise output to a reference cell temperature, so what remains reflects soiling, degradation, downtime and wiring losses rather than the season.',
    formula: 'PR_temp = PR ÷ [1 − γ × (T_cell − T_ref)]   (γ = module temp. coefficient)',
    typicalRange:
      'Temperature-corrected PR is flatter across the year than raw PR and typically sits a few points higher in summer. A persistent gap that the temperature correction does not close is the recoverable-loss signal.',
    whyItMatters:
      'Without the correction, every plant looks like it degrades each summer and recovers each winter, masking real faults under a seasonal sawtooth. Performance guarantees and like-for-like site benchmarking depend on the temperature-corrected figure; arguing a warranty or O&M SLA on raw PR invites a weather counter-argument.',
    howNuravoltTracks:
      'NuraVolt applies each module type’s temperature coefficient using measured or modelled cell temperature, reports both raw and temperature-corrected PR, and isolates the residual loss after the heat penalty is removed — so a real fault is no longer hidden inside the summer dip.',
    relatedMetrics: ['performance-ratio', 'specific-yield', 'energy-performance-index'],
    extraRelated: [
      {
        title: 'Inverter clipping',
        href: '/faults/inverter-clipping',
        description: 'Another loss bucket that can mask itself in raw PR.',
      },
    ],
    faq: [
      {
        q: 'Why does Performance Ratio fall in summer?',
        a: 'Mostly heat. Silicon modules lose about 0.3–0.45% of output per °C above 25°C, so hot cells convert less efficiently. Temperature-corrected PR removes that penalty, leaving only losses that are actually inside your control.',
      },
    ],
    sources: ['IEC 61724-1 performance monitoring'],
    datePublished: PUBLISHED,
  },
  {
    slug: 'specific-yield',
    title: 'Specific yield (kWh/kWp)',
    intro: 'Energy produced per unit of installed capacity — the cross-site comparator.',
    quickAnswer:
      'Specific yield is the energy a plant produces per unit of installed DC capacity, in kWh per kWp, over a period (often a year). Because it divides out plant size, it lets you compare a 5 MWp and a 200 MWp plant — or two sites in different climates — on equal footing. It blends resource quality and plant performance into one figure.',
    definition:
      'Specific yield = total energy produced ÷ installed DC capacity. Unlike PR, it does not normalise out irradiation, so a sunnier site shows a higher specific yield even at the same efficiency. It is the natural unit for fleet benchmarking, yield-forecast validation, and expressing a site’s resource in operator-friendly terms.',
    formula: 'Specific yield (kWh/kWp) = energy produced (kWh) ÷ installed DC capacity (kWp)',
    typicalRange:
      'Annual specific yield runs ~900–1,200 kWh/kWp in Northern Europe, ~1,500–1,900 in Iberia and ~1,800–2,200 in the Gulf and other high-irradiation regions. Below the regional norm, with PR healthy, usually means a weaker resource year rather than a plant fault.',
    whyItMatters:
      'Specific yield is how owners compare assets across a portfolio and how actuals are checked against the P50/P90 yield forecast that underwrote the financing. A site running below its forecast specific yield triggers the question PR then answers: is it the weather, or the plant?',
    howNuravoltTracks:
      'NuraVolt reports specific yield per plant and per portfolio, benchmarks it against the site’s P50/P90 forecast and against climate-comparable peers, and pairs it with PR so an underperforming site is immediately split into resource shortfall versus recoverable plant loss.',
    relatedMetrics: ['performance-ratio', 'capacity-utilization-factor', 'energy-performance-index'],
    faq: [
      {
        q: 'How is specific yield different from Performance Ratio?',
        a: 'Specific yield (kWh/kWp) includes how sunny the site is, so a better location scores higher. PR removes the irradiation, isolating plant efficiency. Use specific yield to compare actuals to a yield forecast; use PR to tell whether a shortfall is weather or a fault.',
      },
    ],
    sources: ['nuravolt/digitaltwin/plant_factory.py'],
    datePublished: PUBLISHED,
  },
  {
    slug: 'capacity-utilization-factor',
    title: 'Capacity Utilisation Factor (CUF)',
    intro: 'The share of nameplate a plant actually delivered over time.',
    quickAnswer:
      'Capacity Utilisation Factor (CUF), also called capacity factor, is the energy a plant produced as a fraction of what it would produce running at full nameplate every hour of the period. For fixed-tilt PV it is typically 15–25%, capped by day/night and the sun’s arc. It is widely used in tenders and PPAs, though it conflates resource with performance.',
    definition:
      'CUF = actual energy ÷ (rated power × hours in period). Because the sun shines part of the day and at varying angles, even a flawless PV plant has a CUF well below 100%. Trackers and sunnier sites raise it. Unlike PR it does not separate the resource from plant health, so it is a contract/headline metric rather than a diagnostic.',
    formula: 'CUF (%) = energy produced ÷ (rated capacity × hours in period) × 100',
    typicalRange:
      'Fixed-tilt PV: ~15–20%. Single-axis trackers or high-irradiation sites: ~20–28%. The figure is structurally capped by the day-night cycle and solar geometry, so a "low" CUF is normal for PV and should be read against regional norms.',
    whyItMatters:
      'CUF appears in government tenders, PPA terms and investor reporting because it is simple and comparable across technologies. But two plants with identical CUF can have very different PR — one sunnier, one better-run. Operators need both: CUF for the contract, PR to know what is actually fixable.',
    howNuravoltTracks:
      'NuraVolt reports CUF alongside PR and specific yield so the contract-facing number is never read in isolation: when CUF dips, the platform shows immediately whether PR held (a weaker resource period) or fell (a plant issue worth a truck roll).',
    relatedMetrics: ['specific-yield', 'performance-ratio', 'plant-availability'],
    faq: [
      {
        q: 'Why is a solar plant’s capacity factor so low?',
        a: 'Because the sun is only up part of the day and rarely at the optimal angle, a PV plant cannot run at nameplate around the clock. A CUF of 15–25% is normal and healthy for PV — it reflects solar geometry, not poor performance.',
      },
      {
        q: 'Is CUF the same as Performance Ratio?',
        a: 'No. CUF measures output against nameplate over all hours and bakes in how sunny the site is. PR removes the irradiation to isolate plant efficiency. A high CUF can still hide a falling PR, which is why operators track both.',
      },
    ],
    sources: ['nuravolt/digitaltwin/plant_factory.py'],
    datePublished: PUBLISHED,
  },
  {
    slug: 'plant-availability',
    title: 'Plant availability',
    intro: 'How much of the time the plant was actually able to produce.',
    quickAnswer:
      'Plant availability is the share of time (often weighted by potential generation) that a plant was able to produce, excluding downtime from inverter trips, grid curtailment, or maintenance. Energy-weighted availability — which counts a midday outage far more heavily than a dawn one — is the figure that matters and the one O&M guarantees are usually written against.',
    definition:
      'Time-based availability is simply uptime ÷ total time. Energy-based (or production-weighted) availability weights each outage by the energy that would have been generated then, so an inverter down at noon costs far more than the same outage at dusk. O&M contracts typically guarantee energy-based availability above a threshold, with bonuses or penalties attached.',
    formula: 'Energy availability (%) = (potential − lost energy) ÷ potential × 100',
    typicalRange:
      'Contracted O&M availability guarantees commonly sit at 98–99%+ on an energy-weighted basis. Sustained availability below the contracted floor triggers penalties; the gap between time- and energy-based figures reveals whether outages cluster in high-value hours.',
    whyItMatters:
      'Availability is where O&M performance is rewarded or penalised, and a single mid-day inverter outage left unattended can blow a monthly guarantee. Separating availability loss from efficiency loss is essential: a healthy PR with poor availability is an uptime/response problem, not a degradation problem.',
    howNuravoltTracks:
      'NuraVolt computes energy-weighted availability from inverter and meter status, attributes downtime to cause (inverter trip, grid curtailment, planned maintenance), and ranks outages by the generation they cost — so response is prioritised by euros lost, and the figure is contract-ready.',
    relatedMetrics: ['performance-ratio', 'capacity-utilization-factor', 'energy-performance-index'],
    extraRelated: [
      {
        title: 'Inverter IGBT over-temperature',
        href: '/faults/inverter-igbt-overtemperature',
        description: 'A common driver of mid-day inverter downtime.',
      },
    ],
    faq: [
      {
        q: 'What is the difference between time-based and energy-based availability?',
        a: 'Time-based availability counts every hour of downtime equally. Energy-based (production-weighted) availability weights each outage by the energy it cost, so a noon inverter trip counts far more than a dawn one. O&M guarantees almost always use the energy-based figure.',
      },
    ],
    sources: ['nuravolt/digitaltwin/anomaly_detector.py'],
    datePublished: PUBLISHED,
  },
  {
    slug: 'energy-performance-index',
    title: 'Energy Performance Index (expected vs actual)',
    intro: 'Actual generation measured against a physics model of what the plant should have made.',
    quickAnswer:
      'The Energy Performance Index (EPI) is the ratio of actual energy to the energy a calibrated physics model expected from the measured weather and plant configuration. An EPI near 1.0 means the plant performed as designed; a sustained value below 1.0 quantifies underperformance against expectation rather than against a fixed nameplate, making it the sharpest early-warning metric.',
    definition:
      'EPI = actual energy ÷ model-expected energy, where the expectation comes from a digital-twin/physics model fed the site’s real irradiance, temperature, and as-built configuration. Because the benchmark moves with conditions, EPI isolates the plant-specific gap more tightly than PR — it answers "did this plant make what THIS plant should have, today?"',
    formula: 'EPI = actual energy ÷ expected energy (from the calibrated plant model)',
    typicalRange:
      'A healthy plant tracks EPI ≈ 0.98–1.02 around the model. A persistent EPI below ~0.97, or a downward drift, flags a developing loss; the size of the shortfall is directly the recoverable energy at stake.',
    whyItMatters:
      'PR tells you efficiency against nameplate; EPI tells you efficiency against what the plant should have done under today’s exact conditions, which catches faults earlier and with fewer false alarms from weather. It is the basis for tight performance alerting and for validating performance-guarantee claims with a defensible expectation.',
    howNuravoltTracks:
      'NuraVolt builds a calibrated physics-ML digital twin per plant, computes expected energy from live weather and as-built configuration, and trends EPI with anomaly detection — so an emerging shortfall is caught as a deviation from the plant’s own model, attributed to a loss bucket, and priced.',
    relatedMetrics: ['performance-ratio', 'temperature-corrected-pr', 'specific-yield'],
    extraRelated: [
      {
        title: 'PV string underperformance',
        href: '/faults/pv-string-underperformance',
        description: 'The kind of localised loss EPI surfaces early.',
      },
    ],
    faq: [
      {
        q: 'How is the Energy Performance Index different from Performance Ratio?',
        a: 'PR compares output to nameplate efficiency under the irradiation received. EPI compares output to a calibrated model of what this specific plant should have produced under today’s exact conditions. The moving, plant-specific benchmark makes EPI catch faults earlier with fewer weather-driven false alarms.',
      },
    ],
    sources: ['nuravolt/digitaltwin/hybrid_model.py', 'nuravolt/digitaltwin/anomaly_detector.py'],
    datePublished: PUBLISHED,
  },
];

const PV_HUB = { label: 'PV metrics', href: '/pv-metrics' };

export function getPvMetric(slug: string): PvMetricEntry | undefined {
  return pvMetrics.find((m) => m.slug === slug);
}

export function normalizePvMetric(entry: PvMetricEntry): ArticleView {
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
      .map((slug) => pvMetrics.find((m) => m.slug === slug))
      .filter((m): m is PvMetricEntry => Boolean(m))
      .map((m) => ({ title: m.title, href: `/pv-metrics/${m.slug}`, description: m.intro })),
    ...(entry.extraRelated ?? []),
  ];

  return {
    category: 'PV metric',
    hub: PV_HUB,
    slug: entry.slug,
    urlRelative: `/pv-metrics/${entry.slug}`,
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
