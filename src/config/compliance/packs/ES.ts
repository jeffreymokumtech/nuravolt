import type { CompliancePack } from '../types';

/**
 * Spain — Mainland.
 * Primary regulator: CNMC (Comisión Nacional de los Mercados y la Competencia).
 * Grid operator: REE (Red Eléctrica de España).
 * Self-consumption framework: RD 244/2019.
 * Grid code: P.O. (Procedimientos de Operación) series, notably 12.2 and 12.3.
 */
export const ES: CompliancePack = {
  country: 'ES',
  version: '2026.Q2',
  display_name: 'Spain',
  default_timezone: 'Europe/Madrid',
  default_currency: 'EUR',
  language: 'es-ES',
  context:
    'Spain separates technical grid operation (REE / CECRE) from market and competition oversight (CNMC). ' +
    'Self-consumption was liberalised by RD 244/2019 and now covers most rooftop and commercial installations under either simplified compensation or surplus-sale regimes. ' +
    'Larger plants (≥ 1 MW) are dispatched through CECRE and must obey the Procedimientos de Operación — notably P.O. 12.3 for fault ride-through.',
  key_terms: ['REE', 'CNMC', 'CECRE', 'P.O. 12.3', 'RD 244/2019', 'OCA', 'LVRT', 'PCC', 'GoO'],
  regulator: { name: 'CNMC', url: 'https://www.cnmc.es' },
  grid_operator: { name: 'Red Eléctrica de España (REE)', url: 'https://www.ree.es' },
  grid_code: {
    reference: 'P.O. 12.2 / P.O. 12.3 / RD 413/2014 / RD 244/2019',
    // Simplified P.O. 12.3 ride-through envelope
    lvrt_curve: [
      { t_ms: 0, u_pu: 0.2 },
      { t_ms: 150, u_pu: 0.2 },
      { t_ms: 500, u_pu: 0.6 },
      { t_ms: 1000, u_pu: 0.8 },
      { t_ms: 3000, u_pu: 0.9 },
    ],
    reactive_power_range: [-0.95, 0.95],
    frequency_range_hz: [47.5, 51.5],
    anti_islanding_standard: 'UNE 206007-1 / IEC 62116',
    active_power_ramp_pct_per_min: 10,
    notes: 'Plants >=1 MW must stream real-time telemetry to CECRE.',
  },
  metering: {
    meter_class: '0.5S',
    interval_minutes: 15,
    retention_years: 10,
    calibration_cadence_months: 60,
  },
  reporting_obligations: [
    {
      id: 'ES.CNMC.self_consumption_monthly',
      name: 'Monthly self-consumption declaration',
      description: 'Declaration of generation and self-consumption to the distribution utility / CNMC.',
      recipient: 'Distributor / CNMC',
      cadence: 'monthly',
      format: 'portal_form',
      applies_when: { asset_type: ['SOLAR', 'WIND', 'BESS'] },
      section_id: 'es_cnmc_self_consumption',
      deadline_days_after_period: 20,
      source: {
        url: 'https://www.boe.es/eli/es/rd/2019/04/05/244',
        clause: 'RD 244/2019, Art. 14',
      },
    },
    {
      id: 'ES.REE.cecre_telemetry',
      name: 'CECRE real-time telemetry summary',
      description: 'Monthly summary of availability and curtailment events for plants streaming to CECRE.',
      recipient: 'REE (CECRE)',
      cadence: 'monthly',
      format: 'csv',
      applies_when: { capacity_mw_min: 1, asset_type: ['SOLAR', 'WIND'] },
      section_id: 'es_ree_cecre_summary',
      deadline_days_after_period: 10,
      source: { url: 'https://www.ree.es/es/cecre', clause: 'P.O. 12.2' },
    },
    {
      id: 'ES.CNMC.annual_production',
      name: 'Annual production report',
      description: 'Yearly production & settlement report for plants under regulated remuneration.',
      recipient: 'CNMC',
      cadence: 'annual',
      format: 'pdf',
      applies_when: { asset_type: ['SOLAR', 'WIND', 'BESS'] },
      section_id: 'es_annual_production',
      deadline_days_after_period: 90,
      source: { url: 'https://www.cnmc.es', clause: 'RD 413/2014' },
    },
  ],
  inspection_cadence: [
    {
      type: 'OCA (Organismo de Control Autorizado)',
      interval_months: 60,
      authority: 'Accredited OCA body',
      capacity_mw_min: 0.1,
    },
  ],
  environmental_reporting: [
    {
      program: 'Guarantees of Origin (GoO)',
      cadence: 'monthly',
      recipient: 'CNMC GoO registry',
      mandatory: true,
    },
  ],
  report_sections: [
    'es_cnmc_self_consumption',
    'es_ree_cecre_summary',
    'es_annual_production',
  ],
  tariff_ref: 'SPANISH_PVPC',
  source_documents: [
    {
      title: 'RD 244/2019 - Self-consumption',
      url: 'https://www.boe.es/eli/es/rd/2019/04/05/244',
      verified_at: '2026-04-14',
    },
    {
      title: 'P.O. 12.3 - Technical operation procedures',
      url: 'https://www.ree.es/es/actividades/operacion-del-sistema-electrico/procedimientos-de-operacion',
      clause: 'P.O. 12.3',
      verified_at: '2026-04-14',
    },
  ],
};
