import type { CompliancePack } from '../types';

/**
 * Kenya.
 * Regulator: EPRA (Energy and Petroleum Regulatory Authority).
 * Offtaker: KPLC (Kenya Power & Lighting Co.).
 * Environmental oversight: NEMA (National Environment Management Authority).
 * Policy reference: Energy Act 2019, EPRA Grid Code 2020, Feed-in Tariff policy.
 */
export const KE: CompliancePack = {
  country: 'KE',
  version: '2026.Q2',
  display_name: 'Kenya',
  default_timezone: 'Africa/Nairobi',
  default_currency: 'KES',
  language: 'en-KE',
  context:
    'Kenya\'s Energy Act 2019 restructured the sector into separate generation, transmission and distribution functions. ' +
    'EPRA is the sole regulator (tariffs, licensing, grid code); KPLC remains the single buyer under PPAs, with KETRACO owning new transmission. ' +
    'Previously a Feed-in Tariff scheme applied below 10 MW; it is being transitioned into a competitive auction model. Environmental compliance is audited annually by NEMA.',
  key_terms: ['EPRA', 'KPLC', 'NEMA', 'LVRT', 'PCC'],
  regulator: { name: 'EPRA', url: 'https://www.epra.go.ke' },
  grid_operator: { name: 'KPLC / KETRACO', url: 'https://www.kplc.co.ke' },
  grid_code: {
    reference: 'EPRA Grid Code 2020 / Energy Act 2019',
    lvrt_curve: [
      { t_ms: 0, u_pu: 0.15 },
      { t_ms: 300, u_pu: 0.4 },
      { t_ms: 1500, u_pu: 0.85 },
      { t_ms: 3000, u_pu: 0.9 },
    ],
    reactive_power_range: [-0.95, 0.95],
    frequency_range_hz: [47.5, 51.5],
    anti_islanding_standard: 'IEC 62116',
    notes: 'Feed-in Tariff policy applies below 10 MW (transitioning to auction model).',
  },
  metering: {
    meter_class: '1.0',
    interval_minutes: 15,
    retention_years: 5,
    calibration_cadence_months: 36,
  },
  reporting_obligations: [
    {
      id: 'KE.EPRA.quarterly_performance',
      name: 'EPRA quarterly generation performance report',
      description: 'Quarterly report on generation, availability, and outage events.',
      recipient: 'EPRA',
      cadence: 'quarterly',
      format: 'pdf',
      applies_when: { asset_type: ['SOLAR', 'WIND', 'BESS'] },
      section_id: 'ke_epra_quarterly',
      deadline_days_after_period: 30,
      source: { url: 'https://www.epra.go.ke' },
    },
    {
      id: 'KE.KPLC.ppa_monthly',
      name: 'KPLC PPA monthly settlement data',
      recipient: 'KPLC',
      cadence: 'monthly',
      format: 'csv',
      applies_when: { capacity_mw_min: 1 },
      section_id: 'ke_kplc_ppa_monthly',
      deadline_days_after_period: 10,
      source: { url: 'https://www.kplc.co.ke' },
    },
    {
      id: 'KE.NEMA.annual_environmental',
      name: 'NEMA annual environmental compliance audit',
      recipient: 'NEMA',
      cadence: 'annual',
      format: 'pdf',
      applies_when: { capacity_mw_min: 0.5 },
      section_id: 'ke_nema_annual',
      deadline_days_after_period: 90,
      source: { url: 'https://www.nema.go.ke' },
    },
  ],
  inspection_cadence: [
    { type: 'EPRA electrical inspection', interval_months: 36, authority: 'EPRA', capacity_mw_min: 0.1 },
  ],
  environmental_reporting: [
    { program: 'NEMA environmental monitoring', cadence: 'annual', recipient: 'NEMA', mandatory: true },
  ],
  report_sections: ['ke_epra_quarterly', 'ke_kplc_ppa_monthly', 'ke_nema_annual'],
  source_documents: [
    { title: 'Energy Act 2019', url: 'https://www.epra.go.ke', verified_at: '2026-04-14' },
    { title: 'EPRA Grid Code 2020', url: 'https://www.epra.go.ke', verified_at: '2026-04-14' },
  ],
};
