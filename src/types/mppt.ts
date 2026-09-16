// String-level data within an MPPT
export interface StringData {
  stringId: string;
  moduleCount: number;
  voltage_V: number;
  current_A: number;
  power_kW: number;
  status: 'normal' | 'degraded' | 'open_circuit' | 'shorted' | 'offline';
  degradation_pct: number;
}

// MPPT snapshot data for one inverter
export interface MpptData {
  mpptId: string;
  voltage_V: number;
  current_A: number;
  power_kW: number;
  status: 'normal' | 'warning' | 'fault' | 'offline';
  strings: StringData[];
}

// Full inverter MPPT snapshot
export interface InverterMpptSnapshot {
  inverterId: string;
  groupId: string;
  model: string;
  nominalPower_kW: number;
  timestamp: string;
  mppts: MpptData[];
  summary: {
    totalPower_kW: number;
    avgVoltage_V: number;
    healthyStrings: number;
    totalStrings: number;
    overallStatus: 'healthy' | 'degraded' | 'faulted';
  };
}

// Timeseries for MPPT charts
export interface MpptTimeseriesPoint {
  timestamp: string;
  mpptId: string;
  voltage_V: number;
  current_A: number;
  power_kW: number;
}

// Timeseries for string charts
export interface StringTimeseriesPoint {
  timestamp: string;
  stringId: string;
  mpptId: string;
  voltage_V: number;
  current_A: number;
}

// Top-level file structure for mppt_string_data.json
export interface PlantMpptData {
  plantId: string;
  generatedAt: string;
  inverterModel: string;
  mpptCount: number;
  stringsPerMppt: number;
  inverters: Record<string, InverterMpptSnapshot>;
}

// Top-level file structure for mppt_timeseries.json
export interface MpptTimeseries {
  plantId: string;
  generatedAt: string;
  timeRange: { start: string; end: string };
  resolution: string;
  inverters: Record<string, {
    mpptSeries: MpptTimeseriesPoint[];
    stringSeries: StringTimeseriesPoint[];
  }>;
}
