import type { CompliancePack } from '../types';

/**
 * Great Britain.
 * Regulator: Ofgem (Office of Gas and Electricity Markets).
 * System operator: NESO (National Energy System Operator), public corporation since October 2024,
 * successor to National Grid ESO and administrator of the Grid Code.
 * Settlement: Elexon as BSC Agent (half-hourly settlement periods); EMR Settlement Ltd for the
 * Capacity Market and CfD.
 *
 * Deliberately sparse where GB rules are capacity-band or connection-class dependent: the
 * ride-through envelope, reactive capability, frequency obligation, meter accuracy class and
 * every submission deadline are left unset with a named document to check, rather than filled
 * with a plausible-looking number. A UK operator will recognise a guessed Grid Code figure
 * immediately.
 */

/**
 * Fields we refuse to guess are simply omitted. `applicableObligations` treats an unset
 * threshold as "applies to everyone", and every renderer says the value is not verified rather
 * than inventing one. Each omission carries its own TODO(verify) naming the document to check.
 */
export const GB: CompliancePack = {
  country: 'GB',
  version: '2026.Q3',
  display_name: 'United Kingdom (Great Britain)',
  default_timezone: 'Europe/London',
  default_currency: 'GBP',
  language: 'en-GB',
  context:
    'Great Britain separates system operation from regulation and settlement. NESO has run the electricity system as a public corporation since October 2024, taking over from National Grid ESO, and administers the Grid Code. ' +
    'Ofgem is the economic regulator and approves code changes; Elexon acts as BSC Agent and settles the wholesale market in half-hourly settlement periods, with EMR Settlement Ltd handling Capacity Market and CfD settlement. ' +
    'Distribution-connected plants sit under the Distribution Code and ENA EREC G99 rather than the Grid Code, so the obligations that bite depend on where and at what size the plant connects.',
  key_terms: [
    'NESO',
    'Ofgem',
    'Elexon',
    'BSC',
    'BMU',
    'CMU',
    'EREC G99',
    'SQSS',
    'EFA block',
    'settlement period',
    'cash-out',
    'REGO',
  ],
  regulator: { name: 'Ofgem', url: 'https://www.ofgem.gov.uk' },
  grid_operator: { name: 'National Energy System Operator (NESO)', url: 'https://www.neso.energy' },
  grid_code: {
    reference: 'GB Grid Code / Distribution Code / ENA EREC G99 / NETS SQSS',
    // TODO(verify): GB Grid Code CC.6.3.15 / ECC.6.3.15 fault ride-through envelope.
    //   lvrt_curve omitted until confirmed.
    // TODO(verify): GB Grid Code CC.6.3.2 reactive capability at the Grid Entry Point.
    //   reactive_power_range omitted until confirmed.
    // TODO(verify): the continuous 49.5-50.5 Hz band and the wider survival band are widely
    // quoted for GB, but the binding obligation differs by connection class (Grid Code CC.6.1.3
    // for transmission-connected plant vs EREC G99 Type A-D for distribution-connected plant),
    // so no pair is asserted here until the plant's class is known. frequency_range_hz omitted.
    anti_islanding_standard: 'ENA EREC G99',
    // TODO(verify): ramp rate obligation is set in the bilateral connection agreement / Grid Code
    // BC1 rather than a single national figure. active_power_ramp_pct_per_min omitted.
    notes:
      'Distribution-connected plant follows the Distribution Code and ENA EREC G99; transmission-connected plant follows the Grid Code. ' +
      'Battery sites are commonly designed against the international fire safety standards NFPA 855 and IEC 62933-5-2. ' +
      'TODO(verify): the UK planning and statutory position on grid-scale battery storage safety has changed repeatedly, so no UK statutory instrument or planning regulation is cited here until confirmed against legislation.gov.uk.',
  },
  metering: {
    // GB settles on half-hourly settlement periods under the Balancing and Settlement Code.
    interval_minutes: 30,
    // TODO(verify): BSC Code of Practice CoP1/CoP2/CoP3/CoP5 sets meter accuracy class,
    // data retention and calibration cadence against capacity bands. The MW boundary between
    // Codes of Practice is not confirmed, so meter_class, retention_years and
    // calibration_cadence_months are omitted rather than guessed.
  },
  reporting_obligations: [
    {
      id: 'GB.ELEXON.bsc_hh_settlement',
      name: 'Half-hourly metered data for settlement',
      description:
        'Half-hourly metered volumes flowed to the BSC settlement systems for each metering system, used to settle imbalance against the Balancing Mechanism Unit.',
      recipient: 'Elexon (BSC Agent)',
      cadence: 'event_based',
      format: 'csv',
      applies_when: { asset_type: ['SOLAR', 'WIND', 'BESS'] },
      section_id: 'gb_bsc_hh_settlement',
      // TODO(verify): BSC settlement timetable (initial and final reconciliation runs) sets the
      // effective submission windows; no day count asserted, so
      // deadline_days_after_period is omitted.
      source: { url: 'https://www.elexon.co.uk', clause: 'Balancing and Settlement Code' },
    },
    {
      id: 'GB.NESO.grid_code_data',
      name: 'Grid Code operational data submission',
      description:
        'Operational and planning data submitted to NESO for units registered in the Balancing Mechanism, covering availability, output and outage plans.',
      recipient: 'NESO',
      cadence: 'event_based',
      format: 'csv',
      applies_when: {
        // TODO(verify): GB Grid Code applicability threshold (registered capacity by transmission
        // area, and the BM registration threshold) before asserting a capacity_mw_min. Omitted
        // for now, so the obligation is listed for every capacity.
        asset_type: ['SOLAR', 'WIND', 'BESS'],
      },
      section_id: 'gb_neso_grid_code_data',
      // TODO(verify): Grid Code Operating Code submission windows.
      //   deadline_days_after_period omitted until confirmed.
      source: { url: 'https://www.neso.energy/industry-information/codes/grid-code' },
    },
    {
      id: 'GB.EMRS.cm_performance',
      name: 'Capacity Market performance and metering',
      description:
        'Performance and metering evidence for a Capacity Market Unit holding a capacity agreement, including the metering test and satisfactory performance days.',
      recipient: 'EMR Settlement Ltd',
      cadence: 'annual',
      format: 'portal_form',
      applies_when: { asset_type: ['BESS'] },
      section_id: 'gb_emrs_cm_performance',
      // TODO(verify): Capacity Market Rules deadlines for the metering test and performance
      // submissions relative to the delivery year. deadline_days_after_period omitted.
      source: { url: 'https://www.emrsettlement.co.uk', clause: 'Capacity Market Rules' },
    },
    {
      id: 'GB.OFGEM.rego',
      name: 'REGO output declaration',
      description:
        'Monthly renewable output declared to the Ofgem Renewables and CHP Register so REGO certificates can be issued, one per MWh of eligible generation.',
      recipient: 'Ofgem',
      cadence: 'monthly',
      format: 'portal_form',
      // A battery is not a generator for REGO purposes: it stores and returns energy rather
      // than producing it, so BESS is excluded here on purpose, not by oversight.
      applies_when: { asset_type: ['SOLAR', 'WIND'] },
      section_id: 'gb_ofgem_rego',
      // TODO(verify): Ofgem Renewables and CHP Register submission window per output period.
      //   deadline_days_after_period omitted until confirmed.
      source: {
        url: 'https://www.ofgem.gov.uk/environmental-and-social-schemes/renewable-energy-guarantees-origin-rego',
      },
    },
  ],
  // TODO(verify): GB has no single periodic inspection cadence for generation plant equivalent to
  // the Spanish OCA regime; BS 7671 periodic inspection intervals depend on installation type.
  // Left out rather than invented.
  environmental_reporting: [
    {
      program: 'Renewable Energy Guarantees of Origin (REGO)',
      cadence: 'monthly',
      recipient: 'Ofgem Renewables and CHP Register',
      // REGO accreditation is opted into by the generator, not imposed on every plant.
      mandatory: false,
    },
  ],
  report_sections: [
    'gb_bsc_hh_settlement',
    'gb_neso_grid_code_data',
    'gb_emrs_cm_performance',
    'gb_ofgem_rego',
  ],
  source_documents: [
    {
      title: 'GB Grid Code',
      url: 'https://www.neso.energy/industry-information/codes/grid-code',
      verified_at: '2026-07-28',
    },
    {
      title: 'NETS Security and Quality of Supply Standard (SQSS)',
      url: 'https://www.neso.energy/industry-information/codes/security-and-quality-supply-standard-sqss',
      verified_at: '2026-07-28',
    },
    {
      title: 'The Distribution Code and ENA EREC G99',
      url: 'https://dcode.org.uk',
      clause: 'ENA EREC G99',
      verified_at: '2026-07-28',
    },
    {
      title: 'Balancing and Settlement Code',
      url: 'https://www.elexon.co.uk',
      verified_at: '2026-07-28',
    },
    {
      title: 'Capacity Market settlement (EMR Settlement Ltd)',
      url: 'https://www.emrsettlement.co.uk',
      verified_at: '2026-07-28',
    },
    {
      title: 'Renewable Energy Guarantees of Origin (REGO)',
      url: 'https://www.ofgem.gov.uk/environmental-and-social-schemes/renewable-energy-guarantees-origin-rego',
      verified_at: '2026-07-28',
    },
  ],
};
