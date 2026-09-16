import type { ArticleView, ContentSection, FAQ, RelatedLink } from './types';

/**
 * Template D — Thought / consequence articles (used sparingly).
 *
 * Unlike the catalog templates, the body is authored directly as
 * ContentSection[] so each piece reads as long-form prose. Substance is drawn
 * from docs/technical/SOILING_METHODOLOGY.md, the BESS warranty manual, and the platform's
 * compliance/PPA work.
 */

const PUBLISHED = '2026-06-09';

export interface InsightEntry {
  slug: string;
  title: string;
  intro: string;
  quickAnswer: string;
  sections: ContentSection[];
  faq: FAQ[];
  related: RelatedLink[];
  sources?: string[];
  datePublished?: string;
}

export const insights: InsightEntry[] = [
  {
    slug: 'warranty-disputes-scada-data',
    title: 'Why warranty disputes are won or lost in SCADA data',
    intro: 'The BESS warranty you bought is only as strong as the operating record you can produce.',
    quickAnswer:
      'BESS warranty disputes are decided by evidence. A claim succeeds when you can show degradation exceeding the contracted curve while proving you stayed inside every operating window; it fails when the OEM can point to an SoC-, temperature-, or C-rate-window violation in your own data. Whoever holds the better-instrumented record wins.',
    sections: [
      {
        heading: 'The warranty is two limits and a set of conditions',
        blocks: [
          {
            type: 'paragraph',
            text: 'A utility BESS warranty typically guarantees the lower of two limits — capacity retention (e.g. ≥70% SoH at 10 years) and energy throughput (a cap in MWh or equivalent full cycles) — whichever is reached first. Around those sit operating-window conditions: an SoC window (often 10–95%), a temperature window (often 0–35 °C cell), cycles-per-day and C-rate limits. Violate a condition and the OEM can decline a claim.',
          },
        ],
      },
      {
        heading: 'Disputes are evidentiary, not technical',
        blocks: [
          {
            type: 'paragraph',
            text: 'When a pack degrades faster than expected, both sides reach for the data. The operator wants to show the degradation is anomalous and the asset was run within spec. The OEM wants to find a window violation that explains the fade as the operator’s fault. The argument is won by whoever can produce the cleaner, more complete record — not by whoever has the better physics.',
          },
          {
            type: 'paragraph',
            text: 'A defensible claim package usually needs: SoH versus the contracted curve, cell-level voltage histograms, the last 90 days of temperature and SoC traces, and the relevant BMS fault events. Reconstructing that after a dispute starts is hard and looks weak. Capturing it continuously makes the claim self-evident.',
          },
        ],
      },
      {
        heading: 'When to open a case',
        blocks: [
          {
            type: 'list',
            items: [
              'Annualised SoH degradation exceeds 2× the contracted curve over a rolling 90-day window.',
              'A single capacity test shows a >5 percentage-point drop versus the previous test.',
              'More than ~2% of cells in a string show >50 mV voltage deviation at 50% SoC.',
            ],
          },
        ],
      },
      {
        heading: 'Good data cuts both ways — which is the point',
        blocks: [
          {
            type: 'paragraph',
            text: 'Continuous instrumentation can also reveal that your own dispatch caused the degradation: high-SoC overnight dwell on an NMC asset, or C-rate exceedances during peak hours. That is not a reason to avoid the data — it is the reason to see it first, so you can correct dispatch before it becomes the OEM’s defence and before the warranty headroom is gone.',
          },
        ],
      },
    ],
    faq: [
      {
        q: 'What is the single most useful thing to start logging?',
        a: 'Cell temperature and SoC traces, continuously. They underpin both the most common warranty exclusions and the evidence you need to rebut them, and they are cheap to capture but painful to reconstruct after the fact.',
      },
    ],
    related: [
      { title: 'Warranty as a data product', href: '/bess/warranty-as-data-product', description: 'The metric this argument supports.' },
      { title: 'State of Health (SoH)', href: '/bess/state-of-health', description: 'The headline warranty number.' },
      { title: 'BESS capacity fade', href: '/faults/bess-capacity-fade', description: 'The fault mode behind most disputes.' },
    ],
    sources: ['public/data/manuals/seed/synthetic/bess-warranty-and-degradation.md'],
    datePublished: PUBLISHED,
  },
  {
    slug: 'soiling-cleaning-economics',
    title: 'Soiling loss: when is cleaning worth it?',
    intro: 'Cleaning is an optimisation, not a calendar — and the maths is site-specific.',
    quickAnswer:
      'Cleaning a PV plant is worth it when the value of the energy you’d recover before the next rain exceeds the cost of the clean. That depends on the soiling rate, the tariff, and the rain forecast — so the answer is a per-site optimisation over the soiling trajectory, not a fixed cleaning calendar.',
    sections: [
      {
        heading: 'Soiling is the one loss that recovers',
        blocks: [
          {
            type: 'paragraph',
            text: 'Unlike a hardware fault, soiling loss reverses — rain or a cleaning crew restores output. That makes it an economic decision rather than a repair. The cost of acting (a cleaning crew, water, downtime) is weighed against the energy you would otherwise lose before nature cleans the array for free.',
          },
        ],
      },
      {
        heading: 'The break-even logic',
        blocks: [
          {
            type: 'paragraph',
            text: 'Soiling accumulates at a site-specific daily rate. The longer you leave it, the more energy you lose — but rain may clean it at any time, making a recent clean wasted spend. The decision balances three things:',
          },
          {
            type: 'list',
            items: [
              'Soiling rate — how fast the ratio is falling (climate, dust, season).',
              'Energy value — tariff or PPA price applied to the recoverable kWh.',
              'Rain forecast — the probability nature cleans before your break-even date.',
            ],
          },
          {
            type: 'paragraph',
            text: 'If the recoverable energy value before the expected next cleaning rain exceeds the cleaning cost, clean now; otherwise wait. Cleaning too early wastes money on a clean the rain would have done; cleaning too late leaves recoverable energy on the table.',
          },
        ],
      },
      {
        heading: 'How NuraVolt optimises it',
        blocks: [
          {
            type: 'paragraph',
            text: 'NuraVolt estimates the soiling ratio through a five-layer stack (from a DustIQ sensor down to physics-based loss disaggregation, each with a stated confidence), forecasts accumulation with a rain-aware model, and runs a cleaning-schedule optimiser across 1,000+ scenarios to find the dates that maximise ROI for that specific site and tariff.',
          },
        ],
      },
    ],
    faq: [
      {
        q: 'Why not just clean on a fixed schedule?',
        a: 'A fixed calendar ignores rain and seasonal soiling rates, so it both over-cleans (right before rain) and under-cleans (during dry, high-loss spells). Optimising against the forecast captures more value for the same or lower cleaning spend.',
      },
      {
        q: 'Do I need a soiling sensor for this?',
        a: 'It helps but isn’t required. NuraVolt falls back through same-plant ML, transfer learning, and physics-based disaggregation when no DustIQ sensor is present, each with an explicit confidence level.',
      },
    ],
    related: [
      { title: 'Soiling loss', href: '/faults/soiling-loss', description: 'The fault-mode reference page.' },
      { title: 'PV string underperformance', href: '/faults/pv-string-underperformance', description: 'The loss soiling is often confused with.' },
      { title: 'Soiling stations vs software soiling monitoring', href: '/compare/soiling-sensors-vs-software', description: 'How to measure soiling before optimizing cleaning.' },
    ],
    sources: ['docs/technical/SOILING_METHODOLOGY.md', 'nuravolt/soiling/economics.py'],
    datePublished: PUBLISHED,
  },
  {
    slug: 'ppa-performance-guarantees',
    title: 'PPA performance guarantees: the metrics that actually trigger penalties',
    intro: 'The clauses that move money are availability, performance ratio, and the measurement convention behind them.',
    quickAnswer:
      'PPA and performance-guarantee penalties are usually triggered by three things: contracted availability, a performance-ratio (PR) or energy-yield guarantee, and the measurement/exclusion conventions that decide what counts. Disputes turn less on raw production than on how downtime and underperformance are attributed.',
    sections: [
      {
        heading: 'Availability is the first trigger',
        blocks: [
          {
            type: 'paragraph',
            text: 'Most contracts set a contracted availability (often time- or energy-based) with liquidated damages below it. The fight is rarely whether the plant was down — it’s whether the downtime is excluded (grid curtailment, force majeure, scheduled maintenance) or counted against you. Clean, timestamped attribution of every outage is what protects the number.',
          },
        ],
      },
      {
        heading: 'Performance ratio and yield guarantees',
        blocks: [
          {
            type: 'paragraph',
            text: 'A PR or energy-yield guarantee compares actual output to a weather-corrected expectation. Penalties hit when measured performance falls below the guaranteed band. Because PR is irradiance- and temperature-corrected, the argument moves to the reference model: which sensors, which clear-sky assumption, how soiling and curtailment are separated from genuine underperformance.',
          },
          {
            type: 'list',
            items: [
              'Availability shortfall versus the contracted figure.',
              'Performance ratio below the guaranteed band after weather correction.',
              'Response-time or rectification-window breaches on faults.',
              'Mis-attributed losses — soiling or curtailment counted as underperformance (or vice versa).',
            ],
          },
        ],
      },
      {
        heading: 'Where the metrics are won or lost',
        blocks: [
          {
            type: 'paragraph',
            text: 'The penalty exposure is decided by attribution. Separating curtailment from faults, soiling from hardware loss, and excluded from counted downtime is exactly the disaggregation work that determines whether a shortfall is yours or excluded. Instrumenting that continuously turns a guarantee from a liability you discover at true-up into a number you manage all year.',
          },
        ],
      },
    ],
    faq: [
      {
        q: 'Is raw production the metric that matters?',
        a: 'Rarely on its own. Guarantees are weather-corrected (PR/yield) and availability-based, and the disputes hinge on attribution and exclusions — how losses and downtime are categorised — far more than on the headline kWh.',
      },
    ],
    related: [
      { title: 'Soiling loss', href: '/faults/soiling-loss', description: 'A loss category that must be separated from underperformance.' },
      { title: 'PV string underperformance', href: '/faults/pv-string-underperformance', description: 'Genuine underperformance versus correctable loss.' },
    ],
    sources: ['docs/technical/SOILING_METHODOLOGY.md'],
    datePublished: PUBLISHED,
  },
  {
    slug: 'ci-solar-monitoring-guide-2026',
    title: 'How to monitor a C&I solar portfolio in 2026: SCADA, inverter APIs and AI',
    intro:
      'A practical guide to what commercial and industrial solar monitoring looks like now: which data sources to use, which metrics matter, and where AI genuinely helps.',
    quickAnswer:
      'In 2026 a C&I solar portfolio is monitored from data it already produces: inverter vendor APIs, data loggers, and SCADA exports, with no extra hardware. The stack that finds money has four layers: reliable data acquisition, weather-corrected KPIs, per-inverter analytics for soiling and faults, and alerting that turns findings into tickets.',
    sections: [
      {
        heading: 'Start from the data you already have',
        blocks: [
          {
            type: 'paragraph',
            text: 'Ten years ago portfolio monitoring meant buying loggers, sensors, and a SCADA integration project per site. In 2026 most C&I fleets already emit everything a monitoring platform needs: five-minute AC power per inverter, plane-of-array or satellite irradiance, and temperature. Huawei, Sungrow, SolarEdge and the other major vendors all expose cloud APIs for the data their inverters already report.',
          },
          {
            type: 'list',
            items: [
              'Inverter vendor cloud APIs: the default source for C&I. One credential covers every site on that vendor.',
              'Data loggers and gateways: fill gaps where a site is off the vendor cloud.',
              'SCADA or CSV exports: the fallback that always works, and enough for a first assessment.',
              'Satellite irradiance services: replace or sanity-check on-site pyranometers, which drift.',
            ],
          },
        ],
      },
      {
        heading: 'The four KPIs that actually move money',
        blocks: [
          {
            type: 'paragraph',
            text: 'Dashboards fail when they track everything and rank nothing. Four weather-corrected numbers cover most of the economics of a C&I fleet.',
          },
          {
            type: 'table',
            caption: 'Core portfolio KPIs and what each one catches.',
            headers: ['KPI', 'What it catches', 'Typical cadence'],
            rows: [
              ['Performance Ratio (PR)', 'Whole-plant underperformance vs irradiance', 'Daily'],
              ['Specific yield (kWh/kWp)', 'Site-to-site and inverter-to-inverter ranking', 'Daily'],
              ['Availability', 'Downtime, comms loss, tripped devices', 'Continuous'],
              ['Soiling ratio', 'Recoverable dust and dirt losses, cleaning timing', 'Daily'],
            ],
          },
          {
            type: 'paragraph',
            text: 'The trap is plant-level averaging. A fleet-level PR of 82 percent can hide one inverter at 60 percent behind nineteen healthy ones, and inverter clipping can mask soiling entirely during the hours that matter. Per-inverter granularity is what separates monitoring that reports from monitoring that recovers revenue.',
          },
        ],
      },
      {
        heading: 'Where AI genuinely helps, with honest numbers',
        blocks: [
          {
            type: 'paragraph',
            text: 'Machine learning earns its place in two jobs: classifying faults from electrical signatures, and estimating losses that have no direct sensor, such as per-inverter soiling. The accuracy is real but fault-specific. On the public Lazzaretti PV dataset a gradient-boosted classifier reaches 0.998 macro-F1 across five fault classes, while the harder 8-class GPVS-Faults set drops to 0.766, with thermal and sensor-drift faults hardest to separate. Remaining-useful-life models flag fast faults within a day but miss slow degradation by nearly a week.',
          },
          {
            type: 'paragraph',
            text: 'The practical rule for 2026: trust AI for triage and ranking, verify with physics. A digital twin that corrects for weather, temperature, and curtailment tells you what the plant should have produced; the ML layer explains the gap. Platforms that skip the physics step produce alerts nobody trusts, and alert fatigue is the main reason monitoring tools get ignored.',
          },
        ],
      },
      {
        heading: 'A deployment checklist',
        blocks: [
          {
            type: 'list',
            items: [
              'Inventory data sources per site: vendor API, logger, or export. Multi-vendor fleets need a platform that reads all of them.',
              'Backfill at least one seasonal cycle of history so baselines and soiling patterns are learned before live alerting starts.',
              'Set per-inverter baselines, not plant-level ones.',
              'Route findings into a ticketing workflow with validation, so every alert either becomes work or improves the model.',
              'Review the alert precision monthly: an alert stream the O&M team mutes is worse than no alerts.',
            ],
          },
        ],
      },
    ],
    faq: [
      {
        q: 'Do I need to install soiling stations or extra sensors?',
        a: 'No. Per-inverter soiling and fault analytics can be estimated from AC power, irradiance, and temperature data the fleet already produces. Dedicated soiling stations add a physical ground-truth point and can still make sense on large utility sites, but they are no longer the entry requirement.',
      },
      {
        q: 'How long does onboarding a portfolio take?',
        a: 'With vendor cloud APIs, days rather than months: connect credentials, backfill history, and let the models learn a baseline. SCADA integration projects only enter the picture for sites with no cloud path.',
      },
      {
        q: 'What about mixed fleets with several inverter brands?',
        a: 'That is the normal case in C&I, and it is the main argument for an independent monitoring layer over any single vendor portal: one place where Huawei, Sungrow, and SolarEdge sites are ranked with the same corrected metrics.',
      },
    ],
    related: [
      { title: 'Performance Ratio (PR)', href: '/pv-metrics/performance-ratio', description: 'The weather-corrected KPI, defined properly.' },
      { title: 'Soiling loss', href: '/faults/soiling-loss', description: 'The recoverable loss most fleets undermeasure.' },
      { title: 'Can ML actually detect solar faults?', href: '/reports/ml-solar-fault-detection-benchmark', description: 'The public-data benchmark behind the accuracy numbers above.' },
      { title: 'Integrations', href: '/integrations', description: 'The vendor APIs and data sources NuraVolt reads.' },
    ],
    sources: [
      'NuraVolt ML fault-detection benchmark on public data (Lazzaretti, GPVS-Faults), July 2026',
    ],
    datePublished: '2026-07-11',
  },
  {
    slug: 'bess-health-monitoring-2026',
    title: 'BESS health monitoring in 2026: SoH evidence, warranty claims and augmentation',
    intro:
      'Battery storage economics are decided by degradation. This is what a defensible BESS health-monitoring practice looks like now.',
    quickAnswer:
      'BESS health monitoring in 2026 means tracking State of Health against the warranty curve continuously, keeping an evidence-grade record of operating windows, and planning augmentation from measured fade rather than the datasheet. End-of-life prediction from public data is honest at roughly 17 percent error for LFP and 30 percent for NMC, useful for planning, not yet for warranty claims.',
    sections: [
      {
        heading: 'SoH is the number everything else hangs on',
        blocks: [
          {
            type: 'paragraph',
            text: 'State of Health, remaining capacity as a share of nameplate, drives the warranty position, the augmentation budget, and the revenue model of a BESS. The problem is that SoH is estimated, not measured: BMS-reported values drift, full reference cycles are rare in merchant operation, and different estimation methods disagree by whole percentage points. A monitoring practice that cannot explain how its SoH number is derived cannot defend it in a dispute.',
          },
          {
            type: 'table',
            caption: 'The monthly BESS health review, five numbers.',
            headers: ['Metric', 'Why it matters'],
            rows: [
              ['State of Health vs warranty curve', 'The claim trigger: fade faster than contracted is money'],
              ['Round-trip efficiency trend', 'Early indicator of auxiliary losses and cell issues'],
              ['Equivalent full cycles and throughput', 'The second warranty limit, often hit before the calendar one'],
              ['Cell voltage and temperature spread', 'Imbalance and thermal stress precede capacity loss'],
              ['Operating-window excursions', 'Every SoC, temperature, or C-rate violation weakens a future claim'],
            ],
          },
        ],
      },
      {
        heading: 'Warranties are won by the better record',
        blocks: [
          {
            type: 'paragraph',
            text: 'A BESS warranty guarantees the lower of a capacity-retention limit and a throughput cap, conditioned on operating windows for SoC, temperature, and C-rate. When fade runs ahead of the curve, the OEM looks for a window violation in your own data. The operator that logs excursions continuously, with cell-level context, walks into that conversation with evidence. The one that starts reconstructing history after the dispute opens has already lost ground.',
          },
        ],
      },
      {
        heading: 'End-of-life prediction: useful, with honest error bars',
        blocks: [
          {
            type: 'paragraph',
            text: 'On the best public cycling datasets, end-of-life prediction lands at 17.2 percent mean error for LFP cells (124 Severson cells, gradient boosting on early-cycle features) and 29.5 percent for NMC (13 NASA cells, linear extrapolation). That is genuinely useful for augmentation budgeting and dispatch strategy, and genuinely not enough to settle a warranty claim on its own. Anyone quoting battery life prediction without an error bar is selling, not measuring.',
          },
          {
            type: 'paragraph',
            text: 'Augmentation planning is where the prediction earns money: measured fade plus a predicted trajectory tells you which year needs how many megawatt hours added, and whether augmenting beats overbuilding at day one. The answer shifts with cell prices, which is why it should be recomputed from live SoH, not fixed at financial close.',
          },
        ],
      },
    ],
    faq: [
      {
        q: 'Is the BMS SoH number good enough?',
        a: 'As a trend indicator, often. As warranty evidence, no. BMS estimates drift and the estimation method is a black box to the operator. An independent estimate from charge and discharge data, with a documented method, is what stands up in a dispute.',
      },
      {
        q: 'When should augmentation be planned?',
        a: 'From measured fade, revisited at least yearly. The datasheet degradation curve is a sales document; plants routinely fade faster or slower depending on cycling, temperature, and SoC management.',
      },
    ],
    related: [
      { title: 'State of Health (SoH)', href: '/bess/state-of-health', description: 'How SoH is defined and estimated.' },
      { title: 'Battery augmentation', href: '/bess/augmentation', description: 'Sizing and timing capacity additions.' },
      { title: 'Warranty as a data product', href: '/bess/warranty-as-data-product', description: 'Turning the operating record into claim evidence.' },
      { title: 'Why warranty disputes are won or lost in SCADA data', href: '/insights/warranty-disputes-scada-data', description: 'The evidentiary view of BESS warranties.' },
    ],
    sources: [
      'Severson et al., Nature Energy 2019',
      'NASA Ames PCoE Battery Aging Dataset',
      'NuraVolt ML benchmark on public data, July 2026',
    ],
    datePublished: '2026-07-11',
  },
  {
    slug: 'ai-assistants-solar-operations-2026',
    title: 'AI assistants for solar operations in 2026: what an MCP server changes',
    intro:
      'Operators are already asking Claude and ChatGPT about their plants. The Model Context Protocol is what turns those answers from guesses into readings of your actual fleet.',
    quickAnswer:
      'An MCP server gives AI assistants like Claude and ChatGPT direct, permissioned access to plant data: live soiling forecasts, fault classifications, tickets, and schedules. Instead of pasting CSV exports into a chat, an operator asks the assistant and it queries the platform with scoped, audited credentials. In 2026 this is the difference between AI that talks about solar and AI that operates on your solar.',
    sections: [
      {
        heading: 'The problem: your data lives in one tab, your AI in another',
        blocks: [
          {
            type: 'paragraph',
            text: 'Every operations team now uses an AI assistant for something: drafting reports, summarizing logs, explaining a fault code. But the assistant cannot see the fleet. So people copy dashboard screenshots and paste CSV fragments into chats, which is slow, error-prone, and invisible to any audit trail. The Model Context Protocol, an open standard adopted by Anthropic, OpenAI, and the major IDE vendors, fixes the plumbing: a platform exposes typed tools, and any MCP-aware assistant can call them with the user’s permission.',
          },
        ],
      },
      {
        heading: 'What a solar MCP server looks like in practice',
        blocks: [
          {
            type: 'paragraph',
            text: 'NuraVolt ships its platform functions as an MCP server: the same tools operators use in the app, callable from Claude Desktop, ChatGPT, Cursor, or any MCP-aware client. Twelve tools cover the asset lifecycle, from listing plants and inverters to reading soiling forecasts, diagnosing an inverter, reviewing tickets, and approving a cleaning schedule.',
          },
          {
            type: 'list',
            items: [
              'Morning review: "Which plants lost the most to soiling this week, and which cleaning is already scheduled?"',
              'Diagnosis: "Inverter 14 at the southern site ranks last on specific yield. Classify the likely fault and show the evidence."',
              'Action with guardrails: "Approve the proposed cleaning schedule for the southern plant." The write is idempotent and scoped to what the key allows.',
              'Reporting: "Draft the monthly performance summary for the C&I portfolio with PR, availability, and open tickets."',
            ],
          },
        ],
      },
      {
        heading: 'Security is the design constraint, not an afterthought',
        blocks: [
          {
            type: 'paragraph',
            text: 'Giving a language model tools is only sane with hard boundaries. The NuraVolt implementation uses scoped API keys hashed at rest, so a key can be read-only, plant-limited, or full-access per team member. Every tool call lands in an audit log. Writes are idempotent, so a retried or duplicated request cannot double-apply an action. The assistant gets exactly the access its key holder has, nothing more.',
          },
          {
            type: 'paragraph',
            text: 'What an MCP server does not change: the quality of the answers still depends on the quality of the underlying analytics. An assistant reading a plant-mean soiling number will give plant-mean answers. The per-inverter estimation, digital-twin correction, and fault models underneath are what make the conversation worth having.',
          },
        ],
      },
    ],
    faq: [
      {
        q: 'Which assistants work with it?',
        a: 'Any MCP-aware client. Today that includes Claude Desktop and claude.ai, ChatGPT, Cursor, and a growing list of IDE and agent frameworks. Setup is pasting a server URL and a scoped key.',
      },
      {
        q: 'Can the assistant change things in the platform?',
        a: 'Only what the key allows. Read-only keys are the default for reporting use; action tools like approving a cleaning schedule require a key scoped for writes, and every call is audit-logged.',
      },
      {
        q: 'Is this different from a chatbot on the website?',
        a: 'Yes. A website chatbot answers questions about the product. An MCP server lets the assistant your team already uses query and act on your actual plant data, under your permissions.',
      },
    ],
    related: [
      { title: 'NuraVolt MCP Server', href: '/mcp', description: 'The product page: tools, scopes, and setup.' },
      { title: 'MCP setup guide', href: '/mcp/setup', description: 'Connect Claude, ChatGPT, or Cursor in minutes.' },
      { title: 'Can ML actually detect solar faults?', href: '/reports/ml-solar-fault-detection-benchmark', description: 'The analytics quality underneath the assistant.' },
    ],
    sources: [
      'Model Context Protocol specification (modelcontextprotocol.io)',
      'NuraVolt MCP documentation',
    ],
    datePublished: '2026-07-11',
  },
];

const INSIGHTS_HUB = { label: 'Insights', href: '/insights' };

export function getInsight(slug: string): InsightEntry | undefined {
  return insights.find((i) => i.slug === slug);
}

export function normalizeInsight(entry: InsightEntry): ArticleView {
  return {
    category: 'Insight',
    hub: INSIGHTS_HUB,
    slug: entry.slug,
    urlRelative: `/insights/${entry.slug}`,
    title: entry.title,
    intro: entry.intro,
    quickAnswer: entry.quickAnswer,
    sections: entry.sections,
    faq: entry.faq,
    related: entry.related,
    datePublished: entry.datePublished,
    sources: entry.sources,
  };
}
