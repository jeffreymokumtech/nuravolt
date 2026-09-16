import type { CompliancePack } from '../types';

/**
 * Portugal — Mainland.
 * Regulator: DGEG (Direção-Geral de Energia e Geologia) + ERSE.
 * Grid operator: REN (Redes Energéticas Nacionais).
 * Self-consumption: DL 15/2022. Grid code aligned to ENTSO-E.
 */
export const PT: CompliancePack = {
  country: 'PT',
  version: '2026.Q2',
  display_name: 'Portugal',
  default_timezone: 'Europe/Lisbon',
  default_currency: 'EUR',
  language: 'pt-PT',
  context:
    'Portugal follows an ENTSO-E aligned grid code (Portaria 596/2010) with self-consumption governed by DL 15/2022. ' +
    'DGEG is the licensing authority and collector of monthly autoconsumo declarations; REN operates the transmission system and the Guarantees of Origin registry. ' +
    'Technical requirements closely mirror Spain but the reporting cadence and portals differ.',
  key_terms: ['LVRT', 'PCC', 'GoO'],
  regulator: { name: 'DGEG', url: 'https://www.dgeg.gov.pt' },
  grid_operator: { name: 'REN', url: 'https://www.ren.pt' },
  grid_code: {
    reference: 'Portaria 596/2010 / DL 15/2022',
    lvrt_curve: [
      { t_ms: 0, u_pu: 0.2 },
      { t_ms: 150, u_pu: 0.2 },
      { t_ms: 700, u_pu: 0.7 },
      { t_ms: 1500, u_pu: 0.85 },
      { t_ms: 3000, u_pu: 0.9 },
    ],
    reactive_power_range: [-0.95, 0.95],
    frequency_range_hz: [47.5, 51.5],
    anti_islanding_standard: 'IEC 62116',
    active_power_ramp_pct_per_min: 10,
  },
  metering: {
    meter_class: '0.5S',
    interval_minutes: 15,
    retention_years: 10,
    calibration_cadence_months: 60,
  },
  reporting_obligations: [
    {
      id: 'PT.DGEG.autoconsumo_monthly',
      name: 'Monthly autoconsumo declaration',
      description: 'Self-consumption production declaration to DGEG.',
      recipient: 'DGEG',
      cadence: 'monthly',
      format: 'portal_form',
      applies_when: { asset_type: ['SOLAR', 'WIND', 'BESS'] },
      section_id: 'pt_dgeg_autoconsumo',
      deadline_days_after_period: 15,
      source: { url: 'https://dre.pt/dre/detalhe/decreto-lei/15-2022', clause: 'DL 15/2022' },
    },
    {
      id: 'PT.REN.availability_quarterly',
      name: 'Quarterly availability report',
      recipient: 'REN',
      cadence: 'quarterly',
      format: 'csv',
      applies_when: { capacity_mw_min: 1 },
      section_id: 'pt_ren_availability',
      deadline_days_after_period: 30,
      source: { url: 'https://www.ren.pt' },
    },
    {
      id: 'PT.DGEG.licence_renewal',
      name: 'Annual licence renewal dossier',
      recipient: 'DGEG',
      cadence: 'annual',
      format: 'pdf',
      applies_when: { capacity_mw_min: 1 },
      section_id: 'pt_licence_renewal',
      deadline_days_after_period: 60,
      source: { url: 'https://www.dgeg.gov.pt' },
    },
  ],
  inspection_cadence: [
    { type: 'Periodic inspection', interval_months: 60, authority: 'Accredited inspector', capacity_mw_min: 0.1 },
  ],
  environmental_reporting: [
    { program: 'Guarantees of Origin (GoO)', cadence: 'monthly', recipient: 'REN GoO registry', mandatory: true },
  ],
  report_sections: ['pt_dgeg_autoconsumo', 'pt_ren_availability', 'pt_licence_renewal'],
  source_documents: [
    { title: 'DL 15/2022 - Self-consumption', url: 'https://dre.pt/dre/detalhe/decreto-lei/15-2022', verified_at: '2026-04-14' },
    { title: 'Portaria 596/2010 - Grid code', url: 'https://dre.pt', verified_at: '2026-04-14' },
  ],
};
