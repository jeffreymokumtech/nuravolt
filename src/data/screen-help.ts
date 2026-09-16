/**
 * Per-screen help content for the ops console, keyed by the shell's nav key
 * (OpsShell passes activeNavKey into the command bar; drilldowns and pages
 * without a nav key fall back to the section string, then to DEFAULT_HELP).
 *
 * Copy rules: sentence case, plain hyphens only (no em or en dashes), and
 * honest data provenance in every entry. Where the platform models rather
 * than measures, the help says so in the same words the page itself uses.
 */

export interface ScreenHelpEntry {
  title: string;
  /** One paragraph: what this screen shows. */
  whatThisShows: string;
  /** Bullet list: how to read the main elements. */
  howToRead: string[];
  /** Where the numbers come from, stated honestly. */
  dataProvenance: string;
  /** Short question/answer pairs. */
  faq?: Array<{ q: string; a: string }>;
}

export const DEFAULT_HELP: ScreenHelpEntry = {
  title: 'About this screen',
  whatThisShows:
    'An operations view of your plant or portfolio data. Every number traces back to your measured telemetry, the physics plus ML digital twin built from it, or a clearly labeled model.',
  howToRead: [
    'Mono-spaced figures are data; labels and copy are prose.',
    'Colored pills and LEDs follow one convention everywhere: green is nominal, amber needs attention, red needs action.',
    'Most panels deep-link: click a row or chip to open the underlying detail view.',
  ],
  dataProvenance:
    'Measured telemetry comes from your data connections. Modeled values (twin predictions, forecasts) are always labeled as such on the page.',
  faq: [
    {
      q: 'Why does a value differ from my SCADA?',
      a: 'The console aggregates to hourly or daily buckets and converts to UTC; SCADA screens usually show instantaneous local-time values.',
    },
  ],
};

