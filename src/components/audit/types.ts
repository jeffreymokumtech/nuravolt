/**
 * Types for the NuraVolt Audit product surface (specimen data bundles under
 * `${dataRoot}/audit/<plantId>/`). Shapes mirror the JSON produced by the
 * audit engagement pipeline: an optimizer performance audit and a warranty
 * and degradation dossier.
 */

// ---------------------------------------------------------------------------
// optimizer_audit.json
// ---------------------------------------------------------------------------

export interface OptimizerAuditSummary {
  asset_name: string;
  capacity_kwh: number;
  max_power_kw: number;
  round_trip_efficiency: number;
  degradation_cost_per_kwh?: number;
  price_source: string;
  zone: string;
  days_analyzed: number;
  days_skipped: number;
  realized_net_eur: number;
  optimal_net_eur: number;
  revenue_gap_eur: number;
  capture_ratio: number;
  annualized_gap_eur: number;
  realized_efc_total: number;
  optimal_efc_total: number;
  soc_ledger_mismatch_mean_abs_kwh: number;
}

export interface OptimizerAuditDay {
  day: string;
  status: string;
  realized_net_eur: number;
  optimal_net_eur: number;
  capture_ratio: number | null;
  realized_efc: number;
  optimal_efc: number;
  realized_spread_eur_mwh: number | null;
  optimal_spread_eur_mwh: number | null;
  realized_top_quartile_share: number | null;
  optimal_top_quartile_share: number | null;
  coverage: number;
  soc_ledger_mismatch_kwh: number | null;
}

export interface OptimizerSampleDay {
  day: string;
  timestamps: string[];
  price_eur_mwh: number[];
  realized_net_kw: number[];
  optimal_net_kw: number[];
  realized_soc_kwh: number[];
  optimal_soc_kwh: number[];
  gap_eur: number;
}

export interface OptimizerAudit {
  summary: OptimizerAuditSummary;
  daily: OptimizerAuditDay[];
  sample_days: {
    largest_gap: OptimizerSampleDay;
    median_gap: OptimizerSampleDay;
  };
}

// ---------------------------------------------------------------------------
// warranty_dossier.json
// ---------------------------------------------------------------------------

export interface WarrantyDossierAsset {
  asset_id: string;
  name: string;
  chemistry: string;
  nominal_capacity_kwh: number;
  nominal_power_kw: number;
  manufacturer: string | null;
  model: string | null;
  installation_date: string;
}

export interface WarrantyTerms {
  capacity_guarantee_pct: number;
  warranty_years: number;
  max_cycles: number;
  max_throughput_mwh: number | null;
  min_rte: number;
  operating_temp_max_c: number;
  max_c_rate_continuous: number;
}

export interface WarrantyHealthScore {
  score: number;
  risk_level: string;
  component_scores: Record<string, number>;
  current_soh: number;
  soh_margin: number;
  cycles_used: number;
  cycles_remaining: number;
  years_remaining: number;
  risk_factors: string[];
  recommendation: string;
}

export interface WarrantyViolation {
  type: string;
  severity: string;
  started_at: string;
  ended_at: string;
  duration_minutes: number;
  measured_value: number;
  threshold_value: number;
  unit: string;
  description: string;
}

export interface WarrantyCyclingDay {
  date: string;
  equivalent_cycles: number;
  energy_in_kwh: number;
  energy_out_kwh: number;
  avg_dod: number;
  avg_c_rate: number;
  round_trip_efficiency: number;
}

export interface WarrantyCycling {
  total_equivalent_cycles: number;
  total_throughput_mwh: number;
  avg_round_trip_efficiency: number;
  daily: WarrantyCyclingDay[];
  rainflow_histogram: { dod_bin: string; cycles: number }[];
}

export interface WarrantySohTrajectory {
  points: { date: string; soh: number }[];
  warranty_threshold: number;
  projected_threshold_crossing: string | null;
  capacity_tests: {
    date: string;
    measured_capacity_kwh: number;
    soh: number;
    test_type: string;
  }[];
  assumptions: {
    cycles_per_year: number;
    avg_temp_c: number;
    avg_dod: number;
  };
}

export interface WarrantyEvidence {
  telemetry_profile: {
    rows: number;
    start: string;
    end: string;
    median_interval_seconds: number;
    gap_count: number;
    coverage: number;
  };
  source_files: string[];
  methodology: string;
}

export interface WarrantyDossier {
  report_type?: string;
  generated_at?: string;
  asset: WarrantyDossierAsset;
  warranty_terms: WarrantyTerms;
  health_score: WarrantyHealthScore;
  violations: WarrantyViolation[];
  cycling: WarrantyCycling;
  soh_trajectory: WarrantySohTrajectory;
  evidence: WarrantyEvidence;
}
