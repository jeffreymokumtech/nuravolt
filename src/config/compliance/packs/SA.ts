import type { CompliancePack } from '../types';

/**
 * Saudi Arabia.
 * Regulator: WERA (Water and Electricity Regulatory Authority, formerly ECRA).
 * Offtaker: SPPC (Saudi Power Procurement Company) for utility-scale IPPs.
 * Grid operator: Saudi Electricity Company (SEC) / National Grid SA.
 * Small-scale program: Small-Scale Solar PV (SSPV) regulation with net billing.
 */
export const SA: CompliancePack = {
  country: 'SA',
  version: '2026.Q2',
  display_name: 'Saudi Arabia',
  default_timezone: 'Asia/Riyadh',
  default_currency: 'SAR',
  language: 'ar-SA',
  context:
    'Saudi Arabia runs a nominal 60 Hz grid. WERA (formerly ECRA) regulates the sector; SEC + National Grid SA operate transmission and distribution. ' +
    'Utility-scale renewables are procured through the NREP auction programme and sold under PPA to the single-buyer SPPC. ' +
    'Distributed rooftop / commercial PV is governed by the SSPV Regulation which uses net billing (offset at wholesale, not retail). Grid-code compliance is independently audited twice per year above 1 MW.',
  key_terms: ['WERA', 'SEC', 'SPPC', 'SSPV', 'LVRT', 'PCC'],
  regulator: { name: 'WERA', url: 'https://wera.gov.sa' },
  grid_operator: { name: 'SEC / National Grid SA', url: 'https://www.se.com.sa' },
  grid_code: {
    reference: 'SEC Grid Code / SSPV Regulation',
    lvrt_curve: [
      { t_ms: 0, u_pu: 0.15 },
      { t_ms: 250, u_pu: 0.3 },
      { t_ms: 1000, u_pu: 0.7 },
      { t_ms: 3000, u_pu: 0.9 },
    ],
    reactive_power_range: [-0.95, 0.95],
    frequency_range_hz: [57.0, 62.0],
    anti_islanding_standard: 'IEEE 1547 / IEC 62116',
    active_power_ramp_pct_per_min: 10,
    notes: 'Net billing (not net metering). Strict reactive power follow-me curve mandated for >1 MW.',
  },
  metering: {
    meter_class: '0.5S',
    interval_minutes: 15,
    retention_years: 10,
    calibration_cadence_months: 60,
  },
  reporting_obligations: [
    {
      id: 'SA.SPPC.semi_annual_performance',
      name: 'Semi-annual performance report',
      description: 'Performance, availability and curtailment report to the offtaker.',
      recipient: 'SPPC',
      cadence: 'semi_annual',
      format: 'pdf',
      applies_when: { capacity_mw_min: 1 },
      section_id: 'sa_sppc_performance',
      deadline_days_after_period: 45,
      source: { url: 'https://www.sppc.sa' },
    },
    {
      id: 'SA.WERA.technical_audit',
      name: 'Semi-annual technical audit',
      description: 'Grid-code compliance audit: reactive-power curve, protection settings, fault records.',
      recipient: 'WERA',
      cadence: 'semi_annual',
      format: 'pdf',
      applies_when: { capacity_mw_min: 1 },
      section_id: 'sa_wera_technical_audit',
      deadline_days_after_period: 30,
      source: { url: 'https://wera.gov.sa' },
    },
    {
      id: 'SA.SEC.sspv_monthly',
      name: 'SSPV monthly net-billing reading',
      recipient: 'SEC',
      cadence: 'monthly',
      format: 'portal_form',
      applies_when: { capacity_mw_max: 2, asset_type: ['SOLAR'] },
      section_id: 'sa_sec_sspv_monthly',
      deadline_days_after_period: 10,
      source: { url: 'https://www.se.com.sa' },
    },
  ],
  inspection_cadence: [
    {
      type: 'Technical audit',
      interval_months: 6,
      authority: 'Offtaker-appointed auditor',
      capacity_mw_min: 1,
    },
  ],
  environmental_reporting: [
    { program: 'Vision 2030 emission-avoidance reporting', cadence: 'annual', recipient: 'MoEnergy', mandatory: false },
  ],
  report_sections: ['sa_sppc_performance', 'sa_wera_technical_audit', 'sa_sec_sspv_monthly'],
  source_documents: [
    { title: 'SEC Grid Code', url: 'https://www.se.com.sa', verified_at: '2026-04-14' },
    { title: 'SSPV Regulation', url: 'https://wera.gov.sa', verified_at: '2026-04-14' },
  ],
};
