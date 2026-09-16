import type { ArticleView, ContentSection, FAQ, RelatedLink } from './types';

/**
 * Template C — Inverter / BESS vendor integration pages.
 *
 * Ranks for "[vendor] modbus monitoring" style queries and signals real
 * product depth. Substance: nuravolt/bess/manufacturer_adapters/ (Tesla
 * Megapack adapter, base ManufacturerAdapter) and the Huawei SUN2000 fault-code
 * reference. Status is reported honestly — `roadmap` vendors are
 * architecture-supported but not yet shipped as live adapters.
 */

const PUBLISHED = '2026-06-09';

export interface IntegrationEntry {
  vendor: string;
  slug: string;
  title: string;
  intro: string;
  status: 'live' | 'roadmap';
  quickAnswer: string;
  protocols: string[];
  dataPoints: string[];
  /** Notable fault/alarm codes: { label: code, value: meaning }. */
  faultCodeHighlights?: { label: string; value: string }[];
  setupNotes: string;
  /** Fault-page slugs this integration commonly surfaces. */
  relatedFaults?: string[];
  extraRelated?: RelatedLink[];
  faq: FAQ[];
  sources?: string[];
  datePublished?: string;
}

export const integrations: IntegrationEntry[] = [
  {
    vendor: 'Huawei',
    slug: 'huawei',
    title: 'Huawei SUN2000 monitoring integration',
    intro: 'String-inverter telemetry and fault-code mapping for Huawei SUN2000.',
    status: 'live',
    quickAnswer:
      'NuraVolt ingests Huawei SUN2000 (-196/200/215KTL-H3) string-inverter data via Modbus TCP or the FusionSolar API, normalises it to a common schema, and maps SUN2000 fault codes (DC, grid, and hardware) onto NuraVolt’s physics-informed fault taxonomy so alarms become diagnoses, not just codes.',
    protocols: ['Modbus TCP', 'FusionSolar / Huawei NMS API', 'CSV export'],
    dataPoints: [
      'Per-MPPT and per-string current and voltage',
      'AC active/reactive power, frequency, grid voltage',
      'Heat-sink / IGBT temperature and internal fan status',
      'Insulation resistance (Riso) and DC bus voltage',
      'Inverter fault and alarm codes with timestamps',
    ],
    faultCodeHighlights: [
      { label: '2001', value: 'High string DC voltage — Voc exceeds 1500 V on a cold, long string.' },
      { label: '2002', value: 'Low insulation resistance — water ingress or backsheet/cable damage.' },
      { label: '2031', value: 'String current backflow — mismatched string lengths or shading.' },
      { label: '3001', value: 'Grid overvoltage — PCC above MV setpoint, common in weak grids.' },
      { label: '6001', value: 'IGBT overtemperature — cooling-fan failure or blocked heat sink.' },
      { label: '6011', value: 'Internal fan abnormal — bearing wear or dust ingress.' },
    ],
    setupNotes:
      'Point NuraVolt at the inverter Modbus register map or connect the FusionSolar NMS API for fleet pull. NuraVolt handles the register-to-schema mapping and unit conversion, and applies the SUN2000 auto-reset behaviour (up to 3 retries in 10 minutes before latch) when deciding whether a soft trip is worth a ticket.',
    relatedFaults: ['dc-insulation-degradation', 'inverter-igbt-overtemperature'],
    extraRelated: [
      {
        title: 'Huawei FusionSolar vs independent monitoring',
        href: '/compare/huawei-fusionsolar-vs-independent-monitoring',
        description: 'When the free vendor portal is enough and when it is not.',
      },
    ],
    faq: [
      {
        q: 'Does NuraVolt need FusionSolar, or can it read Modbus directly?',
        a: 'Either. NuraVolt reads SUN2000 telemetry directly over Modbus TCP, or pulls from the FusionSolar / Huawei NMS API for fleet-scale collection. The choice usually comes down to site network access.',
      },
      {
        q: 'What happens with auto-recovering soft trips?',
        a: 'The SUN2000 auto-resets up to three times in ten minutes before latching. NuraVolt batches repeated soft trips rather than ticketing each one, and escalates only when a code repeats beyond the auto-reset budget or a hardware (6xxx) fault appears.',
      },
    ],
    sources: ['public/data/manuals/seed/synthetic/huawei-sun2000-fault-codes.md'],
    datePublished: PUBLISHED,
  },
  {
    vendor: 'Tesla',
    slug: 'tesla-megapack',
    title: 'Tesla Megapack monitoring integration',
    intro: 'BESS telemetry ingest and warranty-grade analytics for Tesla Megapack.',
    status: 'live',
    quickAnswer:
      'NuraVolt connects to Tesla Megapack via its JSON telemetry API, normalises SoC, power, temperature, and cell-level data to a common BESS schema, and runs warranty-grade analytics — SoH, equivalent full cycles, thermal stress, and SoC/temperature-window compliance — on top of it.',
    protocols: ['JSON / REST API (polling)', 'Modbus TCP', 'CSV export'],
    dataPoints: [
      'State of Charge (SoC) and dispatched power',
      'Cell and cabinet temperature, HVAC status',
      'State of Health (SoH) and cell voltage spread (where exposed)',
      'Voltage, current, and per-string telemetry',
      'BMS fault and alarm codes',
    ],
    setupNotes:
      'NuraVolt’s ManufacturerAdapter framework provides a Megapack adapter that polls the JSON API and maps fields to the standard BESSReading schema (timestamp, SoC, power, temperature, plus optional SoH, cell voltages, temp spread, HVAC status, fault codes). The same normalised stream feeds capacity-fade, thermal-stress, RTE, and cell-imbalance models.',
    relatedFaults: ['bess-capacity-fade', 'bess-thermal-stress', 'bess-cell-imbalance'],
    extraRelated: [
      {
        title: 'Warranty as a data product',
        href: '/bess/warranty-as-data-product',
        description: 'What the normalised Megapack stream is used for.',
      },
    ],
    faq: [
      {
        q: 'What battery analytics run on Megapack data once connected?',
        a: 'SoH tracking against the warranty curve, equivalent-full-cycle accrual against the throughput budget, thermal-stress accumulation, round-trip-efficiency trending, and cell-imbalance monitoring — all from the normalised telemetry stream.',
      },
    ],
    sources: ['nuravolt/bess/manufacturer_adapters/tesla_megapack.py', 'nuravolt/bess/manufacturer_adapters/base.py'],
    datePublished: PUBLISHED,
  },
  {
    vendor: 'Sungrow',
    slug: 'sungrow',
    title: 'Sungrow monitoring integration',
    intro: 'Architecture-ready Modbus/API ingest for Sungrow inverters and storage.',
    status: 'roadmap',
    quickAnswer:
      'A Sungrow adapter is architecture-ready on NuraVolt’s ManufacturerAdapter framework — which already supports Modbus TCP, JSON API, SNMP, and SOAP — but is not yet shipped as a live, validated adapter. Live Sungrow ingest is delivered as part of an onboarding engagement against the target plant’s register map.',
    protocols: ['Modbus TCP (planned)', 'iSolarCloud API (planned)', 'CSV export'],
    dataPoints: [
      'Per-MPPT / per-string current and voltage (PV)',
      'AC power, frequency, grid voltage (PV)',
      'SoC, power, temperature (storage)',
      'Device fault and alarm codes',
    ],
    setupNotes:
      'NuraVolt’s base ManufacturerAdapter abstracts data format, field mapping, and unit conversion, so a Sungrow adapter is a configuration-and-validation task against the specific model’s register map rather than new framework code. We scope it during onboarding and validate against live plant data before relying on it.',
    relatedFaults: ['pv-string-underperformance', 'mppt-imbalance'],
    faq: [
      {
        q: 'Can I monitor Sungrow equipment with NuraVolt today?',
        a: 'The framework supports it and the protocols are in place, but a validated Sungrow adapter is delivered as part of onboarding rather than offered as a pre-built, self-serve integration. We’re explicit about this rather than overstating coverage.',
      },
    ],
    sources: ['nuravolt/bess/manufacturer_adapters/base.py'],
    datePublished: PUBLISHED,
  },
];

