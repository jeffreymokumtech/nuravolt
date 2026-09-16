/**
 * Glossary of recurring grid-code / compliance terms.
 * Used by the compliance reference page to explain acronyms in context.
 */

export interface GlossaryEntry {
  term: string;
  full?: string;          // Expansion of the acronym, if any
  definition: string;
}

export const GLOSSARY: Record<string, GlossaryEntry> = {
  LVRT: {
    term: 'LVRT',
    full: 'Low Voltage Ride-Through',
    definition:
      'The ability of a generator to stay connected to the grid during a voltage dip without tripping. Defined as a curve of voltage (per-unit) vs. time after fault.',
  },
  PCC: {
    term: 'PCC',
    full: 'Point of Common Coupling',
    definition:
      'The electrical boundary where the plant connects to the public grid. Grid code requirements (voltage, reactive power, harmonics) are measured here.',
  },
  FRT: {
    term: 'FRT',
    full: 'Fault Ride-Through',
    definition:
      'Umbrella term for LVRT + HVRT — staying connected through faults. Prevents simultaneous trips of renewable plants during grid disturbances.',
  },
  MPPT: {
    term: 'MPPT',
    full: 'Maximum Power Point Tracking',
    definition:
      'Controller in the inverter that tunes the DC operating voltage/current to extract the most power from the PV string given irradiance and temperature.',
  },
  'CEI 0-16': {
    term: 'CEI 0-16',
    definition:
      'Italian technical standard for MV/HV grid connection. Defines fault ride-through curves, reactive power requirements, and Interface Protection System (SPI).',
  },
  'CEI 0-21': {
    term: 'CEI 0-21',
    definition:
      'Italian standard for LV grid connection (< 400 V). Simpler envelope than CEI 0-16 — targets residential + small commercial.',
  },
  'P.O. 12.3': {
    term: 'P.O. 12.3',
    definition:
      'Spanish Procedimiento de Operación 12.3 — technical operating procedure issued by REE that defines ride-through and reactive power behaviour at the PCC.',
  },
  'RD 244/2019': {
    term: 'RD 244/2019',
    definition:
      'Spanish Royal Decree governing self-consumption: registration, metering, compensation mechanism (simplified or surplus sold), and reporting duties.',
  },
  CECRE: {
    term: 'CECRE',
    full: 'Centro de Control de Energías Renovables',
    definition:
      'REE control centre for renewables in Spain. Plants ≥ 1 MW must stream real-time telemetry here.',
  },
  CNMC: {
    term: 'CNMC',
    full: 'Comisión Nacional de los Mercados y la Competencia',
    definition:
      'Spanish national markets & competition regulator. Oversees electricity market, settlement, and self-consumption declarations.',
  },
  GSE: {
    term: 'GSE',
    full: 'Gestore dei Servizi Energetici',
    definition:
      'Italian state-owned body that administers renewable incentive schemes (SSP, RID) and collects monthly production telemetry.',
  },
  ARERA: {
    term: 'ARERA',
    full: 'Autorità di Regolazione per Energia Reti e Ambiente',
    definition: 'Italian energy, networks, and environment regulator.',
  },
  Terna: {
    term: 'Terna',
    definition:
      'Italian transmission system operator (TSO). Runs the HV grid and publishes grid-code annexes (CEI 0-16).',
  },
  REE: {
    term: 'REE',
    full: 'Red Eléctrica de España',
    definition: 'Spanish TSO. Operates the transmission grid and CECRE.',
  },
  SSP: {
    term: 'SSP',
    full: 'Scambio Sul Posto',
    definition:
      'Italian "on-site exchange" net-metering scheme administered by GSE for small self-consumption plants.',
  },
  RID: {
    term: 'RID',
    full: 'Ritiro Dedicato',
    definition:
      'Italian dedicated withdrawal scheme — GSE purchases excess energy from qualifying plants at regulated prices.',
  },
  DEWA: {
    term: 'DEWA',
    full: 'Dubai Electricity & Water Authority',
    definition: 'Integrated utility for Dubai; runs distribution + Shams Dubai net-metering.',
  },
  EWEC: {
    term: 'EWEC',
    full: 'Emirates Water & Electricity Company',
    definition: 'Abu Dhabi utility offtaker and single buyer.',
  },
  'Shams Dubai': {
    term: 'Shams Dubai',
    definition:
      'DEWA\'s distributed solar programme. Net-metered rooftop/commercial PV with technical requirements defined by DEWA.',
  },
  RSB: {
    term: 'RSB',
    full: 'Regulatory & Supervisory Bureau',
    definition: 'Dubai regulator for electricity, water, and district cooling.',
  },
  WERA: {
    term: 'WERA',
    full: 'Water and Electricity Regulatory Authority',
    definition: 'Saudi Arabian energy regulator (formerly ECRA).',
  },
  SEC: {
    term: 'SEC',
    full: 'Saudi Electricity Company',
    definition: 'Saudi utility operating transmission and distribution.',
  },
  SPPC: {
    term: 'SPPC',
    full: 'Saudi Power Procurement Company',
    definition: 'Single-buyer offtaker for utility-scale IPPs in Saudi Arabia.',
  },
  SSPV: {
    term: 'SSPV',
    full: 'Small-Scale Solar PV',
    definition:
      'Saudi regulatory framework for distributed rooftop/commercial PV with net billing (not net metering).',
  },
  EPRA: {
    term: 'EPRA',
    full: 'Energy and Petroleum Regulatory Authority',
    definition: 'Kenyan energy sector regulator.',
  },
  KPLC: {
    term: 'KPLC',
    full: 'Kenya Power & Lighting Company',
    definition: 'Kenyan single-buyer utility and offtaker for PPAs.',
  },
  NEMA: {
    term: 'NEMA',
    full: 'National Environment Management Authority',
    definition: 'Kenyan environmental regulator — reviews EIAs and annual compliance audits.',
  },
  NERC: {
    term: 'NERC',
    full: 'Nigerian Electricity Regulatory Commission',
    definition: 'Federal regulator for the Nigerian electricity industry.',
  },
  NBET: {
    term: 'NBET',
    full: 'Nigerian Bulk Electricity Trading',
    definition: 'Single-buyer bulk trader that signs PPAs with IPPs in Nigeria.',
  },
  NEMSA: {
    term: 'NEMSA',
    full: 'Nigerian Electricity Management Services Agency',
    definition: 'Nigerian electrical safety agency — mandates pre-energisation inspection.',
  },
  NERSA: {
    term: 'NERSA',
    full: 'National Energy Regulator of South Africa',
    definition: 'South African electricity, gas, and piped-fuel regulator.',
  },
  SSEG: {
    term: 'SSEG',
    full: 'Small-Scale Embedded Generation',
    definition:
      'South African category for distributed generation ≤ 1 MW connected at LV/MV. Governed by NRS 097-2-1 and NRS 097-2-3.',
  },
  'NRS 097': {
    term: 'NRS 097',
    definition:
      'South African standard series for grid connection of embedded generation. -2-1 covers utility interface, -2-3 covers simplified registration for ≤ 100 kVA.',
  },
  RPP: {
    term: 'RPP',
    full: 'Renewable Power Plant',
    definition:
      'South African grid-code category covering larger renewable plants (> 1 MW). Sub-categorised A1/A2/A3/B/C by capacity with escalating requirements.',
  },
  REIPPPP: {
    term: 'REIPPPP',
    full: 'Renewable Energy Independent Power Producer Procurement Programme',
    definition:
      'South African competitive procurement programme for utility-scale renewables, overseen by DMRE.',
  },
  COC: {
    term: 'COC',
    full: 'Certificate of Compliance',
    definition:
      'South African post-installation certificate issued by an accredited electrician. Must be revalidated after modifications.',
  },
  GoO: {
    term: 'GoO',
    full: 'Guarantees of Origin',
    definition:
      'EU tradable certificate attesting that 1 MWh of electricity was generated from renewables. Issued via national registries (REN in PT, GSE in IT, CNMC in ES).',
  },
  DiCo: {
    term: 'DiCo',
    full: 'Dichiarazione di Conformità',
    definition:
      'Italian declaration of conformity issued by the installer at commissioning. Required for grid connection.',
  },
  OCA: {
    term: 'OCA',
    full: 'Organismo de Control Autorizado',
    definition:
      'Spanish accredited inspection body. Required 5-yearly inspection for installations > 100 kW.',
  },
};

export function lookupTerm(term: string): GlossaryEntry | undefined {
  return GLOSSARY[term];
}
