import type { ContractType } from '@prisma/client';

/**
 * Closed term vocabulary per contract type. The LLM extractor may only emit
 * fields listed here; numeric values outside [min, max] are rejected soft
 * (mirrors nuravolt/llm/warranty_extractor.py's physics-bounds design).
 * `monitorable` marks fields the obligation evaluator can compute a live
 * status for in v1 — everything else renders as "terms on file".
 */

export type TermKind = 'numeric' | 'text';

export interface TermFieldDef {
  field: string;
  label: string;
  kind: TermKind;
  unit?: string;
  min?: number;
  max?: number;
  monitorable?: boolean;
}

export const CONTRACT_TERM_FIELDS: Record<ContractType, TermFieldDef[]> = {
  PPA: [
    { field: 'price_eur_mwh', label: 'Contract price', kind: 'numeric', unit: 'EUR/MWh', min: 0, max: 500 },
    { field: 'price_mechanism', label: 'Price mechanism', kind: 'text' },
    { field: 'indexation_pct', label: 'Annual indexation', kind: 'numeric', unit: '%', min: 0, max: 10 },
    { field: 'floor_eur_mwh', label: 'Price floor', kind: 'numeric', unit: 'EUR/MWh', min: 0, max: 500 },
    { field: 'cap_eur_mwh', label: 'Price cap', kind: 'numeric', unit: 'EUR/MWh', min: 0, max: 1000 },
    { field: 'term_years', label: 'Contract term', kind: 'numeric', unit: 'years', min: 1, max: 40 },
    { field: 'contracted_volume_gwh_year', label: 'Contracted volume', kind: 'numeric', unit: 'GWh/year', min: 0, max: 5000 },
    { field: 'availability_guarantee_pct', label: 'Availability guarantee', kind: 'numeric', unit: '%', min: 50, max: 100, monitorable: true },
    { field: 'curtailment_compensation', label: 'Curtailment compensation', kind: 'text' },
    { field: 'settlement_period', label: 'Settlement period', kind: 'text' },
  ],
  MODULE_WARRANTY: [
    { field: 'initial_capacity_pct', label: 'Initial capacity', kind: 'numeric', unit: '%', min: 90, max: 100, monitorable: true },
    { field: 'year1_degradation_pct', label: 'First-year degradation', kind: 'numeric', unit: '%', min: 0, max: 5, monitorable: true },
    { field: 'annual_degradation_pct', label: 'Annual degradation', kind: 'numeric', unit: '%/year', min: 0, max: 2, monitorable: true },
    { field: 'end_capacity_pct', label: 'End-of-warranty capacity', kind: 'numeric', unit: '%', min: 70, max: 95 },
    { field: 'performance_warranty_years', label: 'Performance warranty', kind: 'numeric', unit: 'years', min: 10, max: 40 },
    { field: 'product_warranty_years', label: 'Product warranty', kind: 'numeric', unit: 'years', min: 5, max: 25 },
  ],
  INVERTER_WARRANTY: [
    { field: 'warranty_years', label: 'Warranty period', kind: 'numeric', unit: 'years', min: 2, max: 25 },
    { field: 'extended_option_years', label: 'Extension option', kind: 'numeric', unit: 'years', min: 0, max: 20 },
    { field: 'response_time_hours', label: 'Service response time', kind: 'numeric', unit: 'hours', min: 1, max: 720 },
    { field: 'replacement_terms', label: 'Replacement terms', kind: 'text' },
  ],
  OM_SLA: [
    { field: 'response_hours_critical', label: 'Response time (critical)', kind: 'numeric', unit: 'hours', min: 0.5, max: 336, monitorable: true },
    { field: 'response_hours_high', label: 'Response time (high)', kind: 'numeric', unit: 'hours', min: 0.5, max: 336, monitorable: true },
    { field: 'response_hours_medium', label: 'Response time (medium)', kind: 'numeric', unit: 'hours', min: 0.5, max: 336, monitorable: true },
    { field: 'response_hours_low', label: 'Response time (low)', kind: 'numeric', unit: 'hours', min: 0.5, max: 336, monitorable: true },
    { field: 'resolution_hours_critical', label: 'Resolution time (critical)', kind: 'numeric', unit: 'hours', min: 1, max: 720, monitorable: true },
    { field: 'resolution_hours_high', label: 'Resolution time (high)', kind: 'numeric', unit: 'hours', min: 1, max: 720, monitorable: true },
    { field: 'guaranteed_availability_pct', label: 'Guaranteed availability', kind: 'numeric', unit: '%', min: 80, max: 100, monitorable: true },
    { field: 'cleaning_cadence_per_year', label: 'Cleaning cadence', kind: 'numeric', unit: 'per year', min: 0, max: 12 },
    { field: 'reporting_cadence', label: 'Reporting cadence', kind: 'text' },
    { field: 'penalty_terms', label: 'Penalty terms', kind: 'text' },
  ],
  // Mirror of nuravolt/llm/warranty_extractor.py WARRANTY_FIELDS (same bounds).
  BESS_WARRANTY: [
    { field: 'soh_eol_threshold_pct', label: 'Capacity guarantee', kind: 'numeric', unit: '%', min: 50, max: 90, monitorable: true },
    { field: 'cycle_count_warranty', label: 'Warranted cycles', kind: 'numeric', unit: 'cycles', min: 1000, max: 20000, monitorable: true },
    { field: 'warranty_years', label: 'Warranty period', kind: 'numeric', unit: 'years', min: 2, max: 25 },
    { field: 'min_rte_pct', label: 'Round-trip efficiency floor', kind: 'numeric', unit: '%', min: 70, max: 98 },
    { field: 'max_temp_dwell_c', label: 'Max operating temperature', kind: 'numeric', unit: 'C', min: 25, max: 60 },
    { field: 'max_c_rate_charge', label: 'Max charge C-rate', kind: 'numeric', unit: 'C', min: 0.1, max: 4 },
    { field: 'max_c_rate_discharge', label: 'Max discharge C-rate', kind: 'numeric', unit: 'C', min: 0.1, max: 4 },
    { field: 'max_throughput_mwh_per_year', label: 'Annual throughput cap', kind: 'numeric', unit: 'MWh/year', min: 10, max: 1000000 },
    { field: 'soc_high_dwell_hours', label: 'High-SoC dwell limit', kind: 'numeric', unit: 'hours/year', min: 1, max: 8760 },
    { field: 'soc_low_dwell_hours', label: 'Low-SoC dwell limit', kind: 'numeric', unit: 'hours/year', min: 1, max: 8760 },
  ],
  // Offtaker rents the asset's capacity and dispatches it. The availability
  // guarantee is the money term, so `availability_measurement_basis` records
  // the contract's own words for how availability is measured: our reading is
  // a sampled proxy and must never be presented as that measurement.
  BESS_TOLLING: [
    { field: 'tolling_fee_per_mw_month', label: 'Tolling fee', kind: 'numeric', unit: 'per MW/month', min: 0, max: 200000 },
    { field: 'currency', label: 'Currency', kind: 'text' },
    { field: 'guaranteed_availability_pct', label: 'Guaranteed availability', kind: 'numeric', unit: '%', min: 80, max: 100, monitorable: true },
    { field: 'availability_measurement_basis', label: 'Availability measurement basis', kind: 'text' },
    { field: 'declared_power_mw', label: 'Declared power', kind: 'numeric', unit: 'MW', min: 0.05, max: 2000 },
    { field: 'declared_duration_h', label: 'Declared duration', kind: 'numeric', unit: 'hours', min: 0.25, max: 24 },
    { field: 'min_rte_pct', label: 'Round-trip efficiency floor', kind: 'numeric', unit: '%', min: 70, max: 98, monitorable: true },
    { field: 'max_cycles_per_year', label: 'Annual cycle cap', kind: 'numeric', unit: 'cycles/year', min: 1, max: 1000, monitorable: true },
    { field: 'unavailability_liquidated_damages', label: 'Unavailability liquidated damages', kind: 'text' },
  ],
  // Availability payment for holding derated capacity (e.g. GB CM). Satisfactory
  // performance is determined by the EMR settlement body from submissions we do
  // not receive; the monitored term buys the operator an indicative view only.
  BESS_CAPACITY_MARKET: [
    { field: 'cmu_id', label: 'CMU identifier', kind: 'text' },
    { field: 'derated_capacity_mw', label: 'Derated capacity', kind: 'numeric', unit: 'MW', min: 0.01, max: 2000 },
    { field: 'clearing_price_per_kw_year', label: 'Clearing price', kind: 'numeric', unit: 'per kW/year', min: 0, max: 200 },
    { field: 'currency', label: 'Currency', kind: 'text' },
    { field: 'delivery_year_start', label: 'Delivery year start', kind: 'numeric', unit: 'year', min: 2000, max: 2060 },
    { field: 'agreement_years', label: 'Agreement length', kind: 'numeric', unit: 'years', min: 1, max: 20 },
    { field: 'satisfactory_performance_days', label: 'Satisfactory performance days', kind: 'numeric', unit: 'days', min: 1, max: 365, monitorable: true },
  ],
  // Frequency response / reserve service agreement. We can monitor availability
  // to respond. Verifying response delivery needs 1-second data that no OEM
  // cloud provides, so no delivery term is monitorable here by design.
  BESS_ANCILLARY: [
    { field: 'service', label: 'Service', kind: 'text' },
    { field: 'contracted_mw', label: 'Contracted power', kind: 'numeric', unit: 'MW', min: 0.01, max: 2000 },
    { field: 'efa_blocks', label: 'EFA blocks', kind: 'text' },
    { field: 'availability_fee_per_mw_hour', label: 'Availability fee', kind: 'numeric', unit: 'per MW/h', min: 0, max: 1000 },
    { field: 'currency', label: 'Currency', kind: 'text' },
    { field: 'response_availability_pct', label: 'Response availability', kind: 'numeric', unit: '%', min: 80, max: 100, monitorable: true },
  ],
  OTHER: [],
};

export function termFieldDef(type: ContractType, field: string): TermFieldDef | null {
  return CONTRACT_TERM_FIELDS[type]?.find((d) => d.field === field) ?? null;
}

/** Clamp/validate a candidate numeric value against the field bounds. */
export function isWithinBounds(def: TermFieldDef, value: number): boolean {
  if (def.kind !== 'numeric' || !Number.isFinite(value)) return false;
  if (def.min != null && value < def.min) return false;
  if (def.max != null && value > def.max) return false;
  return true;
}
