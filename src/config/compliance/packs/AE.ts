import type { CompliancePack } from '../types';

/**
 * United Arab Emirates.
 * Federal regulator: Ministry of Energy & Infrastructure (MOEI).
 * Emirate-level distribution utilities: DEWA (Dubai), EWEC/ADDC/AADC (Abu Dhabi), SEWA, FEWA.
 * Dubai net-metering program: Shams Dubai.
 * Dominant grid code model: DEWA Distribution Code.
 */
export const AE: CompliancePack = {
  country: 'AE',
  version: '2026.Q2',
  display_name: 'United Arab Emirates',
  default_timezone: 'Asia/Dubai',
  default_currency: 'AED',
  language: 'en-AE',
  context:
    'The UAE has no unified federal utility — each emirate operates its own distribution company (DEWA in Dubai, EWEC/ADDC in Abu Dhabi, SEWA in Sharjah, FEWA in the Northern Emirates). ' +
    'Dubai\'s Shams Dubai programme is the dominant distributed-PV framework: net-metered (not feed-in), with IEC 61727 anti-islanding and a Q-U reactive-power curve set in the connection agreement. ' +
    'Reporting is typically done through each utility\'s own customer portal rather than a central regulator.',
  key_terms: ['DEWA', 'EWEC', 'Shams Dubai', 'RSB', 'PCC', 'LVRT'],
  regulator: { name: 'Regulatory & Supervisory Bureau (RSB) / MOEI', url: 'https://www.moei.gov.ae' },
  grid_operator: { name: 'DEWA / EWEC / FEWA', url: 'https://www.dewa.gov.ae' },
  grid_code: {
    reference: 'DEWA Distribution Code / Shams Dubai Technical Requirements',
    lvrt_curve: [
      { t_ms: 0, u_pu: 0.15 },
      { t_ms: 200, u_pu: 0.3 },
      { t_ms: 1000, u_pu: 0.85 },
      { t_ms: 3000, u_pu: 0.9 },
    ],
    reactive_power_range: [-0.9, 0.9],
    frequency_range_hz: [47.0, 52.0],
    anti_islanding_standard: 'IEC 61727 / IEEE 1547',
    notes: 'Net-metering only (no feed-in tariff). Q-U curve mandated per connection agreement.',
  },
  metering: {
    meter_class: '0.5S',
    interval_minutes: 15,
    retention_years: 10,
    calibration_cadence_months: 60,
  },
  reporting_obligations: [
    {
      id: 'AE.DEWA.shams_monthly',
      name: 'Shams Dubai monthly production reading',
      description: 'Monthly generation reading submitted via DEWA customer portal for net-metering settlement.',
      recipient: 'DEWA',
      cadence: 'monthly',
      format: 'portal_form',
      applies_when: { asset_type: ['SOLAR', 'BESS'] },
      section_id: 'ae_dewa_shams_monthly',
      deadline_days_after_period: 15,
      source: { url: 'https://www.dewa.gov.ae/en/consumer/solar-community/shams-dubai' },
    },
    {
      id: 'AE.RSB.annual_compliance',
      name: 'Annual compliance certification',
      recipient: 'RSB (Dubai) / EWEC (Abu Dhabi)',
      cadence: 'annual',
      format: 'pdf',
      applies_when: { capacity_mw_min: 1 },
      section_id: 'ae_rsb_annual',
      deadline_days_after_period: 60,
      source: { url: 'https://www.rsb.gov.ae' },
    },
  ],
  inspection_cadence: [
    {
      type: 'Third-party technical audit',
      interval_months: 12,
      authority: 'Offtaker-appointed auditor',
      capacity_mw_min: 1,
    },
  ],
  environmental_reporting: [
    {
      program: 'UAE Net Zero 2050 emission-avoidance reporting',
      cadence: 'annual',
      recipient: 'MOEI',
      mandatory: false,
    },
  ],
  report_sections: ['ae_dewa_shams_monthly', 'ae_rsb_annual'],
  source_documents: [
    { title: 'DEWA Distribution Code', url: 'https://www.dewa.gov.ae', verified_at: '2026-04-14' },
    { title: 'Shams Dubai programme', url: 'https://www.dewa.gov.ae/en/consumer/solar-community/shams-dubai', verified_at: '2026-04-14' },
  ],
};
