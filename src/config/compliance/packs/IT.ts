import type { CompliancePack } from '../types';

/**
 * Italy.
 * Regulator: ARERA (Autorità di Regolazione per Energia Reti e Ambiente).
 * Grid operator: Terna (HV) / distribution companies (LV/MV).
 * Incentive manager: GSE (Gestore Servizi Energetici) for SSP/RID schemes.
 * Connection standards: CEI 0-16 (MV/HV) and CEI 0-21 (LV).
 */
export const IT: CompliancePack = {
  country: 'IT',
  version: '2026.Q2',
  display_name: 'Italy',
  default_timezone: 'Europe/Rome',
  default_currency: 'EUR',
  language: 'it-IT',
  context:
    'Italy has a strict, standards-driven grid code: CEI 0-16 for MV/HV, CEI 0-21 for LV, with an Interface Protection System (SPI) using type-approved relays. ' +
    'ARERA is the overarching regulator; GSE administers incentive schemes (SSP, RID) and collects monthly production data via a dedicated portal. ' +
    'Plants above 1 MW stream telemetry to Terna. Fault-ride-through events must be logged and submitted in the Terna fault logbook.',
  key_terms: ['CEI 0-16', 'CEI 0-21', 'Terna', 'GSE', 'ARERA', 'SSP', 'RID', 'DiCo', 'LVRT', 'PCC', 'FRT', 'GoO'],
  regulator: { name: 'ARERA', url: 'https://www.arera.it' },
  grid_operator: { name: 'Terna', url: 'https://www.terna.it' },
  grid_code: {
    reference: 'CEI 0-16 (MV/HV) / CEI 0-21 (LV)',
    lvrt_curve: [
      { t_ms: 0, u_pu: 0.05 },
      { t_ms: 200, u_pu: 0.4 },
      { t_ms: 500, u_pu: 0.7 },
      { t_ms: 1500, u_pu: 0.85 },
      { t_ms: 3000, u_pu: 0.9 },
    ],
    reactive_power_range: [-0.9, 0.9],
    frequency_range_hz: [47.5, 51.5],
    anti_islanding_standard: 'CEI 0-21 / CEI 0-16',
    active_power_ramp_pct_per_min: 20,
    notes: 'Interface Protection System (SPI) with certified relays required. Plants >1 MW stream to Terna portal.',
  },
  metering: {
    meter_class: '0.5S',
    interval_minutes: 15,
    retention_years: 10,
    calibration_cadence_months: 60,
  },
  reporting_obligations: [
    {
      id: 'IT.GSE.monthly_production',
      name: 'GSE monthly production telemetry',
      description: 'Monthly production data for plants under SSP (Scambio Sul Posto) or RID (Ritiro Dedicato).',
      recipient: 'GSE',
      cadence: 'monthly',
      format: 'portal_form',
      applies_when: { asset_type: ['SOLAR', 'WIND', 'BESS'] },
      section_id: 'it_gse_monthly_production',
      deadline_days_after_period: 15,
      source: { url: 'https://www.gse.it' },
    },
    {
      id: 'IT.TERNA.fault_logbook',
      name: 'Terna fault-ride-through logbook',
      description: 'Event-based log of LVRT events and Interface Protection activations.',
      recipient: 'Terna',
      cadence: 'event_based',
      format: 'csv',
      applies_when: { capacity_mw_min: 1 },
      section_id: 'it_terna_fault_logbook',
      deadline_days_after_period: 7,
      source: { url: 'https://www.terna.it', clause: 'CEI 0-16 Annex' },
    },
    {
      id: 'IT.ARERA.qos_annual',
      name: 'ARERA annual quality-of-service report',
      recipient: 'ARERA',
      cadence: 'annual',
      format: 'pdf',
      applies_when: { capacity_mw_min: 1 },
      section_id: 'it_arera_qos',
      deadline_days_after_period: 90,
      source: { url: 'https://www.arera.it' },
    },
  ],
  inspection_cadence: [
    { type: 'DiCo (Dichiarazione di Conformità)', interval_months: 0, authority: 'Installer at commissioning' },
    { type: 'ASL safety audit', interval_months: 60, authority: 'ASL (local health authority)', capacity_mw_min: 0.02 },
  ],
  environmental_reporting: [
    { program: 'Guarantees of Origin (GoO)', cadence: 'monthly', recipient: 'GSE', mandatory: true },
  ],
  report_sections: ['it_gse_monthly_production', 'it_terna_fault_logbook', 'it_arera_qos'],
  source_documents: [
    { title: 'CEI 0-16 - MV/HV grid connection', url: 'https://www.ceinorme.it', verified_at: '2026-04-14' },
    { title: 'CEI 0-21 - LV grid connection', url: 'https://www.ceinorme.it', verified_at: '2026-04-14' },
    { title: 'GSE portal', url: 'https://www.gse.it', verified_at: '2026-04-14' },
  ],
};