const INTEGRATIONS_HUB = { label: 'Integrations', href: '/integrations' };

export function getIntegration(slug: string): IntegrationEntry | undefined {
  return integrations.find((i) => i.slug === slug);
}

export function normalizeIntegration(entry: IntegrationEntry): ArticleView {
  const sections: ContentSection[] = [
    { heading: 'Supported protocols', blocks: [{ type: 'list', items: entry.protocols }] },
    { heading: 'Data points we ingest', blocks: [{ type: 'list', items: entry.dataPoints }] },
    ...(entry.faultCodeHighlights
      ? [
          {
            heading: 'Notable fault codes',
            blocks: [{ type: 'keyValue' as const, pairs: entry.faultCodeHighlights }],
          },
        ]
      : []),
    { heading: 'Setup', blocks: [{ type: 'paragraph', text: entry.setupNotes }] },
  ];

  // Resolve related fault links by slug against the faults catalog at call time
  // would create a cycle; integrations author hrefs directly instead.
  const related: RelatedLink[] = [
    ...(entry.relatedFaults ?? []).map((slug) => ({
      title: slug
        .replace(/^bess-/, 'BESS ')
        .replace(/-/g, ' ')
        .replace(/\b\w/g, (c) => c.toUpperCase()),
      href: `/faults/${slug}`,
    })),
    ...(entry.extraRelated ?? []),
  ];

  return {
    category: entry.status === 'live' ? 'Integration' : 'Integration (roadmap)',
    hub: INTEGRATIONS_HUB,
    slug: entry.slug,
    urlRelative: `/integrations/${entry.slug}`,
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