export const SCREEN_HELP: Record<string, ScreenHelpEntry> = {
  overview: {
    title: 'Plant overview',
    whatThisShows:
      'The single-screen health picture for this plant: live output vs the digital twin expectation, active alerts, open tickets, and the day so far.',
    howToRead: [
      'The power chart overlays measured output on the twin prediction; a persistent gap between them is lost energy with a cause worth finding.',
      'Alert strips at the top are live: acknowledge marks one as seen (it stays active), resolve closes it.',
      'The alarm stack lists predictive and reactive faults; click a row for evidence and recommended action.',
    ],
    dataProvenance:
      'Measured power comes from your inverter telemetry. Expected power comes from the digital twin, a physics plus ML model trained on this plant. Alerts are evaluated hourly against per-plant thresholds.',
    faq: [
      {
        q: 'What does acknowledging an alert do?',
        a: 'It stamps who saw it and dims the alert, but keeps it active. Resolve closes it; if the condition persists, a fresh alert opens on the next hourly evaluation.',
      },
    ],
  },
  soiling: {
    title: 'Soiling intelligence',
    whatThisShows:
      'How much energy dust costs this plant: the soiling ratio (SR) forecast, per-inverter soiling ranking, zonal map, and the cleaning optimizer with its economics.',
    howToRead: [
      'SR of 1.000 means clean panels; 0.95 means 5 percent of energy is lost to dust. The forecast band shows model uncertainty.',
      'The dirtiest-first ranking is the cleaning crew work order: start at the top.',
      'The cleaning optimizer scores hundreds of candidate schedules against the forecast and shows the best plan per number of cleanings; adopt one to persist it and open maintenance tickets.',
    ],
    dataProvenance:
      'Per-inverter SR is derived from measured per-inverter performance (self-normalized PR), not from a single plant sensor. Rain and dust context come from Open-Meteo and CAMS. On demo plants, artifacts are labeled specimens derived from an anonymized donor plant.',
    faq: [
      {
        q: 'Is the optimizer rain-aware?',
        a: 'When a 16-day rain forecast is available it avoids scheduling a wash right before heavy rain; the chip on the run says whether that applied.',
      },
      {
        q: 'What does adopting a schedule do?',
        a: 'It saves the plan for the plant (visible in the adopted plan panel and the overview) and can create one maintenance ticket per cleaning date.',
      },
    ],
  },
  faults: {
    title: 'Fault detection',
    whatThisShows:
      'Predictive and reactive fault intelligence: what is failing, what will fail soon, remaining useful life estimates, and the revenue at risk.',
    howToRead: [
      'The alarm stack sorts by urgency; the chip on each row shows which layer flagged it (rule, twin residual, ML classifier, or AI override).',
      'Days-to-fault below zero means the fault is already due; act on those first.',
      'ACK hides a row from your triage view (persisted on this browser); it does not silence the underlying detection.',
    ],
    dataProvenance:
      'Faults come from the fault pipeline run over twin residuals and electrical telemetry. RUL estimates are model outputs with stated confidence, not guarantees.',
  },
  battery: {
    title: 'Battery (BESS)',
    whatThisShows:
      'State of health, cycling history, warranty position, and dispatch behaviour for the storage asset.',
    howToRead: [
      'SoH trends down over cycles; the dashed line is the warranty capacity guarantee.',
      'The dispatch chart shows charge and discharge against day-ahead prices; green bars earn, the SoC line shows the plan staying inside its band.',
      'Warranty margin is the distance between the current trajectory and the guarantee at end of term.',
    ],
    dataProvenance:
      'Without BMS telemetry connected, the battery twin is provisional: real optimizer dispatch over real market prices, with cycling and degradation from empirical models. Pages carry that label wherever it applies.',
    faq: [
      {
        q: 'Why does it say provisional?',
        a: 'Honesty. Until BMS data is connected, health and cycling are modeled from dispatch behaviour rather than measured cell data.',
      },
    ],
  },
  revenue: {
    title: 'Storage revenue',
    whatThisShows:
      'The revenue stack for the battery: wholesale arbitrage and ancillary services, daily and cumulative.',
    howToRead: [
      'Stacked bars split revenue by service; the table below totals each stream.',
      'Capture ratio compares realized revenue against per-day perfect foresight on the same prices; commercial optimizers typically land at 70 to 90 percent.',
    ],
    dataProvenance:
      'Prices are real day-ahead market data. Dispatch is the modeled optimizer schedule (provisional twin) unless live dispatch telemetry is connected.',
  },
  hybrid: {
    title: 'Hybrid cockpit',
    whatThisShows:
      'The PV plant and the battery as one economic unit: co-located generation, storage shifting, and combined revenue.',
    howToRead: [
      'The flow view shows energy moving from PV to grid, PV to battery, and battery to grid.',
      'Shifted-energy value is the premium earned by discharging at better prices than the PV would have received.',
    ],
    dataProvenance:
      'PV side is measured telemetry plus the digital twin; battery side follows the BESS pages (provisional twin unless BMS is connected).',
  },
  quality: {
    title: 'Data quality hub',
    whatThisShows:
      'Whether you can trust the data underneath every other page: coverage against SLA, freshness, sensor health, and lineage.',
    howToRead: [
      'The DQ figure in the top bar is month-to-date coverage against the SLA, the same number this hub reports.',
      'Irradiance quality compares your on-site sensor with the Open-Meteo satellite reference; drift alerts suggest recalibration.',
      'Lineage shows which connection produced which stream and when it last delivered.',
    ],
    dataProvenance:
      'All quality metrics are computed from your ingested telemetry; the irradiance reference is Open-Meteo GTI at the plant coordinates and tilt.',
  },
  tickets: {
    title: 'O&M tickets',
    whatThisShows:
      'The maintenance workflow: every ticket from detection to done, as a kanban board or a list.',
    howToRead: [
      'Drag a card between columns to change status; the history records every transition.',
      'AI-triggered tickets carry an analysis card with the evidence behind the detection; validate it to teach the detectors.',
      'New creates a manual ticket; cleaning-plan adoptions can create scheduled-maintenance tickets automatically.',
    ],
    dataProvenance:
      'Tickets live in the platform database. Trigger types record what opened each one: a soiling forecast, an anomaly, a threshold alert, a cleaning schedule, or a person.',
  },
  contracts: {
    title: 'Contracts',
    whatThisShows:
      'Your PPAs, warranties, and O&M SLAs with their live obligation status: on track, at risk, or breach.',
    howToRead: [
      'Each contract lists its monitored obligations; the pill reflects the latest hourly evaluation.',
      'Energy-delivery obligations are evaluated as an energy proxy against the twin expectation, not contractual settlement data; the footnote on each page says so.',
      'Click a contract for its terms, source document, and evaluation history.',
    ],
    dataProvenance:
      'Terms are extracted from your uploaded documents and human-confirmed before monitoring starts. Obligation status comes from the platform evaluation, which is an operational early-warning signal, not a legal determination.',
  },
  datahub: {
    title: 'Connections',
    whatThisShows:
      'Every data connection feeding this plant: source type, polling health, field mappings, and the last successful delivery.',
    howToRead: [
      'Green polling status means data arrived within the expected interval.',
      'Field mappings translate source signal names into platform metrics; unmapped signals are ingested but unused.',
    ],
    dataProvenance:
      'Connection health is observed from actual deliveries. On demo plants the connection is a labeled specimen; readings are seeded, not polled live.',
  },
  financials: {
    title: 'Financials',
    whatThisShows:
      'Revenue, budget deviation, and the financial impact of technical losses for this plant.',
    howToRead: [
      'Budget deviation compares actual production revenue with the plan for the period.',
      'Loss lines are technical losses (soiling, faults, curtailment) priced at your energy rate.',
    ],
    dataProvenance:
      'Production comes from measured telemetry; prices come from your configured rate or market data. Demo plants use illustrative fixtures.',
  },
  audit: {
    title: 'Battery audit',
    whatThisShows:
      'The evidence pack for the storage asset: health dossier, dispatch optimizer audit, warranty position, and compliance artifacts.',
    howToRead: [
      'The dossier scores health from cycling behaviour and degradation models; the optimizer audit benchmarks realized dispatch against per-day perfect foresight.',
      'Perfect foresight is an upper bound no live trader reaches; use the capture ratio band, not the gap alone.',
    ],
    dataProvenance:
      'Built from the modeled dispatch twin over real market prices. Provisional wherever BMS telemetry is absent, and labeled so.',
  },
  settings: {
    title: 'Plant settings',
    whatThisShows:
      'Per-plant configuration: alert thresholds, notification preferences, data source selection, and metadata.',
    howToRead: [
      'Alert thresholds feed the hourly evaluation that opens and resolves plant alerts.',
      'Notification toggles control which emails this plant sends and to whom.',
    ],
    dataProvenance: 'Settings are stored per plant and take effect on the next evaluation cycle.',
  },
  fleet: {
    title: 'Fleet home',
    whatThisShows:
      'Every plant you can access, grouped by asset type, with alert counts and the fastest paths into each console.',
    howToRead: [
      'The alert summary strip surfaces the plants that need attention first.',
      'Plan and capacity bands at the top reflect your subscription and onboarded MW.',
    ],
    dataProvenance: 'Live from your organization data; alert counts come from the hourly evaluation.',
  },
  reports: {
    title: 'Reports',
    whatThisShows:
      'Composable report dashboards (build from widgets or templates), shareable links, PDF export, and scheduled email deliveries.',
    howToRead: [
      'Templates give a starting layout: weekly operations, executive summary, inverter deep dive, storage review. Every widget stays editable.',
      'Schedule email sends the composed dashboard as a PDF on a weekly or monthly cadence.',
      'Widgets scope to plants and devices; the scope bar sets the default, each widget can override.',
    ],
    dataProvenance:
      'Widgets read the same APIs as the console pages: twin summaries, measured telemetry, contract evaluations, and battery analytics.',
  },
  'org-settings': {
    title: 'Organization settings',
    whatThisShows: 'Org-level administration: team, API keys, billing, connections, and integrations.',
    howToRead: ['Each card opens a dedicated section; changes apply to the whole organization.'],
    dataProvenance: 'Organization records in the platform database.',
  },
  team: {
    title: 'Team',
    whatThisShows: 'Members, invitations, roles, and per-plant access grants.',
    howToRead: [
      'Roles gate what a member can change; plant access grants gate what they can see and operate.',
      'Operators can run analyses and acknowledge alerts; managing connections and contracts needs an admin or manager role.',
    ],
    dataProvenance: 'Membership and grants live in the platform database.',
  },
  'api-keys': {
    title: 'MCP API keys',
    whatThisShows:
      'Keys that let AI assistants (Claude, Cursor, ChatGPT) read your fleet data through the MCP protocol.',
    howToRead: [
      'Each key is scoped to your organization; revoke it here to cut access immediately.',
      'The config snippet is ready to paste into your assistant setup.',
    ],
    dataProvenance: 'Key metadata only; secrets are shown once at creation.',
  },
  billing: {
    title: 'Billing',
    whatThisShows: 'Your plan, usage against its limits, and invoices.',
    howToRead: ['Plan limits gate features and onboarded capacity; upgrades apply immediately.'],
    dataProvenance: 'Subscription state from the billing provider.',
  },
  connections: {
    title: 'Fleet connections',
    whatThisShows: 'Every data connection across the portfolio with its polling health.',
    howToRead: ['Sort by status to find silent connections; click through for field mappings and history.'],
    dataProvenance: 'Observed delivery history for each connection.',
  },
  integrations: {
    title: 'Integrations',
    whatThisShows: 'Outbound webhooks for ticket lifecycle events, with signed deliveries.',
    howToRead: [
      'Each webhook subscribes to events (created, status changed); deliveries are HMAC-signed with the shared secret.',
      'The delivery log shows recent attempts and response codes.',
    ],
    dataProvenance: 'Webhook and delivery records in the platform database.',
  },
  agent: {
    title: 'Shams',
    whatThisShows:
      'Your AI agent on your fleet data: ask questions, chart metrics, run the cleaning optimizer, draft tickets and reports.',
    howToRead: [
      'Shams answers from live tools over your data and cites its sources; chips deep-link to the underlying views.',
      'Anything that changes state (tickets, schedules, alerts, reports) renders as a draft card you confirm; nothing persists until you click.',
    ],
    dataProvenance:
      'Tool calls read the same APIs as the console. Answers are grounded in tool output; when data is missing, Shams says so rather than inventing numbers.',
  },
};

/** Resolve a help entry with sensible fallback. */
export function helpForKey(key: string | undefined | null): ScreenHelpEntry {
  if (!key) return DEFAULT_HELP;
  const direct = SCREEN_HELP[key];
  if (direct) return direct;
  const lower = key.toLowerCase();
  return SCREEN_HELP[lower] ?? DEFAULT_HELP;
}
